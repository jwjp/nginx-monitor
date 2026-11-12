import { diffSamples, elapsedSeconds } from './stub-status.js';
import { stripUserinfo } from './probe.js';

export function initialUrlState() {
  return {
    lastGood: null,
    seenBusySample: false,
    quietSamples: 0,
    missedCycles: 0,
    open: {
      down: false,
      bad_status_page: false,
      dropped: false,
      active: false,
      waiting: false,
      reading: false,
      writing: false,
      stall: false,
    },
  };
}

function cloneState(state) {
  return {
    lastGood: state.lastGood ? { ...state.lastGood } : null,
    seenBusySample: state.seenBusySample,
    quietSamples: state.quietSamples,
    missedCycles: state.missedCycles,
    open: { ...state.open },
  };
}

function alert(events, fields) {
  events.push({ recovery: false, release: false, once: false, ...fields });
}

function recover(events, fields) {
  events.push({ recovery: true, release: false, once: false, ...fields });
}

function release(next, events, kind, target, url) {
  if (!next.open[kind]) return;
  events.push({
    scope: 'url',
    url,
    kind,
    target,
    recovery: false,
    release: true,
    once: false,
    reason: '',
  });
  next.open[kind] = false;
}

function setFailure(next, events, kind, target, url, reason, extra = {}) {
  alert(events, { scope: 'url', url, kind, target, reason, ...extra });
  next.open[kind] = true;
}

function clearFailure(next, events, kind, target, url, reason) {
  if (!next.open[kind]) return;
  recover(events, { scope: 'url', url, kind, target, reason });
  next.open[kind] = false;
}

function evaluateGauges(next, events, counts, config, target, url) {
  evaluateGauge(next, events, {
    kind: 'active',
    threshold: config.activeConnectionsThreshold,
    value: counts.active,
    label: 'active connections',
    target,
    url,
  });
  evaluateGauge(next, events, {
    kind: 'waiting',
    threshold: config.waitingConnectionsThreshold,
    value: counts.waiting,
    label: 'waiting connections',
    target,
    url,
  });
  evaluateGauge(next, events, {
    kind: 'reading',
    threshold: config.readingConnectionsThreshold,
    value: counts.reading,
    label: 'reading connections',
    target,
    url,
  });
  evaluateGauge(next, events, {
    kind: 'writing',
    threshold: config.writingConnectionsThreshold,
    value: counts.writing,
    label: 'writing connections',
    target,
    url,
  });
}

function evaluateGauge(next, events, { kind, threshold, value, label, target, url }) {
  const firing = threshold > 0 && value >= threshold;
  if (firing) {
    setFailure(next, events, kind, target, url, `${label} ${value} reached ${threshold}`);
    return;
  }
  clearFailure(next, events, kind, target, url, `${label} ${value} are below ${threshold}`);
}

// Every stub_status fetch and every probe is itself counted in `requests`, so
// a delta at or below the monitor's own traffic means no outside request.
function ownRequests(next, config, url) {
  const table = config.ownRequestsByUrl;
  const perCycle = table && Object.prototype.hasOwnProperty.call(table, url)
    ? table[url]
    : (config.ownRequestsPerCycle ?? 0);
  return perCycle * (next.missedCycles + 1);
}

function evaluateStall(next, events, requestsDelta, config, target, url) {
  if (!config.requestStallEnabled) {
    clearFailure(next, events, 'stall', target, url, 'requests are moving');
    next.quietSamples = 0;
    return;
  }
  if (requestsDelta > ownRequests(next, config, url)) {
    next.seenBusySample = true;
    next.quietSamples = 0;
    clearFailure(next, events, 'stall', target, url, 'requests are moving');
    return;
  }
  if (next.seenBusySample) {
    next.quietSamples += 1;
    if (config.requestStallWindows > 0 && next.quietSamples >= config.requestStallWindows) {
      setFailure(
        next,
        events,
        'stall',
        target,
        url,
        `no outside requests for ${next.quietSamples} samples`,
      );
    }
  }
}

function countsOf(sample) {
  return {
    active: sample.active,
    accepts: sample.accepts,
    handled: sample.handled,
    requests: sample.requests,
    reading: sample.reading,
    writing: sample.writing,
    waiting: sample.waiting,
  };
}

export function decideUrl(state, observation, config, at) {
  const next = cloneState(state);
  const events = [];
  const target = observation.url;
  const url = observation.url;

  if (observation.type === 'down' || observation.type === 'bad_status_page') {
    next.quietSamples = 0;
    if (next.lastGood) next.missedCycles += 1;
  }

  if (observation.type === 'down') {
    release(next, events, 'bad_status_page', target, url);
    setFailure(next, events, 'down', target, url, 'stub_status unreachable');
    return { state: next, events, record: { url, state: 'down', restart: false } };
  }

  if (observation.type === 'bad_status_page') {
    release(next, events, 'down', target, url);
    setFailure(next, events, 'bad_status_page', target, url, 'stub_status page was not recognized');
    return { state: next, events, record: { url, state: 'bad_status_page', restart: false } };
  }

  clearFailure(next, events, 'down', target, url, 'stub_status is reachable');
  clearFailure(next, events, 'bad_status_page', target, url, 'stub_status page is valid');

  const counts = countsOf(observation.sample);
  if (!next.lastGood) {
    next.lastGood = { ...counts, at };
    evaluateGauges(next, events, counts, config, target, url);
    return {
      state: next,
      events,
      record: { url, state: 'ok', restart: false, ...counts, elapsedSeconds: null, deltas: null },
    };
  }

  const diff = diffSamples(next.lastGood, counts);
  const elapsed = elapsedSeconds(next.lastGood.at, at);
  if (diff.restart) {
    alert(events, {
      scope: 'url',
      url,
      kind: 'restart',
      target,
      reason: 'counters moved backward',
    });
    release(next, events, 'dropped', target, url);
    release(next, events, 'stall', target, url);
    next.quietSamples = 0;
    next.missedCycles = 0;
    next.lastGood = { ...counts, at };
    evaluateGauges(next, events, counts, config, target, url);
    return {
      state: next,
      events,
      record: {
        url,
        state: 'ok',
        restart: true,
        ...counts,
        elapsedSeconds: elapsed,
        deltas: null,
      },
    };
  }

  if (config.droppedConnectionsMin > 0 && diff.dropped >= config.droppedConnectionsMin) {
    setFailure(next, events, 'dropped', target, url, `dropped ${diff.dropped} connections`);
  } else {
    clearFailure(
      next,
      events,
      'dropped',
      target,
      url,
      `dropped connections fell below ${config.droppedConnectionsMin}`,
    );
  }

  evaluateGauges(next, events, counts, config, target, url);
  evaluateStall(next, events, diff.requests, config, target, url);
  next.missedCycles = 0;
  next.lastGood = { ...counts, at };

  return {
    state: next,
    events,
    record: {
      url,
      state: 'ok',
      restart: false,
      ...counts,
      elapsedSeconds: elapsed,
      deltas: {
        accepts: diff.accepts,
        handled: diff.handled,
        requests: diff.requests,
        dropped: diff.dropped,
      },
    },
  };
}

export function decideLag(open, skipped, min) {
  if (min > 0 && skipped >= min) {
    return {
      open: true,
      events: [{
        scope: 'monitor',
        kind: 'lag',
        target: 'nginx-monitor',
        recovery: false,
        release: false,
        once: false,
        reason: `skipped ${skipped} cycle(s) because the previous cycle was still running`,
      }],
    };
  }
  if (open) {
    return {
      open: false,
      events: [{
        scope: 'monitor',
        kind: 'lag',
        target: 'nginx-monitor',
        recovery: true,
        release: false,
        once: false,
        reason: 'cycles are keeping up',
      }],
    };
  }
  return { open: false, events: [] };
}

export function decideProbe(open, result, url) {
  const target = stripUserinfo(url);
  const statusText = result.status == null ? 'error' : String(result.status);
  const reason = `${statusText} ${target}`;
  if (result.ok) {
    if (!open) return { open: false, events: [] };
    return {
      open: false,
      events: [recoverEvent('probe', target, reason)],
    };
  }
  return {
    open: true,
    events: [{
      scope: 'probe',
      kind: 'probe',
      target,
      recovery: false,
      release: false,
      once: false,
      reason,
    }],
  };
}

function recoverEvent(scope, target, reason) {
  return {
    scope,
    kind: scope === 'probe' ? 'probe' : 'config_test',
    target,
    recovery: true,
    release: false,
    once: false,
    reason,
  };
}

export function decideConfigTest(open, result) {
  const target = 'nginx';
  if (result.ok) {
    if (!open) return { open: false, events: [] };
    return {
      open: false,
      events: [{
        scope: 'nginx-test',
        kind: 'config_test',
        target,
        recovery: true,
        release: false,
        once: false,
        reason: 'nginx -t passed',
      }],
    };
  }
  const reason = result.stderr ? `nginx -t failed: ${result.stderr}` : 'nginx -t failed';
  return {
    open: true,
    events: [{
      scope: 'nginx-test',
      kind: 'config_test',
      target,
      recovery: false,
      release: false,
      once: false,
      reason,
    }],
  };
}

export function initialPidState() {
  return { pid: null, open: false };
}

export function decidePid(state, result) {
  const target = 'nginx-pid';
  if (!result.ok) {
    return {
      state: { pid: state.pid, open: true },
      pidCheckOk: false,
      masterPid: null,
      events: [{
        scope: 'pid',
        kind: 'config_test',
        target,
        recovery: false,
        release: false,
        once: true,
        reason: 'pid file is missing or malformed',
      }],
    };
  }

  const events = [];
  if (state.open) {
    events.push({
      scope: 'pid',
      kind: 'config_test',
      target,
      recovery: true,
      release: false,
      once: false,
      reason: 'pid file is readable',
    });
  }
  if (state.pid !== null && state.pid !== result.pid) {
    events.push({
      scope: 'pid',
      kind: 'restart',
      target,
      recovery: false,
      release: false,
      once: false,
      reason: `master pid changed from ${state.pid} to ${result.pid}`,
    });
  }
  return {
    state: { pid: result.pid, open: false },
    pidCheckOk: true,
    masterPid: result.pid,
    events,
  };
}
