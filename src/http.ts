import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Config } from './config.ts';
import { buildServer } from './server.ts';
import type { SessionManager } from './session.ts';

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
  interface Connection {
    transport: StreamableHTTPServerTransport;
    server: McpServer;
    lastSeen: number;
  }
  const transports = new Map<string, Connection>();
  const loopbackOnly = ['127.0.0.1', 'localhost', '::1'].includes(options.host);

  // MCP clients commonly disconnect without sending DELETE, so an idle sweep is
  // what actually reclaims a connection's transport and McpServer. Browser
  // sessions live in the SessionManager and are deliberately untouched by this.
  //
  // lastSeen only advances on requests, and a client can hold an open stream
  // for a long time without making one, so the window stays comfortably longer
  // than a browser session's own idle timeout — reclaiming a connection early
  // would break a client that is still there.
  const connectionIdleMs = Math.max(config.idleTimeoutMs * 2, 60 * 60 * 1000);
  const sweeper = setInterval(() => {
    for (const [id, connection] of transports) {
      if (Date.now() - connection.lastSeen > connectionIdleMs) {
        transports.delete(id);
        // Closes the transport too, and releases the McpServer with it.
        void connection.server.close().catch(() => {});
      }
    }
  }, 60_000);
  sweeper.unref?.();

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
      existing.lastSeen = Date.now();
      await existing.transport.handleRequest(req, res);
      return;
    }

    // A POST carrying an unknown id is a stale client, not a new connection:
    // building a server for it would fail initialization and abandon both.
    if (req.method !== 'POST' || typeof sessionId === 'string') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'invalid_session',
          message: sessionId
            ? `Unknown mcp-session-id "${sessionId}"; the connection has expired. ` +
              'Initialize a new one, then reuse your browser sessionId — browser ' +
              'sessions outlive client connections.'
            : 'Missing mcp-session-id; initialize with a POST first.',
        }),
      );
      return;
    }

    // A fresh McpServer per connection; the browser sessions live outside it.
    const server = buildServer(sessions, config);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, { transport, server, lastSeen: Date.now() });
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
      clearInterval(sweeper);
      for (const connection of transports.values()) {
        await connection.server.close().catch(() => {});
      }
      transports.clear();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
