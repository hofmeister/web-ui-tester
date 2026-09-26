import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { formatRunResult, runTask } from '../agent.ts';
import { register, sessionIdSchema, text, type ToolContext } from './shared.ts';

/**
 * Declared as the tool's output schema, so the calling model receives validated
 * structured findings rather than only prose. Exported so tests can prove a
 * real result validates against it — the MCP SDK rejects a mismatch at runtime.
 */
export const runTaskOutputSchema = {
  success: z
    .union([z.boolean(), z.literal('unknown')])
    .describe('Whether the task was accomplished; "unknown" if the agent never reported.'),
  summary: z.string().describe('What the agent did and observed.'),
  findings: z
    .array(
      z.object({
        severity: z.enum(['error', 'warning', 'info']),
        what: z.string(),
        where: z.string().optional(),
        evidence: z.string().optional(),
        source: z
          .enum(['agent', 'observed'])
          .describe('"observed" findings were recorded by the harness, not the agent.'),
      }),
    )
    .describe('Everything worth reporting from the run.'),
  steps: z.array(z.object({ tool: z.string(), args: z.string(), result: z.string() })),
  finalUrl: z.string(),
  finalTitle: z.string(),
  consoleErrors: z.number().describe('Console errors seen during the run.'),
  stoppedEarly: z.boolean().describe('True if the step limit was hit before finishing.'),
  model: z.string(),
  totalTokens: z.number().optional(),
};

export function registerAgentTools(server: McpServer, context: ToolContext): void {
  register(
    server,
    context,
    'run_task',
    {
      title: 'Run UI task',
      description:
        'Delegates a multi-step UI task to a fast built-in browser agent, which drives the ' +
        'session itself and reports back. Use it for goal-shaped work ("log in as ' +
        'demo@example.com and check the dashboard loads", "walk the checkout flow and report ' +
        'anything broken") rather than driving each click yourself.\n\n' +
        'Returns a structured report: a success flag, a summary, and findings — each with a ' +
        'severity, what is wrong, where, and the evidence observed. Findings come from two ' +
        'places: what the agent noticed, and what the harness itself recorded (console errors, ' +
        'failed requests, dialogs), so problems are reported even when the agent does not ' +
        'mention them or runs out of steps. The session is left on whatever page the agent ' +
        'ended on, so you can inspect it further with the browser_* tools.',
      inputSchema: {
        sessionId: sessionIdSchema,
        instruction: z.string().describe('What the agent should accomplish.'),
        expectation: z
          .string()
          .optional()
          .describe('What a successful outcome looks like, if it is worth stating.'),
        maxSteps: z
          .number()
          .int()
          .min(1)
          .max(60)
          .optional()
          .describe('Step budget for the agent loop (default 20).'),
        model: z
          .string()
          .optional()
          .describe(
            'Override the model for this call, as "provider:modelId" — e.g. ' +
              '"google:gemini-flash-lite-latest" or "anthropic:claude-haiku-4-5".',
          ),
      },
      outputSchema: runTaskOutputSchema,
    },
    async (args) => {
      const a = args as unknown as {
        sessionId: string;
        instruction: string;
        expectation?: string;
        maxSteps?: number;
        model?: string;
      };
      const session = context.sessions.get(a.sessionId);
      const result = await runTask(session, context.config, {
        instruction: a.instruction,
        expectation: a.expectation,
        maxSteps: a.maxSteps,
        model: a.model,
      });
      return {
        ...text(formatRunResult(result)),
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );
}
