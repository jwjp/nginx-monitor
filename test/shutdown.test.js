import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { registerSignalHandlers, stop } from '../nginx-monitor.js';

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
