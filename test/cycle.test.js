import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { createContext, runCycle } from '../nginx-monitor.js';

function page(active, accepts, handled, requests) {
  return `Active connections: ${active}
server accepts handled requests
 ${accepts} ${handled} ${requests}
Reading: 0 Writing: 1 Waiting: 0
`;
}

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
        port,
        close() {
          for (const socket of sockets) socket.destroy();
          return new Promise((done) => server.close(() => done()));
        },
      });
    });
  });
}

test('a cycle records history and sends slack without calling hooks.slack.com', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nginx-monitor-cycle-'));
  let body = page(1, 10, 10, 10);
  let probeStatus = 500;
  const stub = await listen((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(body);
  });
  const probe = await listen((req, res) => {
    res.writeHead(probeStatus);
    res.end('no body stored');
  });
  const slack = [];
  const webhook = 'https://hooks.slack.com/services/T/B/X';
  const pidFile = path.join(dir, 'nginx.pid');
  const historyFile = path.join(dir, 'status-history.json');
  await writeFile(pidFile, '42\n');

  const config = loadConfig({
    SLACK_WEBHOOK_URL: webhook,
    STATUS_URL: `http://127.0.0.1:${stub.port}/nginx_status`,
    PROBE_URL: `http://127.0.0.1:${probe.port}/health`,
    NGINX_TEST_ENABLED: 'true',
    NGINX_PID_FILE: pidFile,
    STATUS_LOG_FILE: historyFile,
    WEB_ENABLED: 'false',
    THROTTLE_DURATION_MS: '900000',
  });
  let now = Date.parse('2026-11-12T00:00:00.000Z');
  const ctx = createContext(config, {
    now: () => now,
    fetchImpl: async (url, options) => {
      if (String(url).startsWith('https://hooks.slack.com/')) {
        slack.push(JSON.parse(options.body).text);
        return new Response('ok', { status: 200 });
      }
      return globalThis.fetch(url, options);
    },
    execFileImpl: async (bin, args) => {
      assert.equal(bin, 'nginx');
      assert.deepEqual(args, ['-t']);
      return { stdout: '', stderr: 'nginx: the configuration file syntax is ok' };
    },
  });

  try {
    await runCycle(ctx);
    assert.equal(slack.some((text) => text.includes(' probe\n') && text.includes('500 ')), true);
    assert.equal(slack.some((text) => text.includes(' dropped\n')), false);
    assert.equal(slack.every((text) => !text.includes(webhook)), true);

    body = page(4, 14, 11, 20);
    now += 60_000;
    await runCycle(ctx);
    assert.equal(slack.some((text) => text.includes(' dropped\n') && text.includes('dropped 3 connections')), true);

    body = '<html>not status</html>';
    now += 60_000;
    await runCycle(ctx);
    assert.equal(slack.some((text) => text.includes(' bad_status_page\n')), true);

    const history = JSON.parse(await readFile(historyFile, 'utf8'));
    const serialized = JSON.stringify(history);
    assert.equal(serialized.includes(webhook), false);
    assert.equal(serialized.includes('syntax is ok'), false);
    assert.equal(serialized.includes('no body stored'), false);
    assert.equal(history[0].statuses[0].state, 'bad_status_page');
    assert.equal(history[0].probe.ok, false);
    assert.equal(history[0].probe.status, 500);
    assert.equal(history[0].configTestOk, true);
    assert.equal(history[0].pidCheckOk, true);
    assert.equal(history[0].masterPid, 42);
    assert.equal(history[0].skippedCycles, 0);
    assert.equal(history[0].undelivered, 0);
    assert.deepEqual(history[0].open, [
      { target: `http://127.0.0.1:${stub.port}/nginx_status`, kind: 'bad_status_page' },
      { target: `http://127.0.0.1:${stub.port}/nginx_status`, kind: 'dropped' },
      { target: `http://127.0.0.1:${probe.port}/health`, kind: 'probe' },
    ]);
    assert.equal(JSON.stringify(history[0].open).includes('syntax'), false);
    assert.equal(history.length, 3);
  } finally {
    await stub.close();
    await probe.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function withStatus(options, run) {
  if (typeof options === 'function') {
    run = options;
    options = {};
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'nginx-monitor-retry-'));
  let body = page(1, 10, 10, 10);
  let statusCode = 200;
  const stub = await listen((req, res) => {
    res.writeHead(statusCode, { 'Content-Type': 'text/plain' });
    res.end(body);
  });
  const slack = [];
  let failSlack = false;
  const historyFile = path.join(dir, 'status-history.json');
  const pidFile = path.join(dir, 'nginx.pid');
  const statusUrl = `http://127.0.0.1:${stub.port}/nginx_status`;
  if (options.pid) await writeFile(pidFile, '42\n');
  const env = {
    SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/X',
    STATUS_URL: statusUrl,
    STATUS_LOG_FILE: historyFile,
    WEB_ENABLED: 'false',
  };
  if (options.pid) env.NGINX_PID_FILE = pidFile;
  let now = Date.parse('2026-11-12T00:00:00.000Z');
  const ctx = createContext(loadConfig(env), {
    now: () => now,
    fetchImpl: async (url, options) => {
      if (String(url).startsWith('https://hooks.slack.com/')) {
        if (failSlack) throw new Error('slack down');
        slack.push(JSON.parse(options.body).text);
        return new Response('ok', { status: 200 });
      }
      return globalThis.fetch(url, options);
    },
  });
  try {
    await run({
      ctx,
      slack,
      statusUrl,
      historyFile,
      pidFile,
      setBody(next) { body = next; },
      setStatus(next) { statusCode = next; },
      setFailSlack(value) { failSlack = value; },
      advance(ms = 60_000) { now += ms; },
    });
  } finally {
    await stub.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('a skipped cycle is reported by the next completed cycle and then recovers', async () => {
  await withStatus(async ({ ctx, slack, historyFile, advance }) => {
    await runCycle(ctx);
    ctx.running = true;
    await runCycle(ctx);
    await runCycle(ctx);
    ctx.running = false;
    slack.length = 0;
    advance();
    await runCycle(ctx);
    assert.equal(slack.some((text) => text.includes(' lag\n') && text.includes('skipped 2')), true);
    const history = JSON.parse(await readFile(historyFile, 'utf8'));
    assert.equal(history[0].skippedCycles, 2);
    assert.equal(history[0].open.some((item) => item.kind === 'lag' && item.target === 'nginx-monitor'), true);

    slack.length = 0;
    advance();
    await runCycle(ctx);
    assert.equal(slack.some((text) => text.includes('lag recovered')), true);
    const recovered = JSON.parse(await readFile(historyFile, 'utf8'));
    assert.equal(recovered[0].skippedCycles, 0);
    assert.equal(recovered[0].open.some((item) => item.kind === 'lag'), false);
  });
});

test('a failed restart post is retried without rolling the baseline back', async () => {
  await withStatus(async ({ ctx, slack, statusUrl, historyFile, setBody, setFailSlack, advance }) => {
    setBody(page(1, 100, 100, 100));
    await runCycle(ctx);

    setFailSlack(true);
    setBody(page(1, 5, 5, 5));
    advance();
    await runCycle(ctx);
    assert.equal(slack.length, 0);
    assert.equal(ctx.urlStates.get(statusUrl).lastGood.accepts, 5);
    assert.equal(Object.values(ctx.undelivered)[0].reason, 'counters moved backward');
    const failed = JSON.parse(await readFile(historyFile, 'utf8'));
    assert.equal(failed[0].statuses[0].restart, true);
    assert.equal(failed[0].statuses[0].accepts, 5);

    setFailSlack(false);
    setBody(page(1, 8, 8, 12));
    advance();
    await runCycle(ctx);
    assert.equal(slack.length, 1);
    assert.match(slack[0], / restart\n/);
    assert.match(slack[0], /counters moved backward/);
    assert.match(slack[0], /\n2026-11-12T00:01:00\.000Z\n/);
    assert.match(slack[0], /delivered late at 2026-11-12T00:02:00\.000Z/);
    assert.equal(ctx.urlStates.get(statusUrl).lastGood.accepts, 8);
    assert.deepEqual(ctx.undelivered, {});
    const retried = JSON.parse(await readFile(historyFile, 'utf8'));
    assert.equal(retried[0].statuses[0].restart, false);
    assert.equal(retried[0].statuses[0].deltas.dropped, 0);
  });
});

test('a second restart does not replace a queued restart', async () => {
  await withStatus(async ({ ctx, slack, statusUrl, setBody, setFailSlack, advance }) => {
    setBody(page(1, 100, 100, 100));
    await runCycle(ctx);

    setFailSlack(true);
    setBody(page(1, 5, 5, 5));
    advance();
    await runCycle(ctx);

    setFailSlack(false);
    setBody(page(1, 1, 1, 1));
    advance();
    await runCycle(ctx);
    assert.equal(slack.length, 2);
    assert.match(slack[0], /\n2026-11-12T00:01:00\.000Z\n/);
    assert.match(slack[0], /delivered late at 2026-11-12T00:02:00\.000Z/);
    assert.match(slack[1], /\n2026-11-12T00:02:00\.000Z\ncounters moved backward$/);
    assert.equal(ctx.urlStates.get(statusUrl).lastGood.accepts, 1);
    assert.deepEqual(ctx.undelivered, {});
  });
});

test('a failed dropped post is delivered before its recovery', async () => {
  await withStatus(async ({ ctx, slack, statusUrl, setBody, setFailSlack, advance }) => {
    setBody(page(1, 10, 10, 10));
    await runCycle(ctx);

    setFailSlack(true);
    setBody(page(1, 13, 10, 20));
    advance();
    await runCycle(ctx);
    assert.equal(slack.length, 0);
    assert.equal(ctx.urlStates.get(statusUrl).open.dropped, true);
    assert.equal(ctx.urlStates.get(statusUrl).lastGood.accepts, 13);

    setBody(page(1, 14, 14, 21));
    advance();
    await runCycle(ctx);
    assert.equal(slack.length, 0);
    assert.equal(ctx.urlStates.get(statusUrl).open.dropped, true);
    assert.equal(ctx.urlStates.get(statusUrl).lastGood.accepts, 14);
    assert.equal(ctx.undelivered[`${statusUrl}::dropped`].reason, 'dropped 3 connections');

    setFailSlack(false);
    advance();
    await runCycle(ctx);
    assert.equal(slack.length, 2);
    assert.match(slack[0], / dropped\n/);
    assert.match(slack[0], /dropped 3 connections/);
    assert.match(slack[1], /dropped recovered/);
    assert.match(slack[1], /dropped connections fell below 1/);
    assert.equal(ctx.urlStates.get(statusUrl).open.dropped, false);
    assert.deepEqual(ctx.undelivered, {});
  });
});

test('a failed pid restart post keeps the new pid and retries the original reason', async () => {
  await withStatus({ pid: true }, async ({ ctx, slack, pidFile, setBody, setFailSlack, advance }) => {
    setBody(page(1, 10, 10, 10));
    await runCycle(ctx);
    assert.equal(ctx.pidState.pid, 42);
    assert.equal(slack.length, 0);

    setFailSlack(true);
    await writeFile(pidFile, '99\n');
    advance();
    await runCycle(ctx);
    assert.equal(slack.length, 0);
    assert.equal(ctx.pidState.pid, 99);
    assert.match(Object.values(ctx.undelivered)[0].reason, /from 42 to 99/);

    setFailSlack(false);
    advance();
    await runCycle(ctx);
    assert.equal(slack.length, 1);
    assert.match(slack[0], / restart\n/);
    assert.match(slack[0], /master pid changed from 42 to 99/);
    assert.equal(ctx.pidState.pid, 99);
    assert.deepEqual(ctx.undelivered, {});
  });
});

test('a failed recovery post does not throttle the next incident', async () => {
  await withStatus(async ({ ctx, slack, statusUrl, setStatus, setFailSlack, advance }) => {
    setStatus(503);
    await runCycle(ctx);
    assert.equal(slack.length, 1);

    setStatus(200);
    setFailSlack(true);
    advance();
    await runCycle(ctx);
    assert.equal(ctx.sent[`${statusUrl}::down`], undefined);

    setFailSlack(false);
    setStatus(503);
    advance();
    await runCycle(ctx);
    assert.equal(slack.length, 2);
    assert.match(slack[1], / down\n/);
  });
});

test('a late incident after its condition closed does not throttle the next one', async () => {
  await withStatus(async ({ ctx, slack, statusUrl, setBody, setStatus, setFailSlack, advance }) => {
    await runCycle(ctx);

    setFailSlack(true);
    setStatus(503);
    advance();
    await runCycle(ctx);

    setStatus(200);
    setBody('<html>not stub_status</html>');
    advance();
    await runCycle(ctx);

    setFailSlack(false);
    advance();
    await runCycle(ctx);
    assert.match(slack[0], / down\n/);
    assert.match(slack[0], /delivered late at/);
    assert.equal(ctx.sent[`${statusUrl}::down`], undefined);

    setStatus(503);
    advance();
    await runCycle(ctx);
    assert.match(slack.at(-1), / down\n2026-11-12T00:04:00\.000Z\n/);
  });
});

test('one failed post defers the rest of the cycle instead of retrying each one', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nginx-monitor-breaker-'));
  const config = loadConfig({
    SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/X',
    STATUS_URL: 'http://127.0.0.1:9/a',
    STATUS_URLS: 'http://127.0.0.1:9/b,http://127.0.0.1:9/c',
    STATUS_LOG_FILE: path.join(dir, 'status-history.json'),
    WEB_ENABLED: 'false',
  });
  let attempts = 0;
  let failSlack = true;
  const slack = [];
  let now = Date.parse('2026-11-12T00:00:00.000Z');
  const ctx = createContext(config, {
    now: () => now,
    fetchImpl: async (url, options) => {
      if (String(url).startsWith('https://hooks.slack.com/')) {
        attempts += 1;
        if (failSlack) throw new Error('slack down');
        slack.push(JSON.parse(options.body).text);
        return new Response('ok', { status: 200 });
      }
      throw new Error('connection refused');
    },
  });
  try {
    await runCycle(ctx);
    assert.equal(attempts, 1);
    assert.equal(Object.keys(ctx.undelivered).length, 3);

    failSlack = false;
    now += 60_000;
    await runCycle(ctx);
    assert.equal(slack.length, 3);
    assert.deepEqual(ctx.undelivered, {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
