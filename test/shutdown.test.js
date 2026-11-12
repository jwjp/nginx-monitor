import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { registerSignalHandlers, stop } from '../nginx-monitor.js';

test('stop calls task.stop, server.close, and waits for running cycle', async () => {
  let taskStopped = false;
  let serverClosed = false;

  const task = {
    stop() {
      taskStopped = true;
    },
  };

  const server = {
    close(callback) {
      serverClosed = true;
      callback();
    },
  };

  const ctx = { running: true };

  // Release running after 30 ms
  setTimeout(() => {
    ctx.running = false;
  }, 30);

  await stop({ server, task, ctx, timeoutMs: 1000 });
  assert.equal(taskStopped, true);
  assert.equal(serverClosed, true);
  assert.equal(ctx.running, false);
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
