# nginx-monitor

Small Slack watchdog for open-source NGINX. It polls a local [`stub_status`](https://nginx.org/en/docs/http/ngx_http_stub_status_module.html) page, can probe one URL through NGINX, and sends a Slack message when the server drops connections, stops answering, or crosses a limit you set.

The operating idea matches [pm2-monitor](https://github.com/jwjp/pm2-monitor): one Node.js process, environment variables, a cron schedule, throttled Slack alerts, and a loopback JSON status endpoint.

English is the default. [한국어 안내](README.ko.md)

## Status

The Node.js runtime implements the behavior contract in [AGENTS.md](AGENTS.md). [AGENTS.ko.md](AGENTS.ko.md) is the Korean review copy. The English agent file wins if the two differ.

## Why this shape

Open-source NGINX exposes the first counters an operator needs on a loopback page: active connections, accepted connections, handled connections, requests, and how many connections are reading, writing, or waiting. When `accepts` grows faster than `handled`, NGINX is dropping connections. That usually happens because `worker_connections` or the open-file limit has been reached, and it shows up before a user report.

`stub_status` is the NGINX equivalent of `pm2 jlist`. This watchdog reads that page on a schedule and reports changes.

A host that already runs Prometheus should keep [nginx-prometheus-exporter](https://github.com/nginx/nginx-prometheus-exporter). nginx-monitor is the small Slack path, in the same spirit as pm2-monitor.

The watchdog does not tail access or error logs. Those lines carry request URIs and client addresses, and a log pipeline is a different product. It does not call the NGINX Plus API. It does not reload or restart NGINX.

pm2-monitor runs under PM2 because the host already uses PM2. An NGINX host often does not. `npm start` runs Node directly. systemd is the normal supervisor. A PM2 ecosystem file is optional, for a machine that already runs pm2-monitor.

pm2-monitor's default schedule is weekday business hours in `America/New_York`. That is an operator preference. nginx-monitor defaults to every minute, all day, in UTC, because a web server should still be watched at night.

## What each cycle watches

On each scheduled cycle the runtime:

- Fetches `stub_status`. A failed fetch, a redirect, a non-200 response, a timeout, or an oversized body raises a down alert. A 200 body that is not `stub_status` raises a bad-page alert. The next good sample raises a recovery alert for that condition.
- Compares counters with the previous good sample. Counters that move backward mean NGINX restarted. That sample becomes the new baseline, and the cycle reports the restart.
- Alerts when accepted connections in the interval exceed handled connections by `DROPPED_CONNECTIONS_MIN`.
- Alerts when active, waiting, reading, or writing connections cross an operator threshold. All four default to off. The useful number depends on `worker_processes` and `worker_connections`.
- Optionally requests one probe URL and alerts on a redirect, a transport error, or a status outside the accepted set. A redirect fails even when its status is inside the default `200-399`.
- Optionally runs `nginx -t` and reads the master pid file. Both stay off unless configured, so the process can run without root.
- Counts a skip when a new cycle is due while the previous one is still running. The next cycle that finishes alerts `lag` once the skipped count reaches `SKIPPED_CYCLES_MIN`. The default is 1, and `0` turns it off. The skipped cycle does not itself call Slack.
- Appends the sample to a local history file and serves that file on loopback. Each snapshot also records how many cycles were skipped, how many Slack messages are still queued, and which conditions are open.

A condition that remains true is throttled. A recovery clears that throttle, so the next incident alerts immediately. A restart is an event, not a condition, so every restart alerts.

If Slack rejects or times out an incident post, the alert is kept in memory and retried on the next cycle, with its original time and a `delivered late at` line. If the condition is still true on that cycle, the new alert replaces the queued one and carries the new time. Restarts are never merged, and up to 10 per target wait for delivery. After one failed post, the rest of that cycle's posts wait too, so an unreachable Slack does not slow the sampling. A failed recovery post is not queued: the next good cycle sends a fresh recovery, and if the condition returns first, the new incident alerts without waiting for the throttle. The queue does not survive a process restart.

A completed cycle exits successfully even when NGINX is down. The down state is a Slack alert. The process stays up so systemd does not restart-loop on the condition it is reporting. `RUN_ONCE=true` is the one-shot form for a smoke test. On `SIGINT` or `SIGTERM`, the process stops the cron schedule, waits up to 30 seconds for any in-flight cycle to finish, closes the status server, and exits cleanly.

## Requirements

- Node.js 22 or later
- Open-source NGINX built with `http_stub_status_module` (current distribution packages include it)
- A `stub_status` location that accepts localhost only
- A Slack Incoming Webhook URL
- Linux as the supported operating system

## stub_status

```nginx
server {
    listen 127.0.0.1:80;
    server_name localhost;

    location = /nginx_status {
        stub_status;
        access_log off;
        allow 127.0.0.1;
        allow ::1;
        deny all;
    }
}
```

Check the module and the page:

```bash
nginx -V 2>&1 | grep http_stub_status_module
curl -sS http://127.0.0.1/nginx_status
```

A normal page looks like this:

```text
Active connections: 3
server accepts handled requests
 1200 1200 3560
Reading: 0 Writing: 1 Waiting: 2
```

`Active connections` includes waiting connections. `accepts`, `handled`, and `requests` are cumulative since NGINX started. `accepts` and `handled` stay equal unless a resource limit drops connections. `Reading` is request headers being read, `Writing` is the response being sent, and `Waiting` is an idle keepalive.

## Configure

The configuration contract is [.env.example](.env.example). Keep real values in `.env` or in the process environment. The process environment wins over `.env`.

```env
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL
```

Connection limits come from the NGINX configuration. With 4 workers and `worker_connections 1024`, capacity is 4096 connections. A starting active-connection warning is about 70 percent of that capacity:

```env
ACTIVE_CONNECTIONS_THRESHOLD=2800
WAITING_CONNECTIONS_THRESHOLD=2000
READING_CONNECTIONS_THRESHOLD=0
WRITING_CONNECTIONS_THRESHOLD=0
```

A threshold of `0` turns that alert off. Raise `DROPPED_CONNECTIONS_MIN` if a single dropped connection is too noisy for the host. `SKIPPED_CYCLES_MIN=0` turns off the alert that a cycle overlapped the previous one.

Narrow the schedule when a quiet window is intentional:

```env
CRON_SCHEDULE=*/1 8-19 * * 1-5
CRON_TIMEZONE=America/New_York
```

## Configuration reference

| Variable | Default | Description |
| --- | --- | --- |
| `SLACK_WEBHOOK_URL` | required | Slack Incoming Webhook URL. |
| `STATUS_URL` | `http://127.0.0.1/nginx_status` | `stub_status` URL. |
| `STATUS_URLS` | empty | Extra comma-separated `stub_status` URLs. |
| `ALLOW_REMOTE_STATUS` | `false` | Allow a status URL that is not loopback. |
| `STATUS_TIMEOUT_MS` | `5000` | Status fetch timeout. `0` or a value above 2147483647 uses the default. |
| `CRON_SCHEDULE` | `* * * * *` | Five-field node-cron schedule. A seconds field is rejected. |
| `CRON_TIMEZONE` | `UTC` | Time zone for the schedule. Alert timestamps are UTC. |
| `SKIPPED_CYCLES_MIN` | `1` | Alert when a later cycle finds at least this many skipped cycles. `0` disables it. |
| `ACTIVE_CONNECTIONS_THRESHOLD` | `0` | Active-connection alert. `0` disables it. |
| `WAITING_CONNECTIONS_THRESHOLD` | `0` | Waiting-connection alert. `0` disables it. |
| `READING_CONNECTIONS_THRESHOLD` | `0` | Reading-connection alert. `0` disables it. |
| `WRITING_CONNECTIONS_THRESHOLD` | `0` | Writing-connection alert. `0` disables it. |
| `DROPPED_CONNECTIONS_MIN` | `1` | Minimum dropped connections in one interval. `0` disables it. |
| `REQUEST_STALL_ENABLED` | `false` | Alert when only the monitor's own requests to that origin move the request counter. |
| `REQUEST_STALL_WINDOWS` | `5` | Consecutive quiet good samples required for a stall alert. |
| `PROBE_URL` | empty | Optional URL requested through NGINX. |
| `PROBE_TIMEOUT_MS` | `5000` | Probe timeout. Same limits as the status timeout. |
| `ALLOW_REMOTE_PROBE` | `false` | Allow a probe URL that is not loopback. |
| `PROBE_ACCEPTED_STATUSES` | `200-399` | Accepted probe statuses, as a list or an inclusive range. |
| `NGINX_TEST_ENABLED` | `false` | Run `nginx -t` on each cycle. |
| `NGINX_BIN` | `nginx` | NGINX executable used for `nginx -t`. |
| `NGINX_PID_FILE` | empty | Master pid file, often `/run/nginx.pid`. |
| `THROTTLE_DURATION_MS` | `900000` | Minimum interval for a repeated alert of the same condition. |
| `SLACK_TIMEOUT_MS` | `10000` | Slack request timeout. Same limits as the status timeout. |
| `RUN_ONCE` | `false` | Run one cycle and exit. |
| `WEB_ENABLED` | `true` | Enable the status HTTP endpoint. |
| `HOST` | `127.0.0.1` | Bind address for the status endpoint. |
| `PORT` | `3032` | Port for the status endpoint. Must be an integer up to 65535. |
| `STATUS_LOG_FILE` | `./status-history.json` | Runtime status history file. |
| `MAX_HISTORY` | `1440` | Status snapshots to retain. |
| `STATUS_TOKEN` | empty | Bearer token for `/status`. Required when `HOST` is not loopback. |

## Status endpoint

When the runtime is enabled it exposes:

```text
GET /healthz
GET /status
```

`/healthz` answers `{ "ok": true }` and nothing about NGINX. `/status` returns the history file. An optional query parameter `limit` (e.g. `GET /status?limit=10`) returns only the newest N snapshots.

The default bind is `127.0.0.1:3032`, one port away from pm2-monitor. On that loopback bind, an empty `STATUS_TOKEN` allows local callers. If `HOST` is anything else, `/status` stays closed until `STATUS_TOKEN` is set.

```bash
curl -H "Authorization: Bearer $STATUS_TOKEN" http://127.0.0.1:3032/status
curl -H "Authorization: Bearer $STATUS_TOKEN" http://127.0.0.1:3032/status?limit=10
```

The token is accepted only in the `Authorization` header.

## Examples

Operator configuration lives in `examples/`. The program does not install these files.

- `examples/nginx-stub-status.conf` is the localhost `stub_status` location.
- `examples/nginx-monitor.service` is the systemd unit.
- `examples/ecosystem.config.cjs` is the optional PM2 process, named `nginx-monitor`.

## Run

```bash
npm install
npm test
npm run check
npm start
```

`npm start` runs `node nginx-monitor.js`. It does not require PM2. `npm test` uses `node --test` and does not call Slack or NGINX.

systemd is the documented supervisor. The example unit uses `Restart=on-failure`, an unprivileged user, and `NoNewPrivileges=true`. A down NGINX must not be a failing process exit.

On a host that already uses PM2, an optional ecosystem file may supervise the same Node process under the name `nginx-monitor`.

## Security

- Keep the Slack webhook out of git, logs, and Slack message text.
- Serve `stub_status` on localhost only. The monitor refuses a non-loopback status or probe URL unless the matching allow flag is set.
- Status fetches and probes do not follow redirects.
- The history file stores counts, deltas, probe status codes, check booleans, the master pid when known, skipped cycles, the queued Slack count, and open conditions as target and kind. It does not store request URIs, client addresses, command output, alert text, or the webhook.
- The monitor never reloads or restarts NGINX.
- Run the process as an unprivileged user that can read the status page.

## License

[Unlicense](LICENSE), the same public-domain dedication as pm2-monitor.
