import http from 'node:http';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchProbe, parseAcceptedStatuses, statusAccepted } from '../src/probe.js';

test('matches an inclusive range and a comma-separated list', () => {
  const range = parseAcceptedStatuses('200-399');
  assert.equal(statusAccepted(200, range), true);
  assert.equal(statusAccepted(399, range), true);
  assert.equal(statusAccepted(400, range), false);

  const list = parseAcceptedStatuses('200, 204, 301');
  assert.equal(statusAccepted(200, list), true);
  assert.equal(statusAccepted(204, list), true);
  assert.equal(statusAccepted(301, list), true);
  assert.equal(statusAccepted(202, list), false);
});

test('a redirect is a probe failure even when the status is in the accepted range', async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    if (req.url.startsWith('/redirect')) {
      res.writeHead(302, { Location: 'http://127.0.0.1/away' });
      res.end();
      return;
    }
    res.writeHead(204);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const ranges = parseAcceptedStatuses('200-399');
    const redirect = await fetchProbe(`http://127.0.0.1:${port}/redirect`, { timeoutMs: 1000, ranges });
    assert.deepEqual(redirect, { ok: false, status: 302 });
    const ok = await fetchProbe(`http://127.0.0.1:${port}/health`, { timeoutMs: 1000, ranges });
    assert.deepEqual(ok, { ok: true, status: 204 });
    assert.equal(hits, 2);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});
