// Serves this folder's Pinglapp at http://localhost:8080 for trying things out (e.g. accounts against the staging
// project, which are on for localhost). Run: npm run serve   Stop: Ctrl+C
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PORT) || 8080;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

http.createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/[\\/]$/, '/index.html');
  if (path.includes('..') || /[\\/](tests|supabase|node_modules)[\\/]|[\\/]\./.test(path)) { res.writeHead(404); res.end(); return; }
  try { const body = await readFile(join(ROOT, path)); res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' }); res.end(body); }
  catch { res.writeHead(404); res.end(); }
}).listen(PORT, 'localhost', () => console.log(`Pinglapp: http://localhost:${PORT}/  (Ctrl+C stops it)`));
