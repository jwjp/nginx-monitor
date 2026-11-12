import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfigError, loadConfig, ownRequestCounts, validateFetchUrl } from '../src/config.js';

const WEBHOOK = 'https://hooks.slack.com/services/T/B/X';

function env(overrides = {}) {
  return { SLACK_WEBHOOK_URL: WEBHOOK, ...overrides };
}

test('accepts loopback status URLs and rejects a public host, userinfo, and a remote probe', () => {
  assert.equal(loadConfig(env({ STATUS_URL: 'http://127.0.0.1/nginx_status' })).statusUrls[0], 'http://127.0.0.1/nginx_status');
  assert.equal(loadConfig(env({ STATUS_URL: 'http://localhost/nginx_status' })).statusUrls[0], 'http://localhost/nginx_status');
  assert.equal(loadConfig(env({ STATUS_URL: 'http://[::1]/nginx_status' })).statusUrls[0], 'http://[::1]/nginx_status');

  assert.throws(
    () => loadConfig(env({ STATUS_URL: 'http://example.com/nginx_status' })),
    ConfigError,
  );
  assert.throws(
    () => validateFetchUrl('http://user:secret@127.0.0.1/nginx_status', { allowRemote: true, label: 'status URL' }),
    (error) => error instanceof ConfigError && !error.message.includes('secret'),
  );
  assert.equal(
    loadConfig(env({
      STATUS_URL: 'https://example.com/nginx_status',
      ALLOW_REMOTE_STATUS: 'true',
    })).statusUrls[0],
    'https://example.com/nginx_status',
  );
  assert.throws(
    () => loadConfig(env({
      PROBE_URL: 'https://example.com/health',
      ALLOW_REMOTE_STATUS: 'true',
    })),
    ConfigError,
  );
  assert.equal(
    loadConfig(env({
      PROBE_URL: 'https://example.com/health',
      ALLOW_REMOTE_PROBE: 'yes',
    })).probeUrl,
    'https://example.com/health',
  );
});

test('parses booleans, numbers, duplicate URLs, and the schedule', () => {
  const config = loadConfig(env({
    WEB_ENABLED: 'YES',
    RUN_ONCE: '0',
    REQUEST_STALL_ENABLED: '',
    PORT: 'nope',
    STATUS_URLS: 'http://127.0.0.1/nginx_status, http://127.0.0.1/other',
    CRON_SCHEDULE: '*/1 8-19 * * 1-5',
    CRON_TIMEZONE: 'America/New_York',
  }));
  assert.equal(config.webEnabled, true);
  assert.equal(config.runOnce, false);
  assert.equal(config.requestStallEnabled, false);
  assert.equal(config.port, 3032);
  assert.deepEqual(config.statusUrls, ['http://127.0.0.1/nginx_status', 'http://127.0.0.1/other']);
  assert.equal(config.cronSchedule, '*/1 8-19 * * 1-5');
  assert.equal(config.cronTimezone, 'America/New_York');
  assert.equal(config.droppedConnectionsMin, 1);
});

test('rejects an invalid webhook, too many URLs, a bad cron expression, and a bad time zone', () => {
  assert.throws(() => loadConfig(env({ SLACK_WEBHOOK_URL: 'http://hooks.slack.com/services/T/B/X' })), ConfigError);
  assert.throws(() => loadConfig(env({ SLACK_WEBHOOK_URL: 'https://example.com/services/T/B/X' })), ConfigError);
  const urls = Array.from({ length: 8 }, (_, index) => `http://127.0.0.1/${index}`).join(',');
  assert.throws(() => loadConfig(env({ STATUS_URLS: urls })), ConfigError);
  assert.throws(() => loadConfig(env({ CRON_SCHEDULE: '* * * *' })), ConfigError);
  assert.throws(() => loadConfig(env({ CRON_SCHEDULE: '* * * * * *' })), ConfigError);
  assert.throws(() => loadConfig(env({ CRON_TIMEZONE: 'Not/AZone' })), ConfigError);
});

test('accepts a finite decimal number and keeps PORT an integer port', () => {
  const config = loadConfig(env({
    THROTTLE_DURATION_MS: '1.5',
    STATUS_TIMEOUT_MS: '-1',
    PORT: '3032.5',
  }));
  assert.equal(config.throttleDurationMs, 1.5);
  assert.equal(config.statusTimeoutMs, 5000);
  assert.equal(config.port, 3032);
  assert.equal(loadConfig(env({ PORT: '70000' })).port, 3032);
  assert.equal(loadConfig(env({ PORT: '8080' })).port, 8080);
});

test('counts the monitor own requests per status origin', () => {
  const same = loadConfig(env({
    STATUS_URLS: 'http://127.0.0.1/a',
    PROBE_URL: 'http://127.0.0.1/health',
  }));
  assert.equal(same.ownRequestsByUrl['http://127.0.0.1/nginx_status'], 3);
  assert.equal(same.ownRequestsByUrl['http://127.0.0.1/a'], 3);

  const split = ownRequestCounts(
    ['http://127.0.0.1/nginx_status', 'http://127.0.0.1:8080/nginx_status'],
    'http://127.0.0.1:8080/health',
  );
  assert.equal(split['http://127.0.0.1/nginx_status'], 1);
  assert.equal(split['http://127.0.0.1:8080/nginx_status'], 2);
  assert.equal(loadConfig(env()).readingConnectionsThreshold, 0);
  assert.equal(loadConfig(env()).writingConnectionsThreshold, 0);
  assert.equal(loadConfig(env()).skippedCyclesMin, 1);
  assert.equal(loadConfig(env({ SKIPPED_CYCLES_MIN: '0' })).skippedCyclesMin, 0);
});

test('rejects a six-field cron expression', () => {
  assert.throws(() => loadConfig(env({ CRON_SCHEDULE: '*/10 * * * * *' })), ConfigError);
});

test('deduplicates status URLs the way fetch sees them', () => {
  const config = loadConfig(env({
    STATUS_URL: 'http://127.0.0.1/nginx_status',
    STATUS_URLS: 'http://127.0.0.1:80/nginx_status,http://LOCALHOST/nginx_status,http://localhost/nginx_status',
  }));
  assert.deepEqual(config.statusUrls, ['http://127.0.0.1/nginx_status', 'http://localhost/nginx_status']);
});

test('a zero or overflowing timeout uses the default', () => {
  const config = loadConfig(env({
    STATUS_TIMEOUT_MS: '0',
    PROBE_TIMEOUT_MS: '2147483648',
    SLACK_TIMEOUT_MS: '2500',
  }));
  assert.equal(config.statusTimeoutMs, 5000);
  assert.equal(config.probeTimeoutMs, 5000);
  assert.equal(config.slackTimeoutMs, 2500);
});
