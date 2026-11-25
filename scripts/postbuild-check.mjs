import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const distDir = resolve(process.cwd(), 'dist');
const maxBytes = 25 * 1024 * 1024;
const anonKey = process.env.VITE_SUPABASE_ANON_KEY || '';
const errors = [];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

if (!existsSync(distDir)) {
  console.error('Release gate failed: dist/ does not exist');
  process.exit(1);
}

for (const req of ['_headers', '_redirects', 'robots.txt', 'sitemap.xml']) {
  if (!existsSync(join(distDir, req))) {
    errors.push(`Missing required file in dist/: ${req}`);
  }
}

const headersPath = join(distDir, '_headers');
if (existsSync(headersPath)) {
  const headersText = readFileSync(headersPath, 'utf8');
  const lines = headersText.split(/\r?\n/);
  let currentPath = '';
  const cspByPath = new Map();

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (!raw.startsWith(' ') && !raw.startsWith('\t')) {
      currentPath = line;
    } else if (line.toLowerCase().startsWith('content-security-policy:')) {
      cspByPath.set(currentPath, line);
    }
  }

  if (cspByPath.has('/*')) {
    errors.push('CSP must not be set on /* in _headers (set per path instead)');
  }
  if (!cspByPath.has('/')) {
    errors.push('Missing Content-Security-Policy for / in _headers');
  }
  if (!cspByPath.has('/app/*')) {
    errors.push('Missing Content-Security-Policy for /app/* in _headers');
  }
}

const files = walk(distDir);
const jwtPattern = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const secretPatterns = [
  { name: 'service_role', re: /service_role/ },
  { name: 'sk- key', re: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { name: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

for (const file of files) {
  const rel = file.slice(distDir.length + 1).replace(/\\/g, '/');
  const size = statSync(file).size;
  if (size > maxBytes) {
    errors.push(`File exceeds 25 MiB: ${rel} (${size} bytes)`);
  }
  if (file.endsWith('.map')) {
    errors.push(`Source map found in dist/: ${rel}`);
  }

  const ext = extname(file).toLowerCase();
  if (['.html', '.js', '.mjs', '.css', '.json', '.txt'].includes(ext)) {
    const content = readFileSync(file, 'utf8');
    for (const pat of secretPatterns) {
      if (pat.re.test(content)) {
        errors.push(`Secret pattern (${pat.name}) found in dist/${rel}`);
      }
    }
    const jwts = content.match(jwtPattern) || [];
    for (const jwt of jwts) {
      if (!anonKey || jwt !== anonKey) {
        errors.push(`Unexpected JWT found in dist/${rel}`);
      }
    }
    if (ext === '.html') {
      const inlineScript = /<script(?![^>]*\bsrc=)(?![^>]*\btype=["']application\/ld\+json["'])[^>]*>/i;
      if (inlineScript.test(content)) {
        errors.push(`Inline <script> without src found in dist/${rel}`);
      }
    }
  }
}

if (errors.length > 0) {
  console.error('Release gate failed:');
  for (const e of errors) console.error(` - ${e}`);
  process.exit(1);
}

console.log(`Release gate passed (${files.length} files checked).`);
