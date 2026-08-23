import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixture');

/** Static fixture host plus a few endpoints the diagnostics tests need. */
export async function startFixtureServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/api/ok') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', items: [1, 2, 3] }));
      return;
    }
    if (url.pathname === '/api/missing') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    if (url.pathname === '/echo-ua') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ userAgent: req.headers['user-agent'] ?? null }));
      return;
    }

    const name = url.pathname === '/' ? '/app.html' : url.pathname;
    const target = join(fixtures, name);
    if (!target.startsWith(fixtures)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('forbidden');
      return;
    }
    try {
      const body = await readFile(target);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
