import http from 'node:http';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createStatusServer } from '../src/status-server.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function close(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

async function request(port, path, { headers, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test('authorizes loopback without a token and rejects the other token cases', async () => {
  const history = [{ timestamp: '2026-11-12T00:00:00.000Z', statuses: [] }];
  const openServer = createStatusServer({
    host: '127.0.0.1',
    token: '',
    readHistory: async () => history,
  });
  const closedServer = createStatusServer({
    host: '0.0.0.0',
    token: '',
    readHistory: async () => history,
  });
  const tokenServer = createStatusServer({
    host: '0.0.0.0',
    token: 'secret',
    readHistory: async () => history,
  });

  const openPort = await listen(openServer);
  const closedPort = await listen(closedServer);
  const tokenPort = await listen(tokenServer);
  try {
    const health = await request(openPort, '/healthz');
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), { ok: true });
    assert.equal(health.headers['cache-control'], 'no-store');

    const post = await request(openPort, '/healthz', { method: 'POST' });
    assert.equal(post.status, 404);
    assert.equal(post.headers['cache-control'], 'no-store');

    const local = await request(openPort, '/status');
    assert.equal(local.status, 200);
    assert.deepEqual(JSON.parse(local.body), history);
    assert.equal(local.headers['cache-control'], 'no-store');

    const remote = await request(closedPort, '/status');
    assert.equal(remote.status, 401);

    const matching = await request(tokenPort, '/status', {
      headers: { Authorization: 'Bearer secret' },
    });
    assert.equal(matching.status, 200);
    assert.deepEqual(JSON.parse(matching.body), history);

    const wrong = await request(tokenPort, '/status', {
      headers: { Authorization: 'Bearer wrong' },
    });
    assert.equal(wrong.status, 401);

    const query = await request(tokenPort, '/status?token=secret');
    assert.equal(query.status, 401);

    const missing = await request(tokenPort, '/missing');
    assert.equal(missing.status, 404);
  } finally {
    await close(openServer);
    await close(closedServer);
    await close(tokenServer);
  }
});
