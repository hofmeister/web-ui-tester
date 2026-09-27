#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, parsePort } from './config.ts';
import { startHttpServer } from './http.ts';
import { buildServer } from './server.ts';
import { SessionManager } from './session.ts';

const VERSION = '0.1.0';

const USAGE = `web-ui-tester ${VERSION} — MCP server for fast AI-driven web UI testing

Usage:
  web-ui-tester [options]

Options:
  --port <n>            Serve MCP over streamable HTTP instead of stdio.
                        Browser sessions then survive client reconnects.
  --host <addr>         Interface to bind in HTTP mode (default 127.0.0.1).
  --headless            Run browsers headless (default).
  --no-headless         Run browsers headed.
  --idle-timeout <ms>   Close sessions unused for this long (default 1800000).
  --cdp-url <url>       Attach to a running Chrome over CDP instead of launching
                        one (e.g. http://127.0.0.1:9222).
  --cdp-port <n>        Expose launched browsers' DevTools protocol on this
                        local port (0 = any free port) for other CDP clients.
  --version, -v         Print version.
  --help, -h            Print this help.

Environment:
  WUT_MODEL             Embedded-agent model, "provider:modelId"
                        (default google:gemini-flash-lite-latest).
  GOOGLE_GENERATIVE_AI_API_KEY / ANTHROPIC_API_KEY
                        API key for the selected provider.
  WUT_USER_AGENT        Default User-Agent for new sessions (default AITester/1.0).
  WUT_EXECUTABLE_PATH   Explicit Chromium binary.
  WUT_CDP_URL / WUT_CDP_PORT
                        Same as --cdp-url / --cdp-port.
  WUT_DEVTOOLS          Give sessions chrome-devtools-mcp's tools by default.

See README.md for the full environment-variable table.
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      headless: { type: 'boolean' },
      'no-headless': { type: 'boolean' },
      'idle-timeout': { type: 'string' },
      'cdp-url': { type: 'string' },
      'cdp-port': { type: 'string' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const config = loadConfig();
  if (values['no-headless']) config.headless = false;
  else if (values.headless) config.headless = true;
  if (values['idle-timeout']) {
    const parsed = Number(values['idle-timeout']);
    if (Number.isFinite(parsed) && parsed > 0) config.idleTimeoutMs = parsed;
  }

  if (values['cdp-url']) config.cdpUrl = values['cdp-url'];
  if (values['cdp-port'] !== undefined) {
    const parsed = parsePort(values['cdp-port']);
    if (parsed === undefined) {
      process.stderr.write(`Invalid --cdp-port "${values['cdp-port']}".\n`);
      process.exit(2);
    }
    config.cdpPort = parsed;
  }

  const sessions = new SessionManager(config);
  let closeHttp: (() => Promise<void>) | undefined;

  let shuttingDown = false;
  const shutdown = async (code = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (closeHttp) await closeHttp().catch(() => {});
    await sessions.shutdown().catch(() => {});
    process.exit(code);
  };

  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));

  if (values.port) {
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      process.stderr.write(`Invalid --port "${values.port}".\n`);
      process.exit(2);
    }
    const handle = await startHttpServer(sessions, config, {
      port,
      host: values.host ?? '127.0.0.1',
    });
    closeHttp = handle.close;
    return;
  }

  const server = buildServer(sessions, config);
  await server.connect(new StdioServerTransport());
  // The client owning our stdin has gone away; nothing can reach us anymore.
  process.stdin.on('close', () => void shutdown(0));
}

main().catch((error: Error) => {
  process.stderr.write(`[web-ui-tester] fatal: ${error.stack ?? error.message}\n`);
  process.exit(1);
});
