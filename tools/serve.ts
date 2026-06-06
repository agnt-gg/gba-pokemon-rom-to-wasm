/**
 * Minimal static file server for the web frontend. No deps.
 * Usage: node --experimental-strip-types tools/serve.ts --port 8077
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', 'web');
const portArg = process.argv.indexOf('--port');
const PORT = portArg >= 0 ? parseInt(process.argv[portArg + 1], 10) : 8077;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png', '.gba': 'application/octet-stream', '.map': 'application/json',
  '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
  try {
    let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';
    const filePath = normalize(join(ROOT, urlPath));
    if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
    const s = await stat(filePath).catch(() => null);
    if (!s || !s.isFile()) { res.writeHead(404); res.end('Not found'); return; }
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      // COOP/COEP let us use SharedArrayBuffer later (for a worker core) without breaking now.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    });
    res.end(body);
  } catch (e: any) {
    res.writeHead(500); res.end('Server error: ' + (e?.message || e));
  }
});

server.listen(PORT, () => {
  console.log(`gba-recomp frontend → http://localhost:${PORT}/`);
  console.log(`serving ${ROOT}`);
});
