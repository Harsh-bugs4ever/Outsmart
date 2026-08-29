#!/usr/bin/env node
/**
 * Serves the Outsmart queue board and proxies the harness API.
 *
 * The harness sends no CORS headers, so a page on another origin cannot call
 * it from the browser. Serving the board and proxying /api through one origin
 * avoids that without loosening anything on the harness itself - which matters,
 * because the harness has no authentication of its own.
 *
 * Usage:  node ui/server.mjs [--port 8791] [--harness http://localhost:8790]
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PORT = Number(arg('port', process.env.PORT ?? 8791));
const HARNESS = (arg('harness', process.env.HARNESS_URL ?? 'http://localhost:8790')).replace(/\/$/, '');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

async function serveStatic(req, res) {
  const requested = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  // Contain path traversal: join+normalize, then reject anything resolving
  // outside this directory.
  const path = join(HERE, normalize(requested));
  if (!path.startsWith(HERE)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}

async function proxy(req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;

  try {
    const upstream = await fetch(`${HARNESS}${req.url}`, {
      method: req.method,
      headers: { 'content-type': req.headers['content-type'] ?? 'application/json' },
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
    res.end(text);
  } catch (error) {
    // The harness being down is the common case here, and it should read as
    // such on the board rather than as an empty queue.
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `harness unreachable at ${HARNESS}: ${error.message}` } }));
  }
}

createServer((req, res) => {
  if (req.url.startsWith('/api/')) return proxy(req, res);
  return serveStatic(req, res);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Outsmart queue board  http://localhost:${PORT}`);
  console.log(`proxying /api -> ${HARNESS}`);
});
