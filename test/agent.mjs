/**
 * Exercises the embedded agent loop against a scripted mock model, so the tool
 * bridge, stop conditions, and result formatting are verified without needing
 * provider credentials. A live model is only covered by test/e2e-agent.mjs.
 */
import { MockLanguageModelV4 } from 'ai/test';
import { driveSession, formatRunResult } from '../dist/agent.js';
import { SessionManager } from '../dist/session.js';
import { loadConfig } from '../dist/config.js';
import { z } from 'zod';
import { runTaskOutputSchema } from '../dist/tools/agent.js';
import { startFixtureServer } from './fixture-server.mjs';

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`);
  }
}

/** Replays a fixed sequence of tool calls, one per generate() invocation. */
function scriptedModel(script) {
  let turn = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => {
      const step = script[Math.min(turn++, script.length - 1)];
      // AI SDK 7 takes finishReason as an object, not a bare string.
      return {
        finishReason: step.toolName
          ? { unified: 'tool-calls', raw: 'tool_calls' }
          : { unified: 'stop', raw: 'stop' },
        // V4 usage nests per-category detail; the SDK flattens it for callers.
        usage: {
          inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 20, text: 20, reasoning: 0 },
          totalTokens: 120,
        },
        content: step.toolName
          ? [
              {
                type: 'tool-call',
                toolCallId: `call-${turn}`,
                toolName: step.toolName,
                input: JSON.stringify(step.input),
              },
            ]
          : [{ type: 'text', text: step.text ?? 'done' }],
        warnings: [],
      };
    },
  });
}

async function main() {
  const fixture = await startFixtureServer();
  const config = loadConfig();
  const sessions = new SessionManager(config);

  try {
    console.log('\nembedded agent loop (mock model)');

    const session = await sessions.create({
      userAgent: config.userAgent,
      viewport: { width: 1280, height: 720 },
      headless: true,
      baseUrl: fixture.origin,
    });
    // Navigating inside the run is what puts the fixture's seeded console error
    // and its 404 within the run's window; diagnostics from before it started
    // belong to whatever came earlier, not to this run.
    const result = await driveSession(session, scriptedModel([
      { toolName: 'navigate', input: { url: `${fixture.origin}/app.html` } },
      { toolName: 'query', input: { role: 'textbox', name: 'Name' } },
      { toolName: 'type', input: { css: '#name', text: 'Mock User', submit: false } },
      { toolName: 'click', input: { css: '#submit' } },
      {
        toolName: 'report_finding',
        input: {
          severity: 'warning',
          what: 'The confirmation text does not name the plan',
          where: '#result',
          evidence: 'Account created for Mock User',
        },
      },
      { toolName: 'read_text', input: { css: '#result' } },
      {
        toolName: 'done',
        input: { success: true, summary: 'Filled the signup form and submitted it.' },
      },
    ]), 'mock:test', { instruction: 'Fill in the form and submit it.', maxSteps: 10 });

    check('agent reports success', result.success === true, JSON.stringify(result.success));
    check('summary comes from the done call', result.summary.includes('Filled the signup form'), result.summary);

    const reported = result.findings.filter((f) => f.source === 'agent');
    check('agent findings are carried through', reported.length === 1, JSON.stringify(reported));
    check(
      'a finding keeps its severity, location and evidence',
      reported[0]?.severity === 'warning' &&
        reported[0]?.where === '#result' &&
        reported[0]?.evidence?.includes('Mock User'),
      JSON.stringify(reported[0]),
    );

    // The fixture seeds a console error and a 404 that the agent never mentions.
    const observed = result.findings.filter((f) => f.source === 'observed');
    check(
      'the harness reports the console error the agent ignored',
      observed.some((f) => f.evidence?.includes('seeded console error')),
      JSON.stringify(observed),
    );
    check(
      'the harness reports the failed request the agent ignored',
      observed.some((f) => f.what.includes('Request failed') && f.where?.includes('/api/missing')),
      JSON.stringify(observed),
    );
    check('observed findings are errors', observed.every((f) => f.severity === 'error' || f.severity === 'info'), JSON.stringify(observed));

    check('every tool call is logged', result.steps.length === 7, `${result.steps.length} steps`);
    check('did not stop early', result.stoppedEarly === false);
    check('token usage is reported', typeof result.totalTokens === 'number', String(result.totalTokens));

    // The tools must have actually driven the browser, not just been recorded.
    const value = await session.page.locator('#name').inputValue();
    check('agent tools really drove the page', value === 'Mock User', value);
    const resultText = await session.page.locator('#result').innerText();
    check('form submission took effect', resultText.includes('Mock User'), resultText);

    const formatted = formatRunResult(result);
    check('formatted output states status', formatted.includes('status: success'), formatted.slice(0, 200));
    check('formatted output lists steps', formatted.includes('steps (7)'), formatted.slice(0, 400));
    check(
      'formatted output leads with findings',
      formatted.indexOf('findings (') > 0 &&
        formatted.indexOf('findings (') < formatted.indexOf('steps ('),
      formatted.slice(0, 600),
    );
    check(
      'formatted output marks harness-observed findings',
      formatted.includes('[observed by the harness]'),
      formatted.slice(0, 800),
    );

    // run_task declares this as its outputSchema, and the MCP SDK rejects a
    // structuredContent that does not match — so a real result must validate.
    const parsed = z.object(runTaskOutputSchema).safeParse(result);
    check(
      'the result validates against the declared outputSchema',
      parsed.success,
      parsed.success ? '' : JSON.stringify(parsed.error.issues?.slice(0, 3)),
    );

    // A model that never calls done must be reported as stopped early.
    const session2 = await sessions.create({
      userAgent: config.userAgent,
      viewport: { width: 1280, height: 720 },
      headless: true,
    });
    const runaway = await driveSession(
      session2,
      scriptedModel([
        { toolName: 'navigate', input: { url: `${fixture.origin}/app.html` } },
        { toolName: 'snapshot', input: {} },
      ]),
      'mock:test',
      { instruction: 'Loop forever.', maxSteps: 3 },
    );
    check('step limit is enforced', runaway.steps.length === 3, `${runaway.steps.length} steps`);
    check(
      'a truncated run still reports what the harness saw',
      runaway.findings.some((f) => f.source === 'observed'),
      JSON.stringify(runaway.findings),
    );
    check('missing done is flagged', runaway.stoppedEarly === true);
    check('unknown success without done', runaway.success === 'unknown', String(runaway.success));
    check(
      'a stopped-early result also validates',
      z.object(runTaskOutputSchema).safeParse(runaway).success,
      JSON.stringify(runaway.success),
    );
    check(
      'formatted output warns about the step limit',
      formatRunResult(runaway).includes('step limit'),
    );

    // A failing tool call must be surfaced to the model, not thrown away.
    const session3 = await sessions.create({
      userAgent: config.userAgent,
      viewport: { width: 1280, height: 720 },
      headless: true,
    });
    await session3.page.goto(`${fixture.origin}/app.html`);
    const withError = await driveSession(session3, scriptedModel([
      { toolName: 'report_finding', input: { severity: 'error', what: 'The ref would not resolve' } },
      { toolName: 'click', input: { ref: 'e999' } },
      { toolName: 'done', input: { success: false, summary: 'The ref was stale.' } },
    ]), 'mock:test', { instruction: 'Click a bad ref.', maxSteps: 5 });
    check('run survives a failing tool call', withError.steps.length === 3, `${withError.steps.length} steps`);
    check('failure is reported honestly', withError.success === false, String(withError.success));
  } finally {
    await sessions.shutdown();
    await fixture.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
