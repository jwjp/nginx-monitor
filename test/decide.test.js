import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decideLag,
  decidePid,
  decideProbe,
  decideUrl,
  initialPidState,
  initialUrlState,
  mergeRestarts,
  recoverAfter,
} from '../src/decide.js';

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
    { type: 'ok', url: URL, sample: sample({ active: 100, waiting: 100, reading: 100, writing: 100 }) },
    config(),
    0,
  );
  assert.deepEqual(kinds(decided.events), []);
});

test('reading and writing thresholds alert on the first sample and recover below it', () => {
  const limits = config({ readingConnectionsThreshold: 4, writingConnectionsThreshold: 4 });
  const high = decideUrl(
    initialUrlState(),
    { type: 'ok', url: URL, sample: sample({ reading: 4, writing: 9 }) },
    limits,
    0,
  );
  assert.deepEqual(kinds(high.events), ['reading', 'writing']);
  const low = decideUrl(
    high.state,
    { type: 'ok', url: URL, sample: sample({ reading: 1, writing: 1, requests: 101 }) },
    limits,
    60_000,
  );
  assert.equal(low.events.some((event) => event.kind === 'reading' && event.recovery), true);
  assert.equal(low.events.some((event) => event.kind === 'writing' && event.recovery), true);
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

test('a flapping gauge stays open until enough clear samples in a row', () => {
  const held = config({ activeConnectionsThreshold: 10, recoverAfterSamples: 3 });
  let state = initialUrlState();
  let at = 0;
  let accepts = 100;
  const step = (active) => {
    at += 60_000;
    accepts += 1;
    const result = decideUrl(
      state,
      { type: 'ok', url: URL, sample: sample({ active, accepts, handled: accepts }) },
      held,
      at,
    );
    state = result.state;
    return result.events.filter((event) => event.kind === 'active');
  };

  assert.equal(step(12)[0].recovery, false);
  assert.deepEqual(step(5), []);
  assert.deepEqual(step(5), []);
  // A firing sample inside the hold restarts the clear count.
  assert.equal(step(12)[0].recovery, false);
  assert.equal(state.open.active, true);
  assert.deepEqual(step(5), []);
  assert.deepEqual(step(5), []);
  const recovered = step(5);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].recovery, true);
  assert.equal(state.open.active, false);
});

test('a reopened condition recovers on the next clear sample', () => {
  const held = config({ recoverAfterSamples: 3 });
  let { state } = decideUrl(initialUrlState(), { type: 'down', url: URL }, held, 0);
  for (let i = 1; i <= 3; i += 1) {
    ({ state } = decideUrl(state, { type: 'ok', url: URL, sample: sample() }, held, i * 60_000));
  }
  assert.equal(state.open.down, false);
  // The recovery post failed, so the cycle reopens the condition.
  state.open.down = true;
  const again = decideUrl(state, { type: 'ok', url: URL, sample: sample() }, held, 240_000);
  assert.equal(again.events.some((event) => event.kind === 'down' && event.recovery), true);
});

test('recoverAfter falls back to 1 for a missing or invalid value', () => {
  assert.equal(recoverAfter({}), 1);
  assert.equal(recoverAfter({ recoverAfterSamples: 0 }), 1);
  assert.equal(recoverAfter({ recoverAfterSamples: 4 }), 4);
});

test('a probe recovery waits for the hold', () => {
  const url = 'http://127.0.0.1/health';
  const failed = decideProbe(false, { ok: false, status: 502 }, url, { hold: 2 });
  assert.equal(failed.open, true);
  const first = decideProbe(failed.open, { ok: true, status: 200 }, url, {
    hold: 2,
    clearStreak: failed.clearStreak,
  });
  assert.equal(first.open, true);
  assert.deepEqual(first.events, []);
  const second = decideProbe(first.open, { ok: true, status: 200 }, url, {
    hold: 2,
    clearStreak: first.clearStreak,
  });
  assert.equal(second.open, false);
  assert.equal(second.events[0].recovery, true);
});

test('a pid change is folded into the counter restart of the same cycle', () => {
  const urlRestart = { scope: 'url', kind: 'restart', target: URL, reason: 'counters moved backward' };
  const pidRestart = { scope: 'pid', kind: 'restart', target: 'nginx-pid', reason: 'master pid changed from 1 to 2' };
  const merged = mergeRestarts([urlRestart, pidRestart]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].reason, 'counters moved backward; master pid changed from 1 to 2');

  // Without a counter restart the pid change still posts on its own.
  const alone = mergeRestarts([{ ...pidRestart }]);
  assert.equal(alone.length, 1);
  assert.equal(alone[0].target, 'nginx-pid');
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

test('stall quiet budget follows this URL origin and ignores a larger global count', () => {
  const enabled = config({
    requestStallEnabled: true,
    requestStallWindows: 1,
    ownRequestsByUrl: { [URL]: 1 },
    ownRequestsPerCycle: 5,
  });
  let state = initialUrlState();
  ({ state } = decideUrl(state, { type: 'ok', url: URL, sample: sample({ requests: 10 }) }, enabled, 0));
  const busy = decideUrl(state, { type: 'ok', url: URL, sample: sample({ requests: 12 }) }, enabled, 60_000);
  assert.deepEqual(kinds(busy.events), []);
  assert.equal(busy.state.seenBusySample, true);
  const stall = decideUrl(busy.state, { type: 'ok', url: URL, sample: sample({ requests: 13 }) }, enabled, 120_000);
  assert.deepEqual(kinds(stall.events), ['stall']);
});

test('lag alerts once the skipped count reaches the minimum and recovers at zero', () => {
  assert.deepEqual(decideLag(false, 0, 1).events, []);
  assert.deepEqual(decideLag(false, 3, 0).events, []);
  const open = decideLag(false, 2, 1);
  assert.equal(open.open, true);
  assert.equal(open.events[0].kind, 'lag');
  assert.equal(open.events[0].target, 'nginx-monitor');
  assert.match(open.events[0].reason, /skipped 2/);
  const recovered = decideLag(true, 0, 1);
  assert.equal(recovered.open, false);
  assert.equal(recovered.events[0].recovery, true);
});
