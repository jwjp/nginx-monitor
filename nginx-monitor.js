import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import cron from 'node-cron';
import { isLoopbackHost, loadConfig } from './src/config.js';
import {
  decideConfigTest,
  decidePid,
  decideProbe,
  decideUrl,
  initialPidState,
  initialUrlState,
} from './src/decide.js';
import { readHistoryFile, writeHistory } from './src/history.js';
import { readPidFile, runNginxTest } from './src/nginx-cmd.js';
import { fetchProbe } from './src/probe.js';
import {
  formatAlert,
  gateAlert,
  orderDeliveries,
  queueKey,
  queueUndelivered,
  sendSlack,
} from './src/slack.js';
import { createStatusServer } from './src/status-server.js';
import { fetchStubStatus } from './src/stub-status.js';

export function createContext(config, overrides = {}) {
  return {
    config,
    urlStates: new Map(config.statusUrls.map((url) => [url, initialUrlState()])),
    probeOpen: false,
    configTestOpen: false,
    pidState: initialPidState(),
    sent: {},
    undelivered: {},
    running: false,
    now: () => Date.now(),
    fetchImpl: globalThis.fetch,
    ...overrides,
  };
}

function reopen(ctx, event) {
  if (event.scope === 'url') {
    const state = ctx.urlStates.get(event.url);
    if (state?.open) state.open[event.kind] = true;
    return;
  }
  if (event.scope === 'probe') ctx.probeOpen = true;
  if (event.scope === 'nginx-test') ctx.configTestOpen = true;
  if (event.scope === 'pid') ctx.pidState = { ...ctx.pidState, open: true };
}

export async function runCycle(ctx) {
  if (ctx.running) {
    console.log('skipping cycle; previous cycle is still running');
    return;
  }
  ctx.running = true;
  try {
    await runCycleBody(ctx);
  } finally {
    ctx.running = false;
  }
}

async function runCycleBody(ctx) {
  const at = ctx.now();
  const { config } = ctx;
  const events = [];
  const statuses = [];
  const observations = await Promise.all(config.statusUrls.map(async (url) => {
    const result = await fetchStubStatus(url, {
      timeoutMs: config.statusTimeoutMs,
      fetchImpl: ctx.fetchImpl,
    });
    return { url, ...result };
  }));

  for (const observation of observations) {
    const decided = decideUrl(ctx.urlStates.get(observation.url), observation, config, at);
    ctx.urlStates.set(observation.url, decided.state);
    statuses.push(decided.record);
    events.push(...decided.events);
  }

  let probe = null;
  if (config.probeUrl) {
    const result = await fetchProbe(config.probeUrl, {
      timeoutMs: config.probeTimeoutMs,
      ranges: config.probeAcceptedStatuses,
      fetchImpl: ctx.fetchImpl,
    });
    const decided = decideProbe(ctx.probeOpen, result, config.probeUrl);
    ctx.probeOpen = decided.open;
    probe = { ok: result.ok, status: result.status };
    events.push(...decided.events);
  }

  let configTestOk = null;
  if (config.nginxTestEnabled) {
    const result = await runNginxTest(config.nginxBin, { execFileImpl: ctx.execFileImpl });
    const decided = decideConfigTest(ctx.configTestOpen, result);
    ctx.configTestOpen = decided.open;
    configTestOk = result.ok;
    events.push(...decided.events);
  }

  let pidCheckOk = null;
  let masterPid = null;
  if (config.nginxPidFile) {
    const result = await readPidFile(config.nginxPidFile, ctx.readFileImpl);
    const decided = decidePid(ctx.pidState, result);
    ctx.pidState = decided.state;
    pidCheckOk = decided.pidCheckOk;
    masterPid = decided.masterPid;
    events.push(...decided.events);
  }

  for (const event of events) event.at ??= at;
  ctx.undelivered ??= {};
  const ordered = orderDeliveries(events, ctx.undelivered);
  const holdRecovery = new Set();
  let sentCount = 0;
  let slackUnavailable = false;
  let deferred = 0;
  const deferEvent = (event, key) => {
    if (event.recovery) {
      reopen(ctx, event);
      return;
    }
    ctx.undelivered = queueUndelivered(ctx.undelivered, event);
    holdRecovery.add(key);
  };
  for (const event of ordered) {
    const key = `${event.target}::${event.kind}`;
    if (event.recovery && holdRecovery.has(key)) {
      reopen(ctx, event);
      continue;
    }
    // A late delivery was already decided in an earlier cycle. Its condition
    // may have closed since, so it neither waits on nor restarts the throttle.
    const late = !event.recovery && !event.release && event.at !== at;
    const gated = late
      ? { send: true, sent: ctx.sent }
      : gateAlert(ctx.sent, event, at, config.throttleDurationMs);
    // The condition is closed whether or not Slack hears about it, so the next
    // incident must not be throttled behind an undelivered recovery.
    if (event.release || event.recovery) ctx.sent = gated.sent;
    if (event.release) continue;
    if (!gated.send) continue;
    // After one failed post, the rest wait for the next cycle. Trying each one
    // against a dead webhook would stretch the cycle past the schedule and
    // skip the next samples.
    if (slackUnavailable) {
      deferEvent(event, key);
      deferred += 1;
      continue;
    }
    try {
      await sendSlack(
        config.slackWebhookUrl,
        formatAlert(event, at),
        { timeoutMs: config.slackTimeoutMs, fetchImpl: ctx.fetchImpl },
      );
      ctx.sent = gated.sent;
      delete ctx.undelivered[queueKey(event)];
      sentCount += 1;
      console.log(`alert ${event.recovery ? 'recovered' : event.kind} ${event.target}`);
    } catch {
      console.error(`slack send failed for ${event.kind} ${event.target}`);
      slackUnavailable = true;
      deferEvent(event, key);
    }
  }
  if (deferred > 0) console.error(`slack unavailable; deferred ${deferred} more message(s) to the next cycle`);

  await writeHistory(config.statusLogFile, {
    timestamp: new Date(at).toISOString(),
    statuses,
    probe,
    configTestOk,
    pidCheckOk,
    masterPid,
  }, config.maxHistory, ctx.historyFs);

  if (sentCount > 0) console.log(`sent ${sentCount} slack message(s)`);
}

function logStartup(config) {
  console.log(`schedule ${config.cronSchedule} timezone ${config.cronTimezone}`);
  console.log(`status urls ${config.statusUrls.join(', ')}`);
  const probe = config.probeUrl ? 'on' : 'off';
  const nginxTest = config.nginxTestEnabled ? 'on' : 'off';
  const pid = config.nginxPidFile ? 'on' : 'off';
  const web = config.webEnabled && !config.runOnce ? 'on' : 'off';
  console.log(`probe ${probe} nginx-t ${nginxTest} pid ${pid} web ${web}`);
}

async function listenStatusServer(config) {
  const server = createStatusServer({
    host: config.host,
    token: config.statusToken,
    readHistory: () => readHistoryFile(config.statusLogFile),
  });
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(config.port, config.host, () => {
      server.off('error', onError);
      resolve();
    });
  }).catch((error) => {
    console.error(`status server failed: ${error.message}`);
    process.exit(1);
  });
  server.on('error', (error) => {
    console.error(`status server failed: ${error.message}`);
    process.exit(1);
  });
  const tokenNote = config.statusToken ? ' token-protected' : '';
  console.log(`status server http://${config.host}:${config.port}/status${tokenNote}`);
  if (!config.statusToken && !isLoopbackHost(config.host)) {
    console.warn(`HOST=${config.host} is not loopback. /status stays closed until STATUS_TOKEN is set.`);
  }
  return server;
}

export async function stop({ server, task, ctx, timeoutMs = 5000 } = {}) {
  if (task && typeof task.stop === 'function') {
    task.stop();
  }
  if (server && typeof server.close === 'function') {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  }
  if (ctx && ctx.running) {
    const startWait = Date.now();
    while (ctx.running && Date.now() - startWait < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

export function registerSignalHandlers(state, {
  processObj = process,
  onExit = () => processObj.exit(0),
} = {}) {
  let shuttingDown = false;
  const handler = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`received ${signal}, shutting down`);
    try {
      await stop(state);
    } catch (error) {
      console.error(`shutdown error: ${error.message}`);
    }
    onExit();
  };
  const onSigint = () => handler('SIGINT');
  const onSigterm = () => handler('SIGTERM');
  processObj.on('SIGINT', onSigint);
  processObj.on('SIGTERM', onSigterm);
  return () => {
    processObj.off('SIGINT', onSigint);
    processObj.off('SIGTERM', onSigterm);
  };
}

export async function start(env = process.env, signalOptions = {}) {
  let config;
  try {
    config = loadConfig(env);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  logStartup(config);
  let server = null;
  if (!config.runOnce && config.webEnabled) {
    server = await listenStatusServer(config);
  }

  const ctx = createContext(config);
  try {
    await runCycle(ctx);
  } catch (error) {
    console.error(`cycle failed: ${error.message}`);
    if (config.runOnce) process.exit(1);
  }
  if (config.runOnce) process.exit(0);

  const task = cron.schedule(config.cronSchedule, () => {
    runCycle(ctx).catch((error) => {
      console.error(`cycle failed: ${error.message}`);
    });
  }, {
    timezone: config.cronTimezone,
    noOverlap: true,
  });

  const unregister = registerSignalHandlers({ server, task, ctx }, signalOptions);
  return { server, task, ctx, unregister };
}

function invokedDirectly() {
  const entry = fileURLToPath(import.meta.url);
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(entry);
}

if (invokedDirectly()) {
  dotenv.config();
  start().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
