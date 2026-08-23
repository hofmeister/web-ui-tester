import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateText, hasToolCall, stepCountIs, tool, type LanguageModel } from 'ai';
import { z } from 'zod';
import { parseModelSpec, type Config } from './config.js';
import * as ops from './ops.js';
import type { Session } from './session.js';
import { clip } from './snapshot.js';

/** Tool output inside the loop accumulates in context, so clip it harder. */
const AGENT_TOOL_CHARS = 6_000;
const AGENT_SNAPSHOT_CHARS = 8_000;

const SYSTEM_PROMPT = `You drive a live web browser to carry out UI tasks and report what you find.

How to work:
- The page is exposed as an accessibility tree. Every element has a ref like "e12"; pass that ref to click, type, hover, and select_option.
- Start from the snapshot you are given. Take a new snapshot after any navigation, form submission, or DOM change — refs from an older page state stop working.
- If an action reports that a ref was not found, do not retry it. Take a fresh snapshot and use the new ref.
- Prefer targeted tools over full snapshots: query finds elements by role/name/text, read_text reads rendered copy. Reach for a full snapshot only when you need to see the page structure.
- When something looks broken, check console and network before concluding. They usually name the real failure.
- Verify before you report. Read the resulting page rather than assuming an action worked.

Finish by calling done exactly once, with success set honestly and a summary of what you did and observed. Never invent page content you did not read.`;

export interface RunTaskResult {
  success: boolean | 'unknown';
  summary: string;
  findings: string[];
  steps: { tool: string; args: string; result: string }[];
  finalUrl: string;
  finalTitle: string;
  consoleErrors: number;
  totalTokens?: number;
  stoppedEarly: boolean;
  model: string;
}

function resolveModel(spec: string): { model: LanguageModel; label: string } {
  const { provider, modelId } = parseModelSpec(spec);
  if (provider === 'google') {
    if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
      throw new Error(
        'GOOGLE_GENERATIVE_AI_API_KEY is not set. Set it to use Gemini, or select ' +
          'Anthropic with WUT_MODEL=anthropic (needs ANTHROPIC_API_KEY), or pass ' +
          'model="anthropic:claude-haiku-4-5" to this call.',
      );
    }
    return {
      model: createGoogleGenerativeAI()(modelId),
      label: `google:${modelId}`,
    };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. Set it to use Anthropic, or select Gemini with ' +
        'WUT_MODEL=google (needs GOOGLE_GENERATIVE_AI_API_KEY).',
    );
  }
  return { model: createAnthropic()(modelId), label: `anthropic:${modelId}` };
}

/**
 * The same operations the MCP tools expose, bound to one session so the model
 * never has to carry a sessionId. Schemas stay flat — small fast models handle
 * unions and nesting poorly.
 */
function buildTools(session: Session) {
  const clipped = (body: string) => clip(body, AGENT_TOOL_CHARS).text;
  const targetShape = {
    ref: z.string().optional().describe('Element ref from a snapshot, e.g. "e12".'),
    css: z.string().optional().describe('CSS selector, if you have no ref.'),
  };
  const asTarget = (a: { ref?: string; css?: string }): ops.Target => ({ ref: a.ref, css: a.css });

  return {
    snapshot: tool({
      description:
        'Accessibility-tree snapshot of the page with [ref=eN] handles. Your main way to see the page.',
      inputSchema: z.object({
        interactiveOnly: z
          .boolean()
          .optional()
          .describe('Only actionable elements — cheaper on large pages.'),
        depth: z.number().int().optional().describe('Limit tree depth.'),
      }),
      // ops.snapshot already budgets to maxChars; clipping again here would cut
      // off its own truncation note.
      execute: async ({ interactiveOnly, depth }) =>
        ops.snapshot(session, { interactiveOnly, depth, maxChars: AGENT_SNAPSHOT_CHARS }),
    }),

    navigate: tool({
      description: 'Navigate to a URL. Returns the new page state and a fresh snapshot.',
      inputSchema: z.object({ url: z.string() }),
      execute: async ({ url }) => clipped(await ops.navigate(session, url)),
    }),

    click: tool({
      description: 'Click an element by ref (preferred) or css.',
      inputSchema: z.object(targetShape),
      execute: async (a) => clipped(await ops.click(session, asTarget(a))),
    }),

    type: tool({
      description: 'Type text into an input, replacing what is there. Set submit to press Enter.',
      inputSchema: z.object({
        ...targetShape,
        text: z.string(),
        submit: z.boolean().optional(),
      }),
      execute: async ({ text, submit, ...rest }) =>
        clipped(await ops.type(session, asTarget(rest), text, { submit })),
    }),

    press_key: tool({
      description: 'Press a key, e.g. "Enter", "Escape", "ArrowDown".',
      inputSchema: z.object({ ...targetShape, key: z.string() }),
      execute: async ({ key, ...rest }) => clipped(await ops.pressKey(session, key, asTarget(rest))),
    }),

    hover: tool({
      description: 'Hover an element to reveal menus or tooltips.',
      inputSchema: z.object(targetShape),
      execute: async (a) => clipped(await ops.hover(session, asTarget(a))),
    }),

    select_option: tool({
      description: 'Select options in a <select> element.',
      inputSchema: z.object({ ...targetShape, values: z.array(z.string()) }),
      execute: async ({ values, ...rest }) =>
        clipped(await ops.selectOption(session, asTarget(rest), values)),
    }),

    scroll: tool({
      description: 'Scroll an element into view, or scroll the page by dy pixels.',
      inputSchema: z.object({ ...targetShape, dy: z.number().optional() }),
      execute: async ({ dy, ...rest }) =>
        clipped(await ops.scroll(session, { target: asTarget(rest), dy })),
    }),

    wait_for: tool({
      description: 'Wait for text to appear or disappear, or for a CSS selector to become visible.',
      inputSchema: z.object({
        text: z.string().optional(),
        textGone: z.string().optional(),
        selector: z.string().optional(),
        timeoutMs: z.number().int().min(100).max(15_000).optional(),
      }),
      execute: async (a) => clipped(await ops.waitFor(session, a)),
    }),

    query: tool({
      description:
        'Find elements by role+name, visible text, or css. Returns refs and state — cheaper than a full snapshot.',
      inputSchema: z.object({
        role: z.string().optional(),
        name: z.string().optional(),
        text: z.string().optional(),
        css: z.string().optional(),
      }),
      execute: async (a) => clipped(await ops.query(session, a)),
    }),

    read_text: tool({
      description: 'Read the rendered text of the page, or of one element subtree.',
      inputSchema: z.object(targetShape),
      execute: async (a) =>
        clipped(await ops.readText(session, { target: asTarget(a), maxChars: AGENT_TOOL_CHARS })),
    }),

    console_log: tool({
      description: 'Read console messages and uncaught page errors. Check this when things look broken.',
      inputSchema: z.object({
        level: z.enum(['error', 'warning', 'info', 'all']).optional(),
      }),
      execute: async ({ level }) =>
        clipped(ops.consoleLog(session, { level: level ?? 'all', sinceLastCall: false })),
    }),

    network_log: tool({
      description: 'List network requests with status and duration. Use status "failed" to find problems.',
      inputSchema: z.object({
        filter: z.string().optional(),
        status: z.enum(['failed', '4xx', '5xx', 'all']).optional(),
      }),
      execute: async (a) => clipped(ops.networkLog(session, a)),
    }),

    evaluate: tool({
      description:
        'Run JavaScript in the page and get the JSON result. Use for state the accessibility tree hides.',
      inputSchema: z.object({ ...targetShape, expression: z.string() }),
      execute: async ({ expression, ...rest }) =>
        clipped(await ops.evaluate(session, expression, asTarget(rest), AGENT_TOOL_CHARS)),
    }),

    inspect_element: tool({
      description: 'Computed styles, box model, and attributes of one element. For layout problems.',
      inputSchema: z.object(targetShape),
      execute: async (a) => clipped(await ops.inspectElement(session, asTarget(a))),
    }),

    done: tool({
      description:
        'Call once when the task is complete or impossible. This ends the run.',
      inputSchema: z.object({
        success: z.boolean().describe('Did you accomplish the task?'),
        summary: z.string().describe('What you did and what you observed.'),
        findings: z
          .array(z.string())
          .optional()
          .describe('Notable issues: errors, broken behaviour, unexpected state.'),
      }),
      execute: async (input) => input,
    }),
  };
}

export async function runTask(
  session: Session,
  config: Config,
  options: { instruction: string; expectation?: string; maxSteps?: number; model?: string },
): Promise<RunTaskResult> {
  const spec = options.model ?? session.options.model ?? config.model;
  const { model, label } = resolveModel(spec);
  return driveSession(session, model, label, {
    instruction: options.instruction,
    expectation: options.expectation,
    maxSteps: options.maxSteps ?? config.agentMaxSteps,
  });
}

/** The agent loop itself, over an already-resolved model. */
export async function driveSession(
  session: Session,
  model: LanguageModel,
  label: string,
  options: { instruction: string; expectation?: string; maxSteps: number },
): Promise<RunTaskResult> {
  const maxSteps = options.maxSteps;
  const tools = buildTools(session);

  const marks = session.marks();
  const opening = await ops
    .snapshot(session, { maxChars: AGENT_SNAPSHOT_CHARS })
    .catch((error: Error) => `(snapshot unavailable: ${error.message})`);

  const prompt = [
    `Task: ${options.instruction}`,
    options.expectation ? `Success looks like: ${options.expectation}` : '',
    '',
    'Current page:',
    opening,
  ]
    .filter(Boolean)
    .join('\n');

  const result = await generateText({
    model,
    system: SYSTEM_PROMPT,
    prompt,
    tools,
    stopWhen: [stepCountIs(maxSteps), hasToolCall('done')],
  });

  // Pair by toolCallId, not position: an erroring call in a parallel batch
  // produces no result and would shift every later result onto the wrong call.
  const steps = result.steps.flatMap((step) =>
    step.toolCalls.map((call) => {
      const match = step.toolResults.find(
        (toolResult) => toolResult.toolCallId === call.toolCallId,
      );
      return {
        tool: call.toolName,
        args: digest(call.input),
        result: match ? digest(match.output) : '(no result)',
      };
    }),
  );

  const doneCall = result.steps
    .flatMap((step) => step.toolCalls)
    .find((call) => call.toolName === 'done');
  const done = doneCall?.input as
    | { success: boolean; summary: string; findings?: string[] }
    | undefined;

  const { url, title } = await ops.pageState(session);

  return {
    success: done ? done.success : 'unknown',
    summary: done?.summary || result.text.trim() || '(no summary produced)',
    findings: done?.findings ?? [],
    steps,
    finalUrl: url,
    finalTitle: title,
    consoleErrors: session.countConsoleErrorsSince(marks.console),
    totalTokens: result.totalUsage?.totalTokens,
    stoppedEarly: !done,
    model: label,
  };
}

function digest(value: unknown, max = 120): string {
  if (value === undefined || value === null) return '';
  const asText = typeof value === 'string' ? value : JSON.stringify(value);
  const oneLine = asText.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

export function formatRunResult(result: RunTaskResult): string {
  const lines = [
    `status: ${result.success === 'unknown' ? 'unknown (agent stopped without reporting)' : result.success ? 'success' : 'failed'}`,
    `model: ${result.model}`,
    '',
    result.summary,
  ];

  if (result.findings.length) {
    lines.push('', 'findings:', ...result.findings.map((f) => `  - ${f}`));
  }

  if (result.steps.length) {
    lines.push(
      '',
      `steps (${result.steps.length}):`,
      ...result.steps.map(
        (step, i) =>
          `  ${i + 1}. ${step.tool}(${step.args})${step.result ? ` -> ${step.result}` : ''}`,
      ),
    );
  }

  if (result.stoppedEarly) {
    lines.push(
      '',
      'The agent hit the step limit before finishing. Raise maxSteps, or split the task.',
    );
  }

  lines.push(
    '',
    `final url: ${result.finalUrl}`,
    `final title: ${result.finalTitle || '(untitled)'}`,
    `console errors during run: ${result.consoleErrors}`,
    result.totalTokens ? `tokens: ${result.totalTokens}` : '',
  );

  return lines.filter((line) => line !== undefined).join('\n');
}
