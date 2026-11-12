import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { isLoopbackHost } from './config.js';

function sha256(value) {
  return createHash('sha256').update(value).digest();
}

export function authorizeStatus({ host, token, authorization }) {
  if (!token) return isLoopbackHost(host);
  // Hash both sides so timingSafeEqual always sees equal-length digests.
  const header = typeof authorization === 'string' ? authorization : '';
  return timingSafeEqual(sha256(header), sha256(`Bearer ${token}`));
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function createStatusServer({ host, token, readHistory }) {
  return http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url || '/', 'http://127.0.0.1');
    } catch {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }

    if (req.method !== 'GET') {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }

    if (url.pathname === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (url.pathname !== '/status') {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }

    const authorized = authorizeStatus({
      host,
      token,
      authorization: req.headers.authorization,
    });
    if (!authorized) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    try {
      sendJson(res, 200, await readHistory());
    } catch {
      console.error('status history is unreadable');
      sendJson(res, 500, { error: 'unavailable' });
    }
  });
}
