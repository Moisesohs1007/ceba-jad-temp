const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8000);

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.webp': 'image/webp',
};

function sendText(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function safeResolve(urlPath) {
  const normalized = path.normalize(path.join(root, '.' + urlPath));
  if (!normalized.startsWith(root)) return null;
  return normalized;
}

function resolveTargetPath(urlPath) {
  let target = safeResolve(urlPath);
  if (!target) return null;

  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    target = path.join(target, 'index.html');
  }

  return target;
}

const server = http.createServer((req, res) => {
  const rawPath = decodeURIComponent((req.url || '/').split('?')[0] || '/');
  const urlPath = rawPath === '/' ? '/index.html' : rawPath;
  const targetPath = resolveTargetPath(urlPath);

  if (!targetPath) {
    return sendText(res, 403, 'Forbidden');
  }

  fs.readFile(targetPath, (error, data) => {
    if (error) {
      return sendText(res, 404, 'Not found');
    }

    const ext = path.extname(targetPath).toLowerCase();
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

server.listen(port, host, () => {
  process.stdout.write(`http://${host}:${port}/\n`);
});
