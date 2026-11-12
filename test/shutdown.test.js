import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { registerSignalHandlers, start, stop } from '../nginx-monitor.js';

test('stop calls task.stop, waits for the running cycle, then closes the server', async () => {
  const order = [];

  const task = {
    stop() {
      order.push('task');
    },
  };

  const server = {
    close(callback) {
      order.push('close');
      callback();
    },
  };

  const ctx = { running: true };

  setTimeout(() => {
    order.push('cycle-finished');
    ctx.running = false;
  }, 30);

  await stop({ server, task, ctx, timeoutMs: 1000 });
  assert.deepEqual(order, ['task', 'cycle-finished', 'close']);
  assert.equal(ctx.running, false);
});

test('stop closes the server when the cycle is still running at the timeout', async () => {
  let closed = false;
  const server = {
    close(callback) {
      closed = true;
      callback();
    },
  };
  const ctx = { running: true };
  await stop({ server, ctx, timeoutMs: 20 });
  assert.equal(closed, true);
  assert.equal(ctx.running, true);
});

test('stop handles empty arguments gracefully', async () => {
  await stop();
  await stop({});
});

test('registerSignalHandlers handles SIGINT and SIGTERM and stops once', async () => {
  const fakeProcess = new EventEmitter();
  let exited = 0;
  let stopped = 0;

  const state = {
    task: {
      stop() {
        stopped += 1;
      },
    },
  };

  const unregister = registerSignalHandlers(state, {
    processObj: fakeProcess,
    onExit: () => {
      exited += 1;
    },
  });

  fakeProcess.emit('SIGINT');
  // Wait a tick for async handler
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(stopped, 1);
  assert.equal(exited, 1);

  // Subsequent signal does nothing
  fakeProcess.emit('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(stopped, 1);
  assert.equal(exited, 1);

  unregister();
  assert.equal(fakeProcess.listenerCount('SIGINT'), 0);
  assert.equal(fakeProcess.listenerCount('SIGTERM'), 0);
});

test('a signal during the first cycle waits for it and does not schedule cron', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nginx-monitor-start-'));
  let release;
  const server = http.createServer((req, res) => {
    release = () => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Active connections: 1\nserver accepts handled requests\n 1 1 1\nReading: 0 Writing: 1 Waiting: 0\n');
    };
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const fakeProcess = new EventEmitter();
  let exited = 0;
  try {
    const started = start({
      SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/X',
      STATUS_URL: `http://127.0.0.1:${server.address().port}/nginx_status`,
      STATUS_LOG_FILE: path.join(dir, 'status-history.json'),
      WEB_ENABLED: 'false',
    }, { processObj: fakeProcess, onExit: () => { exited += 1; } });
    while (!release) await new Promise((resolve) => setTimeout(resolve, 5));
    fakeProcess.emit('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(exited, 0);
    release();
    const state = await started;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(state.task, null);
    assert.equal(state.stopping, true);
    assert.equal(exited, 1);
    state.unregister();
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
