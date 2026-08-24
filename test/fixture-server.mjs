import { createHash } from 'node:crypto';
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

  // A minimal RFC 6455 echo endpoint, so the WebSocket capture has a real
  // handshake and real frames to observe. Pulling in a ws library for two
  // frame shapes would not earn its dependency.
  server.on('upgrade', (req, socket) => {
    const accept = createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.on('error', () => {});
    socket.on('data', (frame) => {
      if ((frame[0] & 0x0f) !== 0x01) return; // text frames only
      const length = frame[1] & 0x7f;
      const start = length === 126 ? 4 : length === 127 ? 10 : 2;
      const mask = frame.subarray(start, start + 4);
      const payload = Buffer.from(frame.subarray(start + 4));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      const reply = Buffer.from(`echo: ${payload}`);
      socket.write(Buffer.concat([Buffer.from([0x81, reply.length]), reply]));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
