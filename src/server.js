// Localhost server: serves the search page and a small JSON API.
//   GET  /api/prices?name=&set=&number=&grade=   recent sold prices from every source
//   POST /api/identify                           card photo -> { name, set, number }  (stage 2, returns 501 for now)

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookupPrices } from './prices.js';
import { identifyCard } from './identify.js';

const PORT = Number(process.env.PORT) || 3000;
// Localhost only on your machine; on Render (which sets RENDER) listen on all interfaces so its proxy can reach us.
const HOST = process.env.HOST ?? (process.env.RENDER ? '0.0.0.0' : '127.0.0.1');
const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req, maxBytes = 10 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('Upload too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function serveStatic(res, pathname) {
  const file = normalize(join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 404, { error: 'Not found' });
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/prices') {
      const name = url.searchParams.get('name')?.trim();
      if (!name) return sendJson(res, 400, { error: 'Enter a card name.' });
      const result = await lookupPrices({
        name,
        set: url.searchParams.get('set') ?? '',
        number: url.searchParams.get('number') ?? '',
        grade: url.searchParams.get('grade') ?? '',
      });
      return sendJson(res, 200, result);
    }
    if (req.method === 'POST' && url.pathname === '/api/identify') {
      const image = await readBody(req);
      const card = await identifyCard(image, req.headers['content-type']);
      return sendJson(res, 200, card);
    }
    if (req.method === 'GET') return serveStatic(res, url.pathname);
    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    sendJson(res, err.status ?? 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Pokemon price lookup running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
});
