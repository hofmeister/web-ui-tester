import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startFixtureServer } from './fixture-server.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(root, 'dist', 'index.js');

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

function section(title) {
  console.log(`\n${title}`);
}

/** Tool results are content blocks; flatten the text for assertions. */
function textOf(result) {
  return (result.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  return { text: textOf(result), isError: result.isError === true, raw: result };
}

async function main() {
  const fixture = await startFixtureServer();
  console.log(`fixture server: ${fixture.origin}`);

  try {
    await stdioLeg(fixture);
    await httpLeg(fixture);
    await idleLeg(fixture);
  } finally {
    await fixture.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

async function stdioLeg(fixture) {
  section('stdio transport');
  const client = new Client({ name: 'e2e', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: { ...process.env },
    stderr: 'inherit',
  });
  await client.connect(transport);

  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();
  const expected = [
    'browser_click',
    'browser_close',
    'browser_console',
    'browser_evaluate',
    'browser_go_back',
    'browser_handle_dialog',
    'browser_hover',
    'browser_inspect_element',
    'browser_list',
    'browser_navigate',
    'browser_network',
    'browser_press_key',
    'browser_query',
    'browser_read_text',
    'browser_request_detail',
    'browser_screenshot',
    'browser_scroll',
    'browser_select_option',
    'browser_snapshot',
    'browser_start',
    'browser_type',
    'browser_wait_for',
    'run_task',
  ];
  const missing = expected.filter((name) => !names.includes(name));
  check('all tools registered', missing.length === 0, `missing: ${missing.join(', ')}`);

  const start = await call(client, 'browser_start', { baseUrl: fixture.origin });
  const sessionId = /sessionId: (\S+)/.exec(start.text)?.[1];
  check('browser_start returns a sessionId', Boolean(sessionId), start.text);
  check('default user agent is AITester/1.0', start.text.includes('AITester/1.0'), start.text);

  // Verify the UA actually reaches the wire, not just the config echo.
  await call(client, 'browser_navigate', { sessionId, url: '/echo-ua' });
  const uaBody = await call(client, 'browser_read_text', { sessionId });
  check('server sees AITester/1.0', uaBody.text.includes('AITester/1.0'), uaBody.text);

  const nav = await call(client, 'browser_navigate', { sessionId, url: '/app.html' });
  check('relative URL resolves against baseUrl', nav.text.includes('/app.html'), nav.text);
  check('navigate returns refs', /\[ref=[a-z0-9]+\]/.test(nav.text), nav.text.slice(0, 400));

  const snap = await call(client, 'browser_snapshot', { sessionId });
  check('snapshot shows the form', /textbox/.test(snap.text), snap.text.slice(0, 400));

  const interactive = await call(client, 'browser_snapshot', {
    sessionId,
    interactiveOnly: true,
  });
  check(
    'interactiveOnly keeps actionable elements',
    /button "Create account"/.test(interactive.text) && /textbox "Name"/.test(interactive.text),
    interactive.text.slice(0, 500),
  );
  check(
    'interactiveOnly drops non-actionable content',
    !/heading "Signup"/.test(interactive.text),
    interactive.text.slice(0, 500),
  );

  const query = await call(client, 'browser_query', { sessionId, role: 'textbox', name: 'Name' });
  const nameRef = /ref=([a-z0-9]+)/i.exec(query.text)?.[1];
  check('query returns a usable ref', Boolean(nameRef), query.text);

  const typed = await call(client, 'browser_type', {
    sessionId,
    ref: nameRef,
    text: 'Jane Tester',
  });
  check('type succeeds via query ref', !typed.isError, typed.text);

  const submitQuery = await call(client, 'browser_query', { sessionId, role: 'button' });
  const submitRef = /ref=([a-z0-9]+)/i.exec(submitQuery.text)?.[1];
  const clicked = await call(client, 'browser_click', { sessionId, ref: submitRef });
  check('click submit succeeds', !clicked.isError, clicked.text);

  const after = await call(client, 'browser_read_text', { sessionId });
  check(
    'DOM updated after submit',
    after.text.includes('Account created for Jane Tester'),
    after.text.slice(0, 300),
  );

  const select = await call(client, 'browser_select_option', {
    sessionId,
    css: '#plan',
    values: ['pro'],
  });
  check('select_option works', select.text.includes('pro'), select.text);

  const consoleOut = await call(client, 'browser_console', {
    sessionId,
    level: 'error',
    sinceLastCall: false,
  });
  check(
    'console surfaces the seeded error',
    consoleOut.text.includes('seeded console error'),
    consoleOut.text,
  );

  const network = await call(client, 'browser_network', { sessionId, status: 'failed' });
  check('network log shows the 404', /404/.test(network.text), network.text);

  const okRequest = await call(client, 'browser_network', { sessionId, filter: '/api/ok' });
  const requestId = /#(\d+)/.exec(okRequest.text)?.[1];
  const detail = await call(client, 'browser_request_detail', {
    sessionId,
    id: Number(requestId),
    part: 'responseBody',
  });
  check(
    'request_detail returns the cached JSON body',
    detail.text.includes('"status": "ok"') || detail.text.includes('"status":"ok"'),
    detail.text,
  );

  const timing = await call(client, 'browser_request_detail', {
    sessionId,
    id: Number(requestId),
  });
  check('request_detail summary has timing', timing.text.includes('timing:'), timing.text);

  const evaluated = await call(client, 'browser_evaluate', {
    sessionId,
    expression: 'document.querySelectorAll("input").length',
  });
  check('evaluate runs a bare expression', evaluated.text.trim() === '3', evaluated.text);

  const scopedEval = await call(client, 'browser_evaluate', {
    sessionId,
    css: '#name',
    expression: 'el => el.value',
  });
  check('evaluate binds el for a target', scopedEval.text.includes('Jane Tester'), scopedEval.text);

  const multi = await call(client, 'browser_evaluate', {
    sessionId,
    expression: 'const inputs = document.querySelectorAll("input"); return inputs.length * 2;',
  });
  check('evaluate accepts a multi-statement body', multi.text.trim() === '6', multi.text);

  const awaited = await call(client, 'browser_evaluate', {
    sessionId,
    expression: 'await Promise.resolve(document.title)',
  });
  check('evaluate supports await', awaited.text.includes('Fixture'), awaited.text);

  const badExpr = await call(client, 'browser_evaluate', {
    sessionId,
    expression: 'this is not javascript(((',
  });
  check('evaluate reports a syntax error clearly', badExpr.isError, badExpr.text);

  const inspected = await call(client, 'browser_inspect_element', { sessionId, css: '#secret' });
  check(
    'inspect_element reports display:none',
    inspected.text.includes('display: none'),
    inspected.text,
  );

  // Stale refs must tell the caller to re-snapshot rather than just time out.
  const preNav = await call(client, 'browser_snapshot', { sessionId });
  const staleRef = /\[ref=([a-z0-9]+)\]/.exec(preNav.text)?.[1];
  check('captured a ref to go stale', Boolean(staleRef), preNav.text.slice(0, 200));
  await call(client, 'browser_navigate', { sessionId, url: '/second.html' });
  const stale = await call(client, 'browser_click', { sessionId, ref: staleRef });
  check(
    'stale ref produces a re-snapshot hint',
    stale.isError && /browser_snapshot/.test(stale.text),
    stale.text,
  );

  const back = await call(client, 'browser_go_back', { sessionId });
  check('go_back returns fresh refs', /\[ref=[a-z0-9]+\]/.test(back.text), back.text.slice(0, 200));

  const badSession = await call(client, 'browser_snapshot', { sessionId: 'nope' });
  check('unknown session is a clean error', badSession.isError, badSession.text);

  await regressionChecks(client, fixture, sessionId);

  await call(client, 'browser_close', { sessionId });
  const listed = await call(client, 'browser_list', {});
  check('closed session is gone', listed.text.includes('No open sessions'), listed.text);

  await client.close();
}

/** Regressions for defects found in review; each one was reproducible. */
async function regressionChecks(client, fixture, sessionId) {
  section('regressions');

  // A closed popup used to leave the session pointing at a dead page.
  await call(client, 'browser_navigate', { sessionId, url: '/app.html' });
  await call(client, 'browser_evaluate', {
    sessionId,
    expression: 'const w = window.open("/second.html"); w.close(); "opened"',
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const afterPopup = await call(client, 'browser_snapshot', { sessionId });
  check(
    'session survives a popup that closes itself',
    !afterPopup.isError && /\[ref=[a-z0-9]+\]/.test(afterPopup.text),
    afterPopup.text.slice(0, 300),
  );

  // A level filter used to consume unread entries of other levels.
  await call(client, 'browser_console', { sessionId, sinceLastCall: true });
  await call(client, 'browser_evaluate', {
    sessionId,
    expression: 'console.warn("regression-warning"); console.error("regression-error"); 1',
  });
  // Console events arrive over CDP a beat after evaluate resolves.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const errorsOnly = await call(client, 'browser_console', {
    sessionId,
    level: 'error',
    sinceLastCall: true,
  });
  check(
    'level-filtered read returns the error',
    errorsOnly.text.includes('regression-error'),
    errorsOnly.text,
  );
  const warningsAfter = await call(client, 'browser_console', {
    sessionId,
    level: 'warning',
    sinceLastCall: true,
  });
  check(
    'level filter does not consume other levels',
    warningsAfter.text.includes('regression-warning'),
    warningsAfter.text,
  );

  // browser_start used to strand the context when the first navigation failed.
  const badStart = await call(client, 'browser_start', {
    url: 'http://127.0.0.1:1/nothing-here',
  });
  const strandedId = /sessionId: (\S+)/.exec(badStart.text)?.[1];
  check(
    'failed opening navigation still yields a sessionId',
    Boolean(strandedId) && /failed/i.test(badStart.text),
    badStart.text,
  );
  if (strandedId) {
    const usable = await call(client, 'browser_navigate', {
      sessionId: strandedId,
      url: `${fixture.origin}/app.html`,
    });
    check('that session is still usable', !usable.isError, usable.text.slice(0, 200));
    await call(client, 'browser_close', { sessionId: strandedId });
  }
}

async function httpLeg(fixture) {
  section('http transport (session persistence across reconnects)');
  const port = 7399;
  const child = spawn(process.execPath, [entry, '--port', String(port)], {
    env: { ...process.env },
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  try {
    await waitForHealth(`http://127.0.0.1:${port}/health`);

    const first = new Client({ name: 'e2e-http-1', version: '1.0.0' });
    await first.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));

    const start = await call(first, 'browser_start', {
      baseUrl: fixture.origin,
      url: '/app.html',
    });
    const sessionId = /sessionId: (\S+)/.exec(start.text)?.[1];
    check('http: session started', Boolean(sessionId), start.text);

    await call(first, 'browser_type', { sessionId, css: '#name', text: 'Persisted User' });

    // Drop the client entirely — a new one gets a different MCP session.
    await first.close();

    const second = new Client({ name: 'e2e-http-2', version: '1.0.0' });
    await second.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));

    const listed = await call(second, 'browser_list', {});
    check('browser session survived reconnect', listed.text.includes(sessionId), listed.text);

    const value = await call(second, 'browser_evaluate', {
      sessionId,
      css: '#name',
      expression: 'el => el.value',
    });
    check(
      'page state survived reconnect',
      value.text.includes('Persisted User'),
      value.text,
    );

    await call(second, 'browser_close', { sessionId });
    await second.close();
  } finally {
    child.kill('SIGTERM');
  }
}

async function idleLeg(fixture) {
  section('idle timeout');
  const client = new Client({ name: 'e2e-idle', version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: { ...process.env, WUT_IDLE_TIMEOUT_MS: '1000' },
      stderr: 'inherit',
    }),
  );

  const start = await call(client, 'browser_start', { url: `${fixture.origin}/app.html` });
  const sessionId = /sessionId: (\S+)/.exec(start.text)?.[1];
  check('idle: session started', Boolean(sessionId), start.text);

  // The reaper runs on a 30s tick, so wait past one full cycle.
  await new Promise((resolve) => setTimeout(resolve, 33_000));
  const listed = await call(client, 'browser_list', {});
  check('idle session was reaped', listed.text.includes('No open sessions'), listed.text);

  await client.close();
}

async function waitForHealth(url, attempts = 50) {
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // server still booting
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`health check never passed: ${url}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
