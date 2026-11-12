import cron from 'node-cron';
import { parseAcceptedStatuses } from './probe.js';

export const MAX_STATUS_URLS = 8;

export const DEFAULTS = {
  statusUrl: 'http://127.0.0.1/nginx_status',
  allowRemoteStatus: false,
  statusTimeoutMs: 5000,
  cronSchedule: '* * * * *',
  cronTimezone: 'UTC',
  activeConnectionsThreshold: 0,
  waitingConnectionsThreshold: 0,
  droppedConnectionsMin: 1,
  requestStallEnabled: false,
  requestStallWindows: 5,
  readingConnectionsThreshold: 0,
  writingConnectionsThreshold: 0,
  skippedCyclesMin: 1,
  probeTimeoutMs: 5000,
  allowRemoteProbe: false,
  probeAcceptedStatuses: '200-399',
  nginxTestEnabled: false,
  nginxBin: 'nginx',
  throttleDurationMs: 900000,
  slackTimeoutMs: 10000,
  runOnce: false,
  webEnabled: true,
  host: '127.0.0.1',
  port: 3032,
  statusLogFile: './status-history.json',
  maxHistory: 1440,
};

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function readRaw(env, name) {
  if (!Object.prototype.hasOwnProperty.call(env, name)) return undefined;
  const value = env[name];
  if (value === undefined || value === null) return undefined;
  return String(value).trim();
}

function readString(env, name, fallback) {
  const value = readRaw(env, name);
  if (value === undefined || value === '') return fallback;
  return value;
}

function readBoolean(env, name, fallback) {
  const value = readRaw(env, name);
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function readNumber(env, name, fallback) {
  const value = readRaw(env, name);
  if (value === undefined || value === '') return fallback;
  if (!/^\d+(\.\d+)?$/.test(value)) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return number;
}

function readPort(env, fallback) {
  const port = readNumber(env, 'PORT', fallback);
  return Number.isInteger(port) && port <= 65535 ? port : fallback;
}

// setTimeout treats 0 as immediate and anything above 2^31-1 as 1 ms, and
// either one would turn every check into a timeout.
export const MAX_TIMEOUT_MS = 2_147_483_647;

function readTimeout(env, name, fallback) {
  const ms = readNumber(env, name, fallback);
  return ms > 0 && ms <= MAX_TIMEOUT_MS ? ms : fallback;
}

// Compare URLs the way fetch sees them, so `:80`, host case, or a missing
// path does not poll the same page twice.
function normalizeUrl(value) {
  try {
    return new URL(value).href;
  } catch {
    return value;
  }
}

export function isLoopbackHost(host) {
  const normalized = String(host).replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

export function isSlackWebhook(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname === 'hooks.slack.com'
      && url.pathname.startsWith('/services/')
      && url.username === ''
      && url.password === '';
  } catch {
    return false;
  }
}

export function validateFetchUrl(value, { allowRemote, label }) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${label} is not a valid URL.`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new ConfigError(`${label} must not include a username or password.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`${label} must use http or https.`);
  }
  if (!isLoopbackHost(url.hostname) && !allowRemote) {
    throw new ConfigError(`${label} host must be loopback unless the allow flag is set.`);
  }
  return value;
}

function readStatusUrls(env) {
  const primary = readString(env, 'STATUS_URL', DEFAULTS.statusUrl);
  const extras = readString(env, 'STATUS_URLS', '');
  const items = [primary, ...extras.split(',')];
  const urls = [];
  for (const item of items) {
    const raw = item.trim();
    if (raw === '') continue;
    const url = normalizeUrl(raw);
    if (urls.includes(url)) continue;
    urls.push(url);
  }
  if (urls.length === 0) {
    throw new ConfigError('STATUS_URL is required.');
  }
  if (urls.length > MAX_STATUS_URLS) {
    throw new ConfigError(`At most ${MAX_STATUS_URLS} status URLs are allowed.`);
  }
  return urls;
}

// One NGINX shares a request counter across every fetch to the same origin.
// A different origin has a different counter, so those fetches are not this URL's quiet budget.
export function ownRequestCounts(statusUrls, probeUrl) {
  const perOrigin = new Map();
  const add = (value) => {
    const origin = new URL(value).origin;
    perOrigin.set(origin, (perOrigin.get(origin) ?? 0) + 1);
  };
  for (const url of statusUrls) add(url);
  if (probeUrl) add(probeUrl);
  const byUrl = {};
  for (const url of statusUrls) byUrl[url] = perOrigin.get(new URL(url).origin);
  return byUrl;
}

function assertTimezone(value) {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
  } catch {
    throw new ConfigError(`CRON_TIMEZONE is not a valid time zone: ${value}`);
  }
}

function normalizeHost(host) {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

export function loadConfig(env) {
  const slackWebhookUrl = readString(env, 'SLACK_WEBHOOK_URL', '');
  if (!isSlackWebhook(slackWebhookUrl)) {
    throw new ConfigError('SLACK_WEBHOOK_URL must be an https://hooks.slack.com/services/ URL.');
  }

  const allowRemoteStatus = readBoolean(env, 'ALLOW_REMOTE_STATUS', DEFAULTS.allowRemoteStatus);
  const statusUrls = readStatusUrls(env);
  for (const url of statusUrls) {
    validateFetchUrl(url, { allowRemote: allowRemoteStatus, label: 'status URL' });
  }

  const cronSchedule = readString(env, 'CRON_SCHEDULE', DEFAULTS.cronSchedule);
  // Five fields only: node-cron also accepts a seconds field, which would
  // let a schedule poll NGINX more than once a minute.
  const fields = cronSchedule.split(/\s+/);
  let cronOk = false;
  try {
    cronOk = fields.length === 5 && cron.validate(cronSchedule) === true;
  } catch {
    cronOk = false;
  }
  if (!cronOk) {
    throw new ConfigError(`CRON_SCHEDULE is invalid: ${cronSchedule}`);
  }
  const cronTimezone = readString(env, 'CRON_TIMEZONE', DEFAULTS.cronTimezone);
  assertTimezone(cronTimezone);

  const allowRemoteProbe = readBoolean(env, 'ALLOW_REMOTE_PROBE', DEFAULTS.allowRemoteProbe);
  const probeRaw = readString(env, 'PROBE_URL', '');
  const probeUrl = probeRaw === ''
    ? null
    : validateFetchUrl(probeRaw, { allowRemote: allowRemoteProbe, label: 'PROBE_URL' });

  const probeSpec = readString(env, 'PROBE_ACCEPTED_STATUSES', DEFAULTS.probeAcceptedStatuses);
  let probeAcceptedStatuses;
  try {
    probeAcceptedStatuses = parseAcceptedStatuses(probeSpec);
  } catch {
    throw new ConfigError('PROBE_ACCEPTED_STATUSES must be a status, a list, or a range.');
  }

  const ownRequestsByUrl = ownRequestCounts(statusUrls, probeUrl);
  const nginxPidRaw = readString(env, 'NGINX_PID_FILE', '');
  const host = normalizeHost(readString(env, 'HOST', DEFAULTS.host));

  return {
    slackWebhookUrl,
    statusUrls,
    allowRemoteStatus,
    statusTimeoutMs: readTimeout(env, 'STATUS_TIMEOUT_MS', DEFAULTS.statusTimeoutMs),
    cronSchedule,
    cronTimezone,
    activeConnectionsThreshold: readNumber(env, 'ACTIVE_CONNECTIONS_THRESHOLD', DEFAULTS.activeConnectionsThreshold),
    waitingConnectionsThreshold: readNumber(env, 'WAITING_CONNECTIONS_THRESHOLD', DEFAULTS.waitingConnectionsThreshold),
    droppedConnectionsMin: readNumber(env, 'DROPPED_CONNECTIONS_MIN', DEFAULTS.droppedConnectionsMin),
    requestStallEnabled: readBoolean(env, 'REQUEST_STALL_ENABLED', DEFAULTS.requestStallEnabled),
    requestStallWindows: readNumber(env, 'REQUEST_STALL_WINDOWS', DEFAULTS.requestStallWindows),
    readingConnectionsThreshold: readNumber(env, 'READING_CONNECTIONS_THRESHOLD', DEFAULTS.readingConnectionsThreshold),
    writingConnectionsThreshold: readNumber(env, 'WRITING_CONNECTIONS_THRESHOLD', DEFAULTS.writingConnectionsThreshold),
    skippedCyclesMin: readNumber(env, 'SKIPPED_CYCLES_MIN', DEFAULTS.skippedCyclesMin),
    ownRequestsByUrl,
    probeUrl,
    probeTimeoutMs: readTimeout(env, 'PROBE_TIMEOUT_MS', DEFAULTS.probeTimeoutMs),
    allowRemoteProbe,
    probeAcceptedStatuses,
    nginxTestEnabled: readBoolean(env, 'NGINX_TEST_ENABLED', DEFAULTS.nginxTestEnabled),
    nginxBin: readString(env, 'NGINX_BIN', DEFAULTS.nginxBin),
    nginxPidFile: nginxPidRaw === '' ? null : nginxPidRaw,
    throttleDurationMs: readNumber(env, 'THROTTLE_DURATION_MS', DEFAULTS.throttleDurationMs),
    slackTimeoutMs: readTimeout(env, 'SLACK_TIMEOUT_MS', DEFAULTS.slackTimeoutMs),
    runOnce: readBoolean(env, 'RUN_ONCE', DEFAULTS.runOnce),
    webEnabled: readBoolean(env, 'WEB_ENABLED', DEFAULTS.webEnabled),
    host,
    port: readPort(env, DEFAULTS.port),
    statusLogFile: readString(env, 'STATUS_LOG_FILE', DEFAULTS.statusLogFile),
    maxHistory: readNumber(env, 'MAX_HISTORY', DEFAULTS.maxHistory),
    statusToken: readString(env, 'STATUS_TOKEN', ''),
  };
}
