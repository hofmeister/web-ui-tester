/**
 * Exercises the embedded agent loop against a scripted mock model, so the tool
 * bridge, stop conditions, and result formatting are verified without needing
 * provider credentials. A live model is only covered by test/e2e-agent.mjs.
 */
import { MockLanguageModelV4 } from 'ai/test';
import { driveSession, formatRunResult } from '../dist/agent.js';
import { SessionManager } from '../dist/session.js';
import { loadConfig } from '../dist/config.js';
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
    await session.page.goto(`${fixture.origin}/app.html`);

    // A realistic run: look at the page, fill the form, submit, then report.
    const result = await driveSession(session, scriptedModel([
      { toolName: 'query', input: { role: 'textbox', name: 'Name' } },
      { toolName: 'type', input: { css: '#name', text: 'Mock User', submit: false } },
      { toolName: 'click', input: { css: '#submit' } },
      { toolName: 'read_text', input: { css: '#result' } },
      {
        toolName: 'done',
        input: {
          success: true,
          summary: 'Filled the signup form and submitted it.',
          findings: ['A seeded console error is present on load.'],
        },
      },
    ]), 'mock:test', { instruction: 'Fill in the form and submit it.', maxSteps: 10 });

    check('agent reports success', result.success === true, JSON.stringify(result.success));
    check('summary comes from the done call', result.summary.includes('Filled the signup form'), result.summary);
    check('findings are carried through', result.findings.length === 1, JSON.stringify(result.findings));
    check('every tool call is logged', result.steps.length === 5, `${result.steps.length} steps`);
    check('did not stop early', result.stoppedEarly === false);
    check('token usage is reported', typeof result.totalTokens === 'number', String(result.totalTokens));

    // The tools must have actually driven the browser, not just been recorded.
    const value = await session.page.locator('#name').inputValue();
    check('agent tools really drove the page', value === 'Mock User', value);
    const resultText = await session.page.locator('#result').innerText();
    check('form submission took effect', resultText.includes('Mock User'), resultText);

    const formatted = formatRunResult(result);
    check('formatted output states status', formatted.includes('status: success'), formatted.slice(0, 200));
    check('formatted output lists steps', formatted.includes('steps (5)'), formatted.slice(0, 300));

    // A model that never calls done must be reported as stopped early.
    const session2 = await sessions.create({
      userAgent: config.userAgent,
      viewport: { width: 1280, height: 720 },
      headless: true,
    });
    await session2.page.goto(`${fixture.origin}/app.html`);
    const runaway = await driveSession(
      session2,
      scriptedModel([{ toolName: 'snapshot', input: {} }]),
      'mock:test',
      { instruction: 'Loop forever.', maxSteps: 3 },
    );
    check('step limit is enforced', runaway.steps.length === 3, `${runaway.steps.length} steps`);
    check('missing done is flagged', runaway.stoppedEarly === true);
    check('unknown success without done', runaway.success === 'unknown', String(runaway.success));
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
      { toolName: 'click', input: { ref: 'e999' } },
      { toolName: 'done', input: { success: false, summary: 'The ref was stale.' } },
    ]), 'mock:test', { instruction: 'Click a bad ref.', maxSteps: 5 });
    check('run survives a failing tool call', withError.steps.length === 2, `${withError.steps.length} steps`);
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
