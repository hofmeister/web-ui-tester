/**
 * Live smoke test for run_task against a real provider. Skips itself unless a
 * provider key is present, so it is safe to run in any environment.
 *
 *   GOOGLE_GENERATIVE_AI_API_KEY=... node test/e2e-agent.mjs
 *   WUT_MODEL=anthropic ANTHROPIC_API_KEY=... node test/e2e-agent.mjs
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startFixtureServer } from './fixture-server.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(root, 'dist', 'index.js');

const hasGoogle = Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY);
const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY);

if (!hasGoogle && !hasAnthropic) {
  console.log(
    'SKIP live agent test: set GOOGLE_GENERATIVE_AI_API_KEY or ANTHROPIC_API_KEY to run it.\n' +
      '(The agent loop itself is covered without credentials by test/agent.mjs.)',
  );
  process.exit(0);
}

function textOf(result) {
  return (result.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

async function main() {
  const fixture = await startFixtureServer();
  const client = new Client({ name: 'e2e-agent', version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: { ...process.env },
      stderr: 'inherit',
    }),
  );

  let failed = 0;
  const check = (label, condition, detail = '') => {
    console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${condition || !detail ? '' : `\n       ${detail}`}`);
    if (!condition) failed++;
  };

  try {
    const start = textOf(
      await client.callTool({
        name: 'browser_start',
        arguments: { baseUrl: fixture.origin, url: '/app.html' },
      }),
    );
    const sessionId = /sessionId: (\S+)/.exec(start)?.[1];

    const model = hasGoogle ? undefined : 'anthropic:claude-haiku-4-5';
    console.log(`\nlive agent (${model ?? process.env.WUT_MODEL ?? 'google default'})`);

    const run = await client.callTool({
      name: 'run_task',
      arguments: {
        sessionId,
        instruction:
          'Fill the signup form with the name "Ada Lovelace", submit it, and report the ' +
          'confirmation message that appears.',
        expectation: 'The page shows a confirmation naming Ada Lovelace.',
        maxSteps: 12,
        ...(model ? { model } : {}),
      },
    });
    const body = textOf(run);
    console.log(body);

    check('run_task did not error', run.isError !== true, body);
    check('agent reported success', /^status: success/m.test(body), body.slice(0, 200));
    check('agent read the confirmation', /Ada Lovelace/.test(body), body.slice(0, 400));

    // The agent's work must be visible in the live session afterwards.
    const value = textOf(
      await client.callTool({
        name: 'browser_evaluate',
        arguments: { sessionId, css: '#result', expression: 'el => el.textContent' },
      }),
    );
    check('session shows the agent\'s changes', value.includes('Ada Lovelace'), value);

    await client.callTool({ name: 'browser_close', arguments: { sessionId } });
  } finally {
    await client.close();
    await fixture.close();
  }

  console.log(failed ? `\n${failed} failed` : '\nall live agent checks passed');
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
