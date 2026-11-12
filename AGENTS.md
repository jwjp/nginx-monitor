# AGENTS.md

Instructions for coding agents working in this repository. Humans can read it too.

Korean review copy: [AGENTS.ko.md](AGENTS.ko.md). If the two files disagree, this English file wins. Update both in the same commit.

English is the language of code, commits, issues, pull requests, and this file. Korean copies exist so the maintainer can review them.

The behavior contract for humans is [README.md](README.md). Keep the README, the Korean README, and `.env.example` aligned with this file.

## Project

nginx-monitor is a small Slack watchdog for one open-source NGINX host, or a short list of local `stub_status` URLs on that host. It is the NGINX sibling of [pm2-monitor](https://github.com/jwjp/pm2-monitor).

pm2-monitor works because `pm2 jlist` is a local structured status API. The matching NGINX API is the `stub_status` text page on loopback. Read that page on a cron schedule, compare it with the previous sample, and post a throttled Slack message.

Distribution is this git repository. Do not publish the package to npm unless the maintainer asks.

## Do not build these

These were considered and rejected. Do not reopen them without the maintainer asking.

- A Prometheus exporter, a time-series database, Grafana dashboards, or Alertmanager rules. Point operators who already have Prometheus at nginx-prometheus-exporter.
- Access-log or error-log tailing. Logs contain request URIs and client addresses. Do not add a parser, a shipper, or an option that forwards raw log lines to Slack.
- The NGINX Plus status API, `ngx_http_api_module`, or commercial-only metrics.
- A requirement on PM2. `npm start` runs `node nginx-monitor.js`. systemd is the documented supervisor. A PM2 ecosystem file may exist only as an optional example.
- Automatic `reload`, `restart`, `nginx -s ...`, or service-manager remediation. The process alerts. It does not control NGINX.
- A web dashboard, a user account system, or a plugin system.
- The pm2-monitor default schedule of weekday business hours in `America/New_York`. The default here is `* * * * *` in `UTC`.
- Windows service support. HTTP checks can run wherever Node runs. Document Linux as the supported operating system. Do not add a Windows service wrapper.
- Copying axios in from pm2-monitor. Use the global `fetch` in Node 22.

## Runtime layout

Keep the implementation inside this layout. Do not add a framework around it.

```text
nginx-monitor.js          # entry: load config, start timer, run one cycle
src/config.js             # environment parsing and validation
src/stub-status.js        # fetch, parse, and counter deltas
src/decide.js             # pure alert decisions
src/probe.js              # optional HTTP probe
src/nginx-cmd.js          # optional nginx -t and pid-file read
src/slack.js              # webhook payload and throttle
src/history.js            # status snapshot file
src/status-server.js      # GET /healthz and GET /status
test/*.test.js            # node:test, no live NGINX and no live Slack
examples/nginx-stub-status.conf
examples/nginx-monitor.service
examples/ecosystem.config.cjs
```

`package.json` is an application manifest, `"private": true`, `"type": "module"`, `"engines.node": ">=22"`. Dependencies are `dotenv` and `node-cron` only, until a task cannot be done with Node 22 itself. `npm start` is `node nginx-monitor.js`. `npm test` is `node --test`. Add a `check` script that syntax-checks the entry file and `src`. Add Dependabot for npm and GitHub Actions when those files exist.

Alert decisions, `stub_status` parsing, URL checks, throttle transitions, and token comparison are pure functions with unit tests. Network, process, and filesystem calls stay in thin wrappers.

## Cycle

1. Validate configuration. On failure, log a short message and exit 1. Do not start the timer.
2. Unless `RUN_ONCE` is set, start the status server when `WEB_ENABLED` is true.
3. Take one sample immediately, then schedule the cycle.
4. A cycle fetches every status URL, updates deltas, optionally probes, optionally runs `nginx -t`, optionally reads the pid file, decides alerts, sends Slack, and appends one history snapshot.
5. A finished cycle is success even when NGINX is down. Exit 1 only for invalid configuration, an uncaught exception, or a `RUN_ONCE` cycle that throws. `RUN_ONCE` still exits 0 when the cycle completes and alerts were sent.
6. Log the schedule, time zone, status URLs, and which optional checks are enabled. Never log the webhook, the status token, or a URL userinfo field.

## stub_status

Fetch with `GET`, `redirect: "manual"`, a timeout of `STATUS_TIMEOUT_MS`, and a body cap of 64 KiB. Treat a redirect, a non-200 response, a timeout, a network error, or an oversized body as `down`.

The official body is:

```text
Active connections: 291
server accepts handled requests
 16630948 16630948 31070465
Reading: 6 Writing: 179 Waiting: 106
```

Parse these three facts and nothing else:

- `Active connections: <integer>`
- the first line of three integers after the `server accepts handled requests` header, in the order accepts, handled, requests
- `Reading: <integer> Writing: <integer> Waiting: <integer>`

Accept extra whitespace. Reject any other body as `bad_status_page`, which is a different alert from `down`.

The first good sample for a URL is a baseline. It produces no dropped-connection or stall alert. Later samples use integer deltas against the previous good sample and the elapsed seconds.

If any cumulative counter moves backward, or the new accepts value is less than the previous one, NGINX restarted or the counters reset. Emit `restart`, store the new sample as the baseline, and do not treat the jump as dropped connections.

`dropped = delta(accepts) - delta(handled)`. Alert `dropped` when `dropped >= DROPPED_CONNECTIONS_MIN` and the minimum is greater than 0.

Alert `active` when the threshold is greater than 0 and `active >= threshold`. Alert `waiting` the same way. Reading and writing are stored in history and are not alert conditions in v1.

`REQUEST_STALL_ENABLED` defaults to false. When it is true, alert only after `REQUEST_STALL_WINDOWS` consecutive good samples whose request delta is 0, and only after this process has already seen a sample with a positive request delta. A quiet site must not alert at startup.

Track each status URL independently. `STATUS_URL` is required. `STATUS_URLS` adds more. Deduplicate by URL. A practical cap is 8 URLs. Fail validation above that.

## Probe, config test, and pid

`PROBE_URL` empty means the probe is off. When set, `GET` it with `redirect: "manual"`, the probe timeout, and no stored response body. A redirect or a transport error is a probe failure. Compare the status with `PROBE_ACCEPTED_STATUSES`: a single code, a comma-separated list, or an inclusive range such as `200-399`. The Slack text includes the status code and the URL with userinfo removed. It does not include the body.

`NGINX_TEST_ENABLED` defaults to false. When true, run `execFile(NGINX_BIN, ["-t"])` with an argument array and a timeout. Never use a shell string. Success is exit code 0. `nginx -t` writes "syntax is ok" to stderr on success. Ignore stderr on success. On failure, a Slack message may include stderr trimmed to 300 characters. The history file stores only `ok: false`.

`NGINX_PID_FILE` empty means the pid check is off. When set, read the file and accept a single integer. A change from the previous pid emits `restart`. A missing or malformed file emits one configuration alert. Do not signal the process.

## URL guard

Apply this check to every status URL and every probe URL before fetching.

- Protocol is `http:` or `https:`.
- No username or password in the URL.
- Hostname is `localhost`, `127.0.0.1`, or `::1`, including bracketed IPv6.
- Any other host is rejected unless `ALLOW_REMOTE_STATUS` or `ALLOW_REMOTE_PROBE` is true for that kind of URL.
- The allow flag does not permit redirects and does not permit userinfo.

Invalid configuration exits 1 before the first fetch.

## Slack

Accept only an `https` URL whose host is `hooks.slack.com` and whose path starts with `/services/`.

Send one message per alert event. Use a short header prefixed with `[nginx]`, the target label, the UTC timestamp, and the reason. Do not include the webhook URL.

Throttle key is `${target}::${kind}`. While a condition remains true, skip a send when the same key was sent inside `THROTTLE_DURATION_MS`. A recovery for that target and kind deletes the key, so a later incident sends immediately. Recovery messages are not throttled away.

Kinds are `down`, `bad_status_page`, `dropped`, `active`, `waiting`, `stall`, `probe`, `config_test`, and `restart`. Use a stable target label derived from the URL, not from response data.

Slack failure is logged and does not crash the cycle. The history snapshot still records the sample.

## Status server

Match the pm2-monitor authorization behavior. Reimplement it here. Do not import pm2-monitor as a dependency.

- Bind `HOST` and `PORT`. Default `127.0.0.1` and `3032`.
- `GET /healthz` returns `{ "ok": true }` with no NGINX data and no token check.
- `GET /status` returns the history JSON.
- An empty `STATUS_TOKEN` authorizes `/status` only when `HOST` is `127.0.0.1`, `::1`, or `localhost`. Any other host with an empty token answers 401 for `/status`.
- A configured token is compared as `Authorization: Bearer <token>` only. Hash both the header value and the expected value with SHA-256, then compare the digests with `timingSafeEqual`. Do not accept the token in a query string, a cookie, or a custom header.
- Other methods and paths answer 404.
- Responses set `Cache-Control: no-store`.
- Write history to a temporary file in the same directory, then rename it over `STATUS_LOG_FILE`. Keep at most `MAX_HISTORY` snapshots, newest first.
- A history snapshot contains the timestamp, per-URL counts, deltas, probe outcome booleans and status codes, config-test and pid-check booleans, and the master pid when known. It does not contain the webhook, the token, response bodies, stderr, request URIs, or client addresses.

## Configuration parsing

Read `.env` through `dotenv` without overriding variables that are already set.

- Strings are trimmed. An empty string uses the default.
- Lists split on commas, then trim, then drop empty items.
- Booleans accept `1`, `true`, `yes`, and `on`, case-insensitive. Anything else set in the environment is false. An unset variable uses the default.
- Numbers must be finite and greater than or equal to 0. Anything else uses the default, except a required URL.
- Validate the cron expression with `cron.validate` before starting.

Defaults are the values in [.env.example](.env.example) and the table in the README. Do not invent a second set.

## Tests

Use `node:test` and `node:assert/strict`. No test runner dependency. Tests must pass without NGINX, Slack, or a network listener except where a test binds `127.0.0.1` to an ephemeral port.

Cover at least:

- The official `stub_status` sample, extra whitespace, and an HTML body rejected as a bad page.
- Deltas for a quiet interval, a dropped interval, and a counter reset.
- URL acceptance for loopback, rejection for a public host, rejection for userinfo, and acceptance of a public host only when the matching allow flag is set.
- Probe status matching for `200-399` and for a comma-separated list.
- Throttle: a repeat inside the window is skipped, recovery deletes the key, and the next incident sends.
- Authorization: loopback with no token, non-loopback with no token, a matching bearer token, a wrong bearer token, and a token supplied only as a query string.
- Stall detection stays quiet before the first busy sample and when the feature is disabled.

Do not add a test that calls `hooks.slack.com`.

## Documentation

Any behavior change updates `README.md`, `README.ko.md`, `AGENTS.md`, `AGENTS.ko.md`, and `.env.example` in the same change when the contract changed. Code comments explain a constraint that the code itself does not show. They do not restate the README.

Examples under `examples/` are configuration the operator copies. They are not installed by the program.

The systemd example uses `Restart=on-failure`, an unprivileged `User=`, and `NoNewPrivileges=true`. The PM2 example is optional and names the process `nginx-monitor`.

## Commits and pull requests

Write commit subjects in English, in the imperative, with a short body that says why. Keep a commit focused.

Do not commit `.env`, `status-history.json`, `node_modules`, or a real webhook. Do not weaken the URL guard, the token comparison, or the redirect rule to make a demo easier.
