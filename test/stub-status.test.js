import http from 'node:http';
import assert from 'node:assert/strict';
import test from 'node:test';
import { diffSamples, fetchStubStatus, parseStubStatus } from '../src/stub-status.js';

const OFFICIAL = `Active connections: 291
server accepts handled requests
 16630948 16630948 31070465
Reading: 6 Writing: 179 Waiting: 106
`;

function listen(handler) {
  const server = http.createServer(handler);
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/nginx_status`,
        close() {
          for (const socket of sockets) socket.destroy();
          return new Promise((done) => server.close(() => done()));
        },
      });
    });
  });
}

test('parses the official stub_status sample', () => {
  const parsed = parseStubStatus(OFFICIAL);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.sample, {
    active: 291,
    accepts: 16630948,
    handled: 16630948,
    requests: 31070465,
    reading: 6,
    writing: 179,
    waiting: 106,
  });
});

test('parses extra whitespace', () => {
  const body = `\n\n  Active connections:   3  \r\n\r\n server accepts handled requests \n\n  1200   1200   3560 \n\n Reading:  0   Writing:   1   Waiting:   2 \n`;
  const parsed = parseStubStatus(body);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.sample, {
    active: 3,
    accepts: 1200,
    handled: 1200,
    requests: 3560,
    reading: 0,
    writing: 1,
    waiting: 2,
  });
});

test('rejects an HTML body as a bad status page', () => {
  const parsed = parseStubStatus('<!DOCTYPE html><html><body>nope</body></html>');
  assert.deepEqual(parsed, { ok: false, reason: 'bad_status_page' });
});

test('diffs a quiet interval, a dropped interval, and a counter reset', () => {
  const quiet = diffSamples(
    { accepts: 10, handled: 10, requests: 10 },
    { accepts: 15, handled: 15, requests: 20 },
  );
  assert.equal(quiet.restart, false);
  assert.equal(quiet.dropped, 0);

  const dropped = diffSamples(
    { accepts: 10, handled: 10, requests: 10 },
    { accepts: 15, handled: 12, requests: 20 },
  );
  assert.equal(dropped.restart, false);
  assert.equal(dropped.dropped, 3);

  const reset = diffSamples(
    { accepts: 1000, handled: 900, requests: 2000 },
    { accepts: 5, handled: 5, requests: 8 },
  );
  assert.deepEqual(reset, { restart: true });
});

test('fetch classifies a live page, a redirect, a non-200, an oversized body, and a timeout', async () => {
  let hits = 0;
  const server = await listen((req, res) => {
    hits += 1;
    const path = req.url;
    if (path.startsWith('/redirect')) {
      res.writeHead(302, { Location: 'http://127.0.0.1/other' });
      res.end();
      return;
    }
    if (path.startsWith('/missing')) {
      res.writeHead(503);
      res.end('no');
      return;
    }
    if (path.startsWith('/big')) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('x'.repeat((64 * 1024) + 1));
      return;
    }
    if (path.startsWith('/html')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html>not status</html>');
      return;
    }
    if (path.startsWith('/hang')) return;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(OFFICIAL);
  });

  try {
    const ok = await fetchStubStatus(server.url, { timeoutMs: 1000 });
    assert.equal(ok.type, 'ok');
    assert.equal(ok.sample.active, 291);

    const redirect = await fetchStubStatus(server.url.replace('/nginx_status', '/redirect'), { timeoutMs: 1000 });
    assert.deepEqual(redirect, { type: 'down' });

    const missing = await fetchStubStatus(server.url.replace('/nginx_status', '/missing'), { timeoutMs: 1000 });
    assert.deepEqual(missing, { type: 'down' });

    const big = await fetchStubStatus(server.url.replace('/nginx_status', '/big'), { timeoutMs: 1000 });
    assert.deepEqual(big, { type: 'down' });

    const html = await fetchStubStatus(server.url.replace('/nginx_status', '/html'), { timeoutMs: 1000 });
    assert.deepEqual(html, { type: 'bad_status_page' });

    const before = hits;
    const hung = await fetchStubStatus(server.url.replace('/nginx_status', '/hang'), { timeoutMs: 50 });
    assert.deepEqual(hung, { type: 'down' });
    assert.equal(hits, before + 1);
  } finally {
    await server.close();
  }
});

test('parses repeated spaces and tabs inside a line', () => {
  const body = 'Active  connections:\t4\nserver  accepts\thandled   requests\n 5\t5  9\nReading:\t0  Writing: 1\tWaiting:  3\n';
  const parsed = parseStubStatus(body);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.sample.active, 4);
  assert.equal(parsed.sample.requests, 9);
  assert.equal(parsed.sample.waiting, 3);
});
