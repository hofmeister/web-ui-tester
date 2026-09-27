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
    await cdpLeg(fixture);
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

  // WebSockets never fire request/response events, so they are captured
  // separately; without that the whole data flow of a socket app is invisible.
  const sockets = await call(client, 'browser_network', { sessionId, filter: '/socket' });
  check('network log lists the WebSocket', /WS 101 .*websocket/.test(sockets.text), sockets.text);
  check('WebSocket line reports frame counts', /1 sent\/1 received/.test(sockets.text), sockets.text);

  const socketId = /#(\d+)/.exec(sockets.text)?.[1];
  const frames = await call(client, 'browser_request_detail', {
    sessionId,
    id: Number(socketId),
    part: 'frames',
  });
  check('frames show the sent payload', frames.text.includes('-> fixture: ping'), frames.text);
  check('frames show the echoed reply', frames.text.includes('<- echo: fixture: ping'), frames.text);

  const failedSocket = await call(client, 'browser_network', { sessionId, filter: '/nope' });
  check(
    'a WebSocket that cannot connect is reported as failed',
    /WS FAILED\(.*\)/.test(failedSocket.text),
    failedSocket.text,
  );

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

  // A dialog blocks the page until answered; the click that opened it used to
  // be the thing that failed, with an error blaming the element.
  const alertClick = await call(client, 'browser_click', { sessionId, css: '#alert-btn' });
  check(
    'a dialog-triggering click explains itself',
    /dialog/i.test(alertClick.text),
    alertClick.text.slice(0, 300),
  );
  const stillAlive = await call(client, 'browser_snapshot', { sessionId });
  check(
    'session recovers after a dialog',
    !stillAlive.isError && /\[ref=[a-z0-9]+\]/.test(stillAlive.text),
    stillAlive.text.slice(0, 200),
  );

  // A dialog blocks the page, so the action that opens one cannot answer it.
  // Arming the answer beforehand is the only way to accept a confirm().
  const armed = await call(client, 'browser_handle_dialog', { sessionId, accept: true });
  check('handle_dialog arms when no dialog is open', /next one will be accepted/.test(armed.text), armed.text);
  await call(client, 'browser_click', { sessionId, css: '#confirm-btn' });
  const confirmed = await call(client, 'browser_read_text', { sessionId, css: '#confirmed' });
  check('an armed accept answers the confirm', confirmed.text.includes('confirmed yes'), confirmed.text);

  // Without arming, a confirm() is dismissed rather than stalling the click.
  await call(client, 'browser_click', { sessionId, css: '#confirm-btn' });
  const dismissed = await call(client, 'browser_read_text', { sessionId, css: '#confirmed' });
  check('an unarmed confirm is dismissed', dismissed.text.includes('confirmed no'), dismissed.text);

  // ensurePage used to re-attach listeners, duplicating every console entry.
  await call(client, 'browser_console', { sessionId, sinceLastCall: true });
  await call(client, 'browser_evaluate', { sessionId, expression: 'console.log("once-only"); 1' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const once = await call(client, 'browser_console', { sessionId, sinceLastCall: true, limit: 200 });
  const occurrences = (once.text.match(/once-only/g) ?? []).length;
  check('console entries are not duplicated', occurrences === 1, `${occurrences}x: ${once.text}`);

  // Paged output used to be clipped twice, cutting off its own paging note.
  const page1 = await call(client, 'browser_snapshot', { sessionId, maxChars: 600 });
  const nextOffset = /Pass offset=(\d+)/.exec(page1.text)?.[1];
  check('a clipped snapshot keeps its paging note', Boolean(nextOffset), page1.text.slice(-200));
  if (nextOffset) {
    const page2 = await call(client, 'browser_snapshot', {
      sessionId,
      maxChars: 600,
      offset: Number(nextOffset),
    });
    check(
      'the next page continues where the first stopped',
      page2.text.includes(`showing chars ${nextOffset}-`),
      page2.text.slice(-200),
    );
  }

  // A scoped snapshot narrows Playwright's aria-ref registry, so refs reported
  // for earlier matches used to stop resolving.
  const multiQuery = await call(client, 'browser_query', { sessionId, role: 'button' });
  const allRefs = [...multiQuery.text.matchAll(/ref=([a-z0-9]+)/gi)].map((m) => m[1]);
  check('query found both buttons', allRefs.length >= 2, multiQuery.text);
  if (allRefs.length >= 2) {
    const inspectFirst = await call(client, 'browser_inspect_element', {
      sessionId,
      ref: allRefs[0],
    });
    check(
      'the first query ref still resolves after later matches',
      !inspectFirst.isError,
      inspectFirst.text.slice(0, 200),
    );
  }

  // A scoped browser_snapshot must not break refs outside its subtree either.
  await call(client, 'browser_snapshot', { sessionId, css: '#signup' });
  const outsideRef = allRefs[allRefs.length - 1];
  if (outsideRef) {
    const afterScoped = await call(client, 'browser_inspect_element', {
      sessionId,
      ref: outsideRef,
    });
    check(
      'refs survive a scoped snapshot',
      !afterScoped.isError,
      afterScoped.text.slice(0, 200),
    );
  }

  // An IIFE is already a call; treating it as a function literal called it twice.
  const iife = await call(client, 'browser_evaluate', {
    sessionId,
    expression: '(() => document.querySelectorAll("input").length)()',
  });
  check('an IIFE is not called twice', iife.text.trim() === '3', iife.text);

  // console.log arrives as type "log", which the info filter used to miss.
  await call(client, 'browser_console', { sessionId, level: 'info', sinceLastCall: true });
  await call(client, 'browser_evaluate', { sessionId, expression: 'console.log("info-line"); 1' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const infoLevel = await call(client, 'browser_console', {
    sessionId,
    level: 'info',
    sinceLastCall: true,
  });
  check('info level includes console.log', infoLevel.text.includes('info-line'), infoLevel.text);

  // Clearing a filtered read used to wipe unread entries of other levels.
  await call(client, 'browser_evaluate', {
    sessionId,
    expression: 'console.warn("keep-me"); console.error("clear-me"); 1',
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await call(client, 'browser_console', { sessionId, level: 'error', clear: true, sinceLastCall: false });
  const survived = await call(client, 'browser_console', {
    sessionId,
    level: 'warning',
    sinceLastCall: false,
  });
  check('a filtered clear keeps other levels', survived.text.includes('keep-me'), survived.text);

  // An endless expression used to hang the tool call forever.
  const hang = await call(client, 'browser_evaluate', {
    sessionId,
    expression: 'new Promise(() => {})',
  });
  check('a non-terminating evaluate times out', hang.isError, hang.text.slice(0, 200));

  // locator.evaluate's timeout only bounds resolving the selector, not the
  // expression, so the scoped branch needs its own bound.
  const hangScoped = await call(client, 'browser_evaluate', {
    sessionId,
    css: '#name',
    expression: 'el => new Promise(() => {})',
  });
  check(
    'a non-terminating scoped evaluate times out',
    hangScoped.isError,
    hangScoped.text.slice(0, 200),
  );

  // clear:true used to delete entries the same response reported as unread.
  await call(client, 'browser_console', { sessionId, level: 'error', sinceLastCall: true });
  await call(client, 'browser_evaluate', {
    sessionId,
    expression: 'for (let i = 0; i < 5; i++) console.error("bulk-" + i); 1',
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const firstBatch = await call(client, 'browser_console', {
    sessionId,
    level: 'error',
    limit: 2,
    clear: true,
    sinceLastCall: true,
  });
  check('a limited read reports the remainder', /more unread/.test(firstBatch.text), firstBatch.text);
  const secondBatch = await call(client, 'browser_console', {
    sessionId,
    level: 'error',
    sinceLastCall: true,
  });
  check(
    'clear keeps entries it reported as unread',
    secondBatch.text.includes('bulk-'),
    secondBatch.text,
  );

  // A statement body without an explicit return used to yield undefined.
  const implicitReturn = await call(client, 'browser_evaluate', {
    sessionId,
    expression: "const rows = document.querySelectorAll('input'); rows.length",
  });
  check(
    'the last statement is the value',
    implicitReturn.text.trim() === '3',
    implicitReturn.text,
  );

  // A trailing semicolon used to break the expression form, yielding undefined.
  const semi = await call(client, 'browser_evaluate', {
    sessionId,
    expression: 'document.title;',
  });
  check('a trailing semicolon still returns a value', semi.text.includes('Fixture'), semi.text);

  // The empty-result branch of a filtered clear used to wipe the whole buffer.
  await call(client, 'browser_evaluate', { sessionId, expression: 'console.warn("survivor"); 1' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await call(client, 'browser_console', {
    sessionId,
    level: 'error',
    clear: true,
    sinceLastCall: true,
  });
  const stillThere = await call(client, 'browser_console', {
    sessionId,
    level: 'warning',
    sinceLastCall: false,
  });
  check(
    'clearing an empty filtered read spares other levels',
    stillThere.text.includes('survivor'),
    stillThere.text,
  );

  // A beforeunload guard used to make a page unnavigable: the prompt was held,
  // then dismissed, and dismissing beforeunload means "stay here".
  await call(client, 'browser_navigate', { sessionId, url: '/guarded.html' });
  // Chrome only raises the prompt after genuine interaction; without this click
  // the test would pass whether or not the bug is present.
  await call(client, 'browser_click', { sessionId, css: '#interact' });
  const started = Date.now();
  const leaving = await call(client, 'browser_navigate', { sessionId, url: '/app.html' });
  check(
    'a beforeunload guard does not block navigation',
    !leaving.isError && leaving.text.includes('/app.html'),
    leaving.text.slice(0, 200),
  );
  check(
    'leaving a guarded page is not stalled',
    Date.now() - started < 5000,
    `took ${Date.now() - started}ms`,
  );

  // "(1+2)*4" was misread as a function literal and called.
  const parenExpr = await call(client, 'browser_evaluate', {
    sessionId,
    expression: '(1+2)*4',
  });
  check('a parenthesised expression is not called', parenExpr.text.trim() === '12', parenExpr.text);

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

    // A stale connection id must get the actionable error, not an opaque one.
    const stale = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': 'no-such-connection',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const staleBody = await stale.json();
    check(
      'a stale connection id is reported clearly',
      staleBody.error === 'invalid_session' && /browser sessions outlive/.test(staleBody.message),
      JSON.stringify(staleBody),
    );

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

function stdioClient(name, env) {
  const client = new Client({ name, version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: { ...process.env, ...env },
    stderr: 'inherit',
  });
  return client.connect(transport).then(() => client);
}

async function cdpTabs(endpoint) {
  const response = await fetch(`${endpoint}/json/list`);
  return (await response.json()).filter((target) => target.type === 'page');
}

async function cdpLeg(fixture) {
  section('CDP: expose and attach');
  // The exposing server owns the browser; the attaching one drives it over CDP.
  const owner = await stdioClient('e2e-cdp-owner', { WUT_CDP_PORT: '0' });
  const start = await call(owner, 'browser_start', { url: `${fixture.origin}/app.html` });
  const endpoint = /cdpEndpoint: (\S+)/.exec(start.text)?.[1];
  check('browser_start reports the exposed cdpEndpoint', Boolean(endpoint), start.text);
  if (!endpoint) {
    await owner.close();
    return;
  }
  const version = await fetch(`${endpoint}/json/version`).then((r) => r.json()).catch(() => ({}));
  check('exposed endpoint speaks CDP', Boolean(version.webSocketDebuggerUrl), JSON.stringify(version));
  const listed = await call(owner, 'browser_list', {});
  check('browser_list shows the cdp endpoint', listed.text.includes(endpoint), listed.text);

  const guest = await stdioClient('e2e-cdp-guest', { WUT_CDP_URL: endpoint });
  const attached = await call(guest, 'browser_start', { url: `${fixture.origin}/app.html?cdp=1` });
  const guestId = /sessionId: (\S+)/.exec(attached.text)?.[1];
  check('attach over CDP opens a session', Boolean(guestId) && !attached.isError, attached.text);
  check('attach reports the browser profile', attached.text.includes("browser's own profile"), attached.text);
  const snap = await call(guest, 'browser_snapshot', { sessionId: guestId });
  check('attached session can snapshot', snap.text.includes('[ref='), snap.text.slice(0, 300));
  check(
    'the attached tab is visible over CDP',
    (await cdpTabs(endpoint)).some((tab) => tab.url.includes('cdp=1')),
  );

  const adopt = await call(guest, 'browser_start', { tab: 'cdp=1' });
  const adoptId = /sessionId: (\S+)/.exec(adopt.text)?.[1];
  check('tab: takes over an existing tab', Boolean(adoptId) && adopt.text.includes('existing tab'), adopt.text);
  await call(guest, 'browser_close', { sessionId: adoptId });
  check(
    'closing an adopted tab session leaves the tab open',
    (await cdpTabs(endpoint)).some((tab) => tab.url.includes('cdp=1')),
  );
  await call(guest, 'browser_close', { sessionId: guestId });
  check(
    'closing the session closes the tab it opened',
    !(await cdpTabs(endpoint)).some((tab) => tab.url.includes('cdp=1')),
  );

  const missing = await call(guest, 'browser_start', { tab: 'no-such-tab' });
  check('unknown tab is a clear error', missing.isError && missing.text.includes('Open tabs'), missing.text);

  const isolated = await call(guest, 'browser_start', { useBrowserProfile: false });
  check('isolated context over CDP', isolated.text.includes('isolated context'), isolated.text);

  await guest.close();
  // The guest disconnecting must not take the owner's browser down with it.
  const still = await call(owner, 'browser_snapshot', { sessionId: /sessionId: (\S+)/.exec(start.text)?.[1] });
  check('owner browser survives the guest disconnecting', !still.isError, still.text.slice(0, 300));
  await owner.close();

  const bad = await stdioClient('e2e-cdp-bad', { WUT_CDP_URL: 'http://127.0.0.1:1' });
  const failed = await call(bad, 'browser_start', {});
  check('unreachable CDP endpoint explains itself', failed.isError && failed.text.includes('--remote-debugging-port'), failed.text);
  await bad.close();
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
