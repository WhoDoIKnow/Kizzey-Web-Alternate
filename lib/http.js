'use strict';

const fs = require('fs');
const path = require('path');
const { MAX_BODY, STATIC_DIR, UPLOAD_DIR, MIME_OVERRIDES } = require('./constants');

const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(self), geolocation=(self)',
};

function applySecurity(res) {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(key, value);
}

function sendJson(res, data, status = 200, extra = null) {
  const raw = Buffer.from(JSON.stringify(data), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': raw.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...SECURITY_HEADERS,
    ...(extra || {}),
  });
  res.end(raw);
}

function sendError(res, message, status = 400, extra = null) {
  const { scrub } = require('./scrub');
  sendJson(res, { ok: false, error: scrub(String(message)), ...(extra || {}) }, status);
}

function sendRaw(res, buffer, headers, status = 200) {
  res.writeHead(status, { 'Content-Length': buffer.length, ...SECURITY_HEADERS, ...headers });
  res.end(buffer);
}

function readJsonBody(req, { allowList = false, maxBytes = MAX_BODY } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Request is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        return reject(new Error('Invalid JSON body.'));
      }
      if (data === null || typeof data !== 'object' || (!allowList && Array.isArray(data))) {
        return reject(
          new Error(allowList ? 'JSON body must be an object or list.' : 'JSON body must be an object.')
        );
      }
      resolve(data);
    });
  });
}

function query(url) {
  const out = {};
  for (const [key, value] of url.searchParams.entries()) out[key] = value;
  return out;
}

function guessMime(file) {
  const ext = path.extname(file).toLowerCase();
  return MIME_OVERRIDES[ext] || 'application/octet-stream';
}

function serveStatic(req, res, pathname) {
  let file;
  if (pathname === '' || pathname === '/') {
    file = path.join(STATIC_DIR, 'index.html');
  } else if (pathname.startsWith('/uploads/')) {
    file = path.join(UPLOAD_DIR, path.basename(pathname));
  } else {
    const relative = pathname.replace(/^\/+/, '');
    if (relative.split('/').includes('..')) return sendError(res, 'Not found.', 404);
    file = path.join(STATIC_DIR, relative);
    if (!fs.existsSync(file) && !path.extname(relative)) {
      file = path.join(STATIC_DIR, 'index.html');
    }
  }
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return sendError(res, 'Not found.', 404);
  }
  if (!stat.isFile()) return sendError(res, 'Not found.', 404);
  const etag = `"${Math.trunc(stat.mtimeMs)}-${stat.size}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, ...SECURITY_HEADERS });
    res.end();
    return;
  }
  const ext = path.extname(file).toLowerCase();
  const cache = ['.html', '.js', '.css', '.webmanifest'].includes(ext)
    ? 'no-cache'
    : 'public, max-age=3600';
  const raw = fs.readFileSync(file);
  res.writeHead(200, {
    'Content-Type': guessMime(file),
    'Content-Length': raw.length,
    'Cache-Control': cache,
    ETag: etag,
    'X-Content-Type-Options': 'nosniff',
    ...SECURITY_HEADERS,
  });
  res.end(raw);
}

module.exports = {
  applySecurity,
  sendJson,
  sendError,
  sendRaw,
  readJsonBody,
  query,
  serveStatic,
};
