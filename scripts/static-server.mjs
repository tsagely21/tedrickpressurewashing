// Tiny static file server for previewing dist/ locally. Applies the same security headers as the _headers file.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, extname, normalize, sep } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

function globalHeaders(dir) {
  const file = join(dir, '_headers');
  const headers = {};
  if (!existsSync(file)) return headers;
  let inGlobal = false;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.startsWith(' ') && line.trim()) inGlobal = line.trim() === '/*';
    else if (inGlobal && line.includes(':')) headers[line.slice(0, line.indexOf(':')).trim()] = line.slice(line.indexOf(':') + 1).trim();
  }
  return headers;
}

/** Returns an async (req, res) => boolean handler that serves files from dir (true when it handled the request). */
export function staticHandler(dir) {
  const headers = globalHeaders(dir);
  return async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = normalize(join(dir, rel));
    if (!file.startsWith(dir + sep)) { res.writeHead(403); res.end('Forbidden'); return true; }
    try {
      if ((await stat(file)).isDirectory()) { res.writeHead(301, { Location: url.pathname + '/' }); res.end(); return true; }
      res.writeHead(200, { ...headers, 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(await readFile(file));
    } catch {
      const page = join(dir, '404.html');
      res.writeHead(404, { ...headers, 'Content-Type': existsSync(page) ? MIME['.html'] : 'text/plain' });
      res.end(existsSync(page) ? readFileSync(page) : 'Not found');
    }
    return true;
  };
}

export function serve(dir, port) {
  const handler = staticHandler(dir);
  return createServer((req, res) => handler(req, res)).listen(port);
}
