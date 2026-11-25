import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const distDir = resolve(process.cwd(), 'dist');
const port = Number(process.env.E2E_PORT || 4173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

function parseHeaders(raw) {
  const rules = [];
  let current = null;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (!line.startsWith(' ') && !line.startsWith('\t')) {
      current = { pattern: trimmed, headers: [] };
      rules.push(current);
    } else if (current) {
      const idx = trimmed.indexOf(':');
      if (idx > 0) {
        current.headers.push([trimmed.slice(0, idx).trim(), trimmed.slice(idx + 1).trim()]);
      }
    }
  }
  return rules;
}

function matchPattern(pattern, pathname) {
  if (pattern === '/*') return true;
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -1);
    return pathname === prefix.slice(0, -1) || pathname.startsWith(prefix);
  }
  return pathname === pattern;
}

const headerRules = existsSync(join(distDir, '_headers'))
  ? parseHeaders(readFileSync(join(distDir, '_headers'), 'utf8'))
  : [];

const server = createServer((req, res) => {
  const reqUrl = new URL(req.url || '/', `http://127.0.0.1:${port}`);
  let pathname = decodeURIComponent(reqUrl.pathname);

  let filePath = join(distDir, pathname === '/' ? 'index.html' : pathname);
  if (existsSync(filePath) && statSync(filePath).isDirectory()) {
    filePath = join(filePath, 'index.html');
  }

  if (!existsSync(filePath) && pathname.startsWith('/app')) {
    filePath = join(distDir, 'app/index.html');
  }

  if (!existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  const outHeaders = {
    'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
  };
  for (const rule of headerRules) {
    if (matchPattern(rule.pattern, pathname)) {
      for (const [k, v] of rule.headers) {
        outHeaders[k] = v;
      }
    }
  }

  res.writeHead(200, outHeaders);
  res.end(readFileSync(filePath));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Static server listening on http://127.0.0.1:${port}`);
});
