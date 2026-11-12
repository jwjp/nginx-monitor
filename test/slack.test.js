import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_QUEUED_RESTARTS,
  formatAlert,
  gateAlert,
  orderDeliveries,
  queueUndelivered,
  sendSlack,
} from '../src/slack.js';

const WEBHOOK = 'https://hooks.slack.com/services/T/B/X';

test('a repeat inside the window is skipped, recovery deletes the key, and the next incident sends', () => {
  const event = { target: 'http://127.0.0.1/nginx_status', kind: 'down' };
  const first = gateAlert({}, event, 1_000, 900_000);
  assert.equal(first.send, true);

  const repeat = gateAlert(first.sent, event, 2_000, 900_000);
  assert.equal(repeat.send, false);
  assert.equal(repeat.sent, first.sent);

  const recovery = gateAlert(first.sent, { ...event, recovery: true }, 2_000, 900_000);
  assert.equal(recovery.send, true);
  assert.equal(recovery.sent[`${event.target}::${event.kind}`], undefined);

  const next = gateAlert(recovery.sent, event, 2_100, 900_000);
  assert.equal(next.send, true);
});

test('a one-shot alert does not repeat until recovery deletes the key', () => {
  const event = { target: 'nginx-pid', kind: 'config_test', once: true };
  const first = gateAlert({}, event, 0, 900_000);
  assert.equal(first.send, true);
  const later = gateAlert(first.sent, event, 9_000_000, 900_000);
  assert.equal(later.send, false);
  const recovery = gateAlert(first.sent, { ...event, recovery: true, once: false }, 9_000_100, 900_000);
  const again = gateAlert(recovery.sent, event, 9_000_200, 900_000);
  assert.equal(again.send, true);
});

test('formats a message without the webhook and posts it', async () => {
  const text = formatAlert({
    target: 'http://127.0.0.1/nginx_status',
    kind: 'down',
    at: Date.UTC(2026, 10, 12, 2, 31, 30),
    reason: 'stub_status unreachable',
    recovery: false,
  });
  assert.match(text, /^\[nginx\] http:\/\/127\.0\.0\.1\/nginx_status down/);
  assert.match(text, /2026-11-12T02:31:30\.000Z/);
  assert.match(text, /stub_status unreachable/);
  assert.equal(text.includes(WEBHOOK), false);

  let seen;
  await sendSlack(WEBHOOK, text, {
    timeoutMs: 1000,
    fetchImpl: async (url, options) => {
      seen = { url, options };
      return new Response('ok', { status: 200 });
    },
  });
  assert.equal(seen.url, WEBHOOK);
  assert.equal(seen.options.redirect, 'manual');
  assert.equal(JSON.parse(seen.options.body).text, text);
  assert.equal(JSON.parse(seen.options.body).text.includes(WEBHOOK), false);
});

test('a restart is an event and every one sends, even inside the window', () => {
  const event = { target: 'http://127.0.0.1/nginx_status', kind: 'restart', recovery: false, release: false };
  const first = gateAlert({}, event, 0, 900_000);
  assert.equal(first.send, true);
  const second = gateAlert(first.sent, event, 60_000, 900_000);
  assert.equal(second.send, true);
});

test('orderDeliveries keeps every queued restart and sends the oldest first', () => {
  const target = 'http://127.0.0.1/nginx_status';
  const older = { target, kind: 'restart', at: 1_000, recovery: false, release: false, reason: 'first' };
  const newer = { target, kind: 'restart', at: 2_000, recovery: false, release: false, reason: 'second' };
  let pending = queueUndelivered({}, newer);
  pending = queueUndelivered(pending, older);
  assert.equal(Object.keys(pending).length, 2);
  assert.deepEqual(orderDeliveries([], pending), [older, newer]);

  const current = { ...newer, at: 3_000, reason: 'third' };
  assert.deepEqual(orderDeliveries([current], pending), [older, newer, current]);
});

test('queueUndelivered keeps only the newest restarts for a target', () => {
  const target = 'http://127.0.0.1/nginx_status';
  let pending = { other: { target: 'nginx-pid', kind: 'restart', at: 0 } };
  for (let at = 1; at <= MAX_QUEUED_RESTARTS + 3; at += 1) {
    pending = queueUndelivered(pending, { target, kind: 'restart', at, reason: String(at) });
  }
  const kept = Object.values(pending).filter((event) => event.target === target).map((event) => event.at);
  assert.equal(kept.length, MAX_QUEUED_RESTARTS);
  assert.equal(Math.min(...kept), 4);
  assert.ok(pending.other);
});

test('a late delivery keeps the original time and says when it was sent', () => {
  const text = formatAlert({
    target: 'nginx-pid',
    kind: 'restart',
    at: Date.UTC(2026, 10, 12, 0, 1),
    reason: 'master pid changed from 42 to 99',
    recovery: false,
  }, Date.UTC(2026, 10, 12, 0, 2));
  assert.match(text, /\n2026-11-12T00:01:00\.000Z\n/);
  assert.match(text, /delivered late at 2026-11-12T00:02:00\.000Z$/);
});

test('orderDeliveries sends a queued incident before the recovery that closes it', () => {
  const incident = {
    target: 'http://127.0.0.1/nginx_status',
    kind: 'dropped',
    recovery: false,
    release: false,
    reason: 'dropped 3 connections',
  };
  const recovery = {
    target: incident.target,
    kind: 'dropped',
    recovery: true,
    release: false,
    reason: 'dropped connections fell below 1',
  };
  const release = {
    target: incident.target,
    kind: 'dropped',
    recovery: false,
    release: true,
    reason: '',
  };
  const key = `${incident.target}::dropped`;
  assert.deepEqual(orderDeliveries([recovery], { [key]: incident }), [incident, recovery]);
  assert.deepEqual(orderDeliveries([release], { [key]: incident }), [incident, release]);
  assert.deepEqual(orderDeliveries([recovery], {}), [recovery]);
});

test('orderDeliveries sends the whole backlog oldest first, even with a recovery in the batch', () => {
  const older = { target: 'A', kind: 'dropped', at: 1, recovery: false, release: false };
  const newer = { target: 'B', kind: 'restart', at: 2, recovery: false, release: false };
  const recovery = { target: 'A', kind: 'dropped', at: 3, recovery: true, release: false };
  const pending = { 'A::dropped': older, 'B::restart::2': newer };
  assert.deepEqual(orderDeliveries([recovery], pending), [older, newer, recovery]);
});

test('formatAlert escapes Slack control characters in the target and reason', () => {
  const text = formatAlert({
    target: 'nginx',
    kind: 'config_test',
    at: 0,
    reason: 'nginx -t failed: unknown directive "<!channel>" & <http://x|y>',
    recovery: false,
  });
  assert.equal(text.includes('<'), false);
  assert.equal(text.includes('>'), false);
  assert.match(text, /"&lt;!channel&gt;" &amp; &lt;http:\/\/x\|y&gt;/);
});
