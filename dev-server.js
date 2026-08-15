const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 8000;
const HOST = 'localhost';
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

const PUBLIC_ROOT_FILE = /^[a-z0-9._-]+\.(?:html|css|js|png|jpg|jpeg|svg|ico)$/i;
const PUBLIC_TEMPLATE_FILE = /^templates\/(?:accounting-template\.xlsx|activity-cover-template\.docx|invigilation-template\.xlsx)$/i;
const CONTENT_SECURITY_POLICY = "default-src 'self' https://accounts.google.com https://cdn.jsdelivr.net https://www.gstatic.com https://fonts.googleapis.com https://fonts.gstatic.com; img-src 'self' data: https://www.gstatic.com https://*.googleusercontent.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://accounts.google.com https://cdn.jsdelivr.net; connect-src 'self' https://script.google.com https://script.googleusercontent.com https://cdn.jsdelivr.net; frame-ancestors 'none';";

function resolvePublicFile(requestUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.parse(requestUrl).pathname || '/');
  } catch (error) {
    return null;
  }
  if (pathname === '/') pathname = '/index.html';
  if (pathname.includes('\0') || pathname.includes('\\')) return null;

  const relativePath = pathname.replace(/^\/+/, '');
  const isPublicRootFile = PUBLIC_ROOT_FILE.test(relativePath) && !relativePath.startsWith('.');
  if (!isPublicRootFile && !PUBLIC_TEMPLATE_FILE.test(relativePath)) return null;
  const filePath = path.resolve(ROOT, relativePath);
  const relativeToRoot = path.relative(ROOT, filePath);
  if (!relativeToRoot || relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) return null;
  return filePath;
}

function startServer(options) {
  options = options || {};
  const port = options.port !== undefined ? options.port : PORT;
  const host = options.host || HOST;
  return http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Allow': 'GET, HEAD',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end('405 Method Not Allowed');
    return;
  }

  const filePath = resolvePublicFile(req.url || '/');
  if (!filePath) {
    res.writeHead(404, {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end('404 Not Found');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext],
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.end(data);
  });
  }).listen(port, host, () => {
    // Google GSI 通常已授權 localhost，測試登入請使用 localhost
    if (!options.silent) console.log(`Dev server running at http://${host}:${port}/`);
  });
}

if (require.main === module) startServer();

module.exports = { resolvePublicFile, startServer };
