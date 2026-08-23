import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Config } from './config.js';
import { buildServer } from './server.js';
import type { SessionManager } from './session.js';

const MCP_PATH = '/mcp';

export interface HttpServerHandle {
  close: () => Promise<void>;
}

/**
 * Serves MCP over streamable HTTP. Each client connection gets its own
 * McpServer and transport (an McpServer binds to a single transport), but all
 * of them share one SessionManager — which is what lets browser sessions
 * outlive any individual client connection.
 */
export async function startHttpServer(
  sessions: SessionManager,
  config: Config,
  options: { port: number; host: string },
): Promise<HttpServerHandle> {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const loopbackOnly = ['127.0.0.1', 'localhost', '::1'].includes(options.host);

  const http = createServer((req, res) => {
    void handle(req, res).catch((error: Error) => {
      process.stderr.write(`[web-ui-tester] request error: ${error.message}\n`);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal_error', message: error.message }));
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          browserSessions: sessions.list().length,
          mcpConnections: transports.size,
        }),
      );
      return;
    }

    if (url.pathname !== MCP_PATH) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found', message: `Use ${MCP_PATH}` }));
      return;
    }

    const sessionId = req.headers['mcp-session-id'];
    const existing = typeof sessionId === 'string' ? transports.get(sessionId) : undefined;
    if (existing) {
      await existing.handleRequest(req, res);
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'invalid_session',
          message: 'Unknown or missing mcp-session-id; initialize with a POST first.',
        }),
      );
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, transport);
      },
      onsessionclosed: (id) => {
        transports.delete(id);
      },
      // Only meaningful for a loopback bind, where we know every legitimate
      // Host header. On a public bind the reachable hostnames are unknowable,
      // and an allowlist built from the bind address would reject real clients.
      ...(loopbackOnly
        ? {
            allowedHosts: [
              `${options.host}:${options.port}`,
              `localhost:${options.port}`,
              `127.0.0.1:${options.port}`,
              `[::1]:${options.port}`,
            ],
            enableDnsRebindingProtection: true,
          }
        : {}),
    });
    transport.onclose = () => {
      if (transport.sessionId) transports.delete(transport.sessionId);
    };

    // A fresh McpServer per connection; the browser sessions live outside it.
    const server = buildServer(sessions, config);
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port, options.host, () => {
      http.off('error', reject);
      resolve();
    });
  });

  process.stderr.write(
    `[web-ui-tester] listening on http://${options.host}:${options.port}${MCP_PATH}\n` +
      '[web-ui-tester] browser sessions persist across client reconnects in this mode\n' +
      (loopbackOnly
        ? ''
        : `[web-ui-tester] warning: bound to ${options.host}, so this server is reachable from ` +
          'the network with no authentication and DNS-rebinding protection off. It can drive a ' +
          'browser and run JavaScript — put it behind a proxy or firewall.\n'),
  );

  return {
    close: async () => {
      for (const transport of transports.values()) {
        await transport.close().catch(() => {});
      }
      transports.clear();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
