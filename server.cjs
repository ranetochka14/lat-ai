'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream');

const ROOT = fs.realpathSync(__dirname);
const HOST = '127.0.0.1';
const PORT = Number(process.env?.LAT_FRONTEND_PORT || 5173);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('Invalid LAT_FRONTEND_PORT');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8'
};

function insideRoot(candidate) {
  const relative = path.relative(ROOT, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

// I02: only public frontend assets are served. AI data, runtime secrets and
// Windows short-name aliases must fail both before and after realpath.
function publicAssetPath(candidate) {
  const relative = path.relative(ROOT, candidate).toLowerCase();
  return relative === '' || relative === 'index.html' || relative.split(path.sep)[0] === 'assets';
}

function respond(req, res, code, message, headers = {}) {
  const body = Buffer.from(message + '\n', 'utf8');
  res.writeHead(code, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    respond(req, res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
    return;
  }

  try {
    // Decode the raw path before resolving it so encoded traversal is checked too.
    let pathname = decodeURIComponent((req.url || '/').split('?')[0]);
    pathname = pathname.replace(/\\/g, '/');
    if (!pathname.startsWith('/') || pathname.includes('\0')) {
      respond(req, res, 400, 'Bad request');
      return;
    }
    if (pathname.split('/').some(segment => segment.startsWith('.') && segment !== '.' && segment !== '..')) {
      respond(req, res, 403, 'Forbidden');
      return;
    }

    let filename = path.resolve(ROOT, '.' + pathname);
    if (!insideRoot(filename) || !publicAssetPath(filename)) {
      respond(req, res, 403, 'Forbidden');
      return;
    }
    let stat = await fs.promises.stat(filename);
    if (stat.isDirectory()) filename = path.join(filename, 'index.html');

    // Check the actual target as well: a symlink must not expose another folder.
    filename = await fs.promises.realpath(filename);
    if (!insideRoot(filename) || !publicAssetPath(filename)) {
      respond(req, res, 403, 'Forbidden');
      return;
    }
    stat = await fs.promises.stat(filename);
    const mime = MIME[path.extname(filename).toLowerCase()];
    if (!stat.isFile() || !mime) {
      respond(req, res, 404, 'Not found');
      return;
    }

    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store'
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    pipeline(fs.createReadStream(filename), res, error => {
      if (error && !res.destroyed) res.destroy(error);
    });
  } catch (error) {
    if (error instanceof URIError) respond(req, res, 400, 'Bad request');
    else if (error.code === 'ENOENT' || error.code === 'ENOTDIR') respond(req, res, 404, 'Not found');
    else if (error.code === 'EACCES' || error.code === 'EPERM') respond(req, res, 403, 'Forbidden');
    else {
      console.error('Static server error:', error.message);
      if (!res.headersSent) respond(req, res, 500, 'Server error');
      else res.destroy();
    }
  }
});

server.on('error', error => {
  console.error(error.code === 'EADDRINUSE'
    ? `Port ${PORT} is already in use. Choose another port; existing service was not stopped.`
    : 'Cannot start local server: ' + error.message);
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  console.log(`LAT AI ready at http://${HOST}:${PORT}`);
  console.log('Press Ctrl+C to stop.');
});

process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
