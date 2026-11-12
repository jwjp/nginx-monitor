import assert from 'node:assert/strict';
import test from 'node:test';
import { decidePid, decideUrl, initialPidState, initialUrlState } from '../src/decide.js';

const URL = 'http://127.0.0.1/nginx_status';

function config(overrides = {}) {
  return {
    droppedConnectionsMin: 1,
    activeConnectionsThreshold: 0,
    waitingConnectionsThreshold: 0,
    requestStallEnabled: false,
    requestStallWindows: 5,
    ...overrides,
  };
}

function sample(overrides = {}) {
  return {
    active: 1,
    accepts: 100,
    handled: 100,
    requests: 100,
    reading: 0,
    writing: 1,
    waiting: 0,
    ...overrides,
  };
}

function kinds(events) {
  return events.filter((event) => !event.release).map((event) => event.kind);
}

test('a quiet interval does not alert and a dropped interval does', () => {
  let state = initialUrlState();
  let at = 0;
  ({ state } = decideUrl(state, { type: 'ok', url: URL, sample: sample() }, config(), at));
  at += 60_000;
  const quiet = decideUrl(state, {
    type: 'ok',
    url: URL,
    sample: sample({ accepts: 110, handled: 110, requests: 120 }),
  }, config(), at);
  assert.deepEqual(kinds(quiet.events), []);
  assert.equal(quiet.record.deltas.dropped, 0);
  assert.equal(quiet.record.elapsedSeconds, 60);

  at += 60_000;
  const dropped = decideUrl(quiet.state, {
    type: 'ok',
    url: URL,
    sample: sample({ accepts: 120, handled: 112, requests: 130 }),
  }, config(), at);
  assert.deepEqual(kinds(dropped.events), ['dropped']);
  assert.equal(dropped.record.deltas.dropped, 8);
});

test('a counter reset emits restart and does not emit dropped', () => {
  let state = initialUrlState();
  ({ state } = decideUrl(state, { type: 'ok', url: URL, sample: sample({ accepts: 1000, handled: 900, requests: 2000 }) }, config(), 0));
  const reset = decideUrl(state, {
    type: 'ok',
    url: URL,
    sample: sample({ accepts: 5, handled: 5, requests: 8 }),
  }, config(), 60_000);
  assert.deepEqual(kinds(reset.events), ['restart']);
  assert.equal(reset.record.restart, true);
  assert.equal(reset.record.deltas, null);
});

test('the first good sample can alert on active connections and not on dropped', () => {
  const decided = decideUrl(
    initialUrlState(),
    { type: 'ok', url: URL, sample: sample({ active: 10, accepts: 500, handled: 400 }) },
    config({ activeConnectionsThreshold: 10 }),
    0,
  );
  assert.deepEqual(kinds(decided.events), ['active']);
});

test('a zero threshold disables active and waiting alerts', () => {
  const decided = decideUrl(
    initialUrlState(),
    { type: 'ok', url: URL, sample: sample({ active: 100, waiting: 100 }) },
    config(),
    0,
  );
  assert.deepEqual(kinds(decided.events), []);
});

test('stall stays quiet before the first busy sample and when disabled', () => {
  const enabled = config({ requestStallEnabled: true, requestStallWindows: 3 });
  let state = initialUrlState();
  let at = 0;
  ({ state } = decideUrl(state, { type: 'ok', url: URL, sample: sample({ requests: 10 }) }, enabled, at));
  for (let i = 0; i < 5; i += 1) {
    at += 60_000;
    const quiet = decideUrl(state, { type: 'ok', url: URL, sample: sample({ requests: 10 }) }, enabled, at);
    state = quiet.state;
    assert.deepEqual(kinds(quiet.events), []);
  }

  at += 60_000;
  ({ state } = decideUrl(state, { type: 'ok', url: URL, sample: sample({ requests: 11 }) }, enabled, at));
  for (let i = 0; i < 2; i += 1) {
    at += 60_000;
    const early = decideUrl(state, { type: 'ok', url: URL, sample: sample({ requests: 11 }) }, enabled, at);
    state = early.state;
    assert.deepEqual(kinds(early.events), []);
  }
  at += 60_000;
  const stall = decideUrl(state, { type: 'ok', url: URL, sample: sample({ requests: 11 }) }, enabled, at);
  assert.deepEqual(kinds(stall.events), ['stall']);

  at += 60_000;
  const recovered = decideUrl(stall.state, { type: 'ok', url: URL, sample: sample({ requests: 12 }) }, enabled, at);
  assert.equal(recovered.events.some((event) => event.kind === 'stall' && event.recovery), true);

  let disabled = initialUrlState();
  let disabledAt = 0;
  ({ state: disabled } = decideUrl(disabled, { type: 'ok', url: URL, sample: sample({ requests: 1 }) }, config(), disabledAt));
  disabledAt += 60_000;
  ({ state: disabled } = decideUrl(disabled, { type: 'ok', url: URL, sample: sample({ requests: 2 }) }, config(), disabledAt));
  for (let i = 0; i < 5; i += 1) {
    disabledAt += 60_000;
    const quiet = decideUrl(disabled, { type: 'ok', url: URL, sample: sample({ requests: 2 }) }, config(), disabledAt);
    disabled = quiet.state;
    assert.equal(quiet.events.some((event) => event.kind === 'stall'), false);
  }
});

test('down and a bad page are different alerts, and the next good sample recovers', () => {
  let state = initialUrlState();
  ({ state } = decideUrl(state, { type: 'ok', url: URL, sample: sample() }, config(), 0));
  const down = decideUrl(state, { type: 'down', url: URL }, config(), 60_000);
  assert.deepEqual(kinds(down.events), ['down']);
  const bad = decideUrl(down.state, { type: 'bad_status_page', url: URL }, config(), 120_000);
  assert.equal(bad.events.some((event) => event.kind === 'down' && event.release), true);
  assert.deepEqual(kinds(bad.events), ['bad_status_page']);
  const back = decideUrl(bad.state, { type: 'ok', url: URL, sample: sample({ requests: 101 }) }, config(), 180_000);
  assert.equal(back.events.some((event) => event.kind === 'bad_status_page' && event.recovery), true);
  assert.equal(back.record.state, 'ok');
});

test('a missing pid file alerts once until it is readable, and a new pid is a restart', () => {
  const missing = decidePid(initialPidState(), { ok: false });
  assert.equal(missing.events[0].kind, 'config_test');
  assert.equal(missing.events[0].once, true);
  assert.equal(missing.pidCheckOk, false);

  const stillMissing = decidePid(missing.state, { ok: false });
  assert.equal(stillMissing.events[0].once, true);

  const readable = decidePid(stillMissing.state, { ok: true, pid: 10 });
  assert.equal(readable.events.some((event) => event.recovery && event.kind === 'config_test'), true);
  assert.equal(readable.masterPid, 10);
  assert.equal(readable.events.some((event) => event.kind === 'restart'), false);

  const changed = decidePid(readable.state, { ok: true, pid: 11 });
  assert.equal(changed.events.some((event) => event.kind === 'restart'), true);
  assert.equal(changed.masterPid, 11);
});

test('stall ignores the monitor own requests and a down sample breaks the quiet run', () => {
  const enabled = config({ requestStallEnabled: true, requestStallWindows: 2, ownRequestsPerCycle: 1 });
  let state = initialUrlState();
  let at = 0;
  let requests = 100;
  const step = (delta) => {
    at += 60_000;
    requests += delta;
    const result = decideUrl(state, { type: 'ok', url: URL, sample: sample({ requests }) }, enabled, at);
    state = result.state;
    return kinds(result.events);
  };
  ({ state } = decideUrl(state, { type: 'ok', url: URL, sample: sample({ requests }) }, enabled, at));

  // Only the monitor's own poll: never busy, so never a stall.
  for (let i = 0; i < 4; i += 1) assert.deepEqual(step(1), []);

  assert.deepEqual(step(20), []);
  assert.deepEqual(step(1), []);
  ({ state } = decideUrl(state, { type: 'down', url: URL }, enabled, (at += 60_000)));
  // Two cycles since the last good sample: two own requests are still quiet,
  // and the down sample restarted the consecutive count.
  assert.deepEqual(step(2), ['down']);
  assert.deepEqual(step(1), ['stall']);
});
