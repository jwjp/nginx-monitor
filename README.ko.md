# nginx-monitor

오픈소스 NGINX를 위한 작은 Slack 워치독입니다. 로컬 [`stub_status`](https://nginx.org/en/docs/http/ngx_http_stub_status_module.html) 페이지를 주기적으로 읽고, 필요하면 NGINX를 통해 URL 하나를 확인한 뒤, 연결을 버리거나 응답이 멈추거나 설정한 한계를 넘으면 Slack으로 알립니다.

운영 방식은 [pm2-monitor](https://github.com/jwjp/pm2-monitor)와 같습니다. Node.js 프로세스 하나, 환경 변수, cron 스케줄, 반복을 줄인 Slack 알림, 루프백 JSON 상태 엔드포인트입니다.

기본 문서는 영어입니다. [English README](README.md)

## 상태

Node.js 런타임은 [AGENTS.md](AGENTS.md)의 동작 계약을 구현합니다. [AGENTS.ko.md](AGENTS.ko.md)는 검토용 한국어 사본입니다. 두 파일이 다르면 영어 파일이 우선합니다.

## 이 형태를 고른 이유

오픈소스 NGINX는 운영자가 먼저 볼 카운터를 루프백 페이지로 제공합니다. 활성 연결, 수락한 연결, 처리한 연결, 요청 수, 그리고 읽는 중·쓰는 중·대기 중인 연결 수입니다. `accepts`가 `handled`보다 빨리 늘면 NGINX가 연결을 버리고 있습니다. 보통 `worker_connections`나 열 수 있는 파일 수 한계에 닿았다는 뜻이고, 사용자 제보보다 먼저 나타납니다.

`stub_status`는 NGINX에서 `pm2 jlist`에 해당하는 지점입니다. 이 워치독은 그 페이지를 일정마다 읽고 변화만 알립니다.

이미 Prometheus를 쓰는 호스트는 [nginx-prometheus-exporter](https://github.com/nginx/nginx-prometheus-exporter)를 유지하면 됩니다. nginx-monitor는 pm2-monitor와 같은 작은 Slack 경로입니다.

액세스 로그와 에러 로그는 읽지 않습니다. 그 줄에는 요청 URI와 클라이언트 주소가 들어 있고, 로그 파이프라인은 다른 제품입니다. NGINX Plus API도 호출하지 않습니다. NGINX를 리로드하거나 재시작하지도 않습니다.

pm2-monitor가 PM2 아래에서 도는 이유는 그 호스트가 이미 PM2를 쓰기 때문입니다. NGINX 호스트는 그렇지 않은 경우가 많습니다. `npm start`는 Node를 직접 실행합니다. 기본 감독 프로세스는 systemd입니다. PM2 ecosystem 파일은 pm2-monitor를 이미 돌리는 머신용으로만 선택 사항입니다.

pm2-monitor의 기본 스케줄은 `America/New_York`의 평일 업무 시간입니다. 그 값은 운영자 취향입니다. nginx-monitor의 기본값은 UTC로 하루 종일 1분마다입니다. 웹 서버는 밤에도 봐야 합니다.

## 각 사이클이 보는 것

스케줄마다 런타임은 다음을 합니다.

- `stub_status`를 가져옵니다. 가져오기 실패, 리다이렉트, 200이 아닌 응답, 시간 초과, 너무 큰 본문은 다운 알림입니다. 200이지만 `stub_status`가 아닌 본문은 잘못된 페이지 알림입니다. 다음 정상 샘플은 그 조건의 복구 알림입니다.
- 이전 정상 샘플과 카운터를 비교합니다. 카운터가 뒤로 가면 NGINX가 재시작된 것입니다. 그 샘플을 새 기준점으로 삼고 재시작을 알립니다.
- 한 구간에서 수락한 연결이 처리한 연결보다 `DROPPED_CONNECTIONS_MIN` 이상 많으면 알립니다.
- 활성 연결 또는 대기 연결이 운영자가 정한 한계를 넘으면 알립니다. 둘 다 기본값은 꺼짐입니다. 쓸모 있는 숫자는 `worker_processes`와 `worker_connections`에 달려 있습니다.
- 설정했다면 프로브 URL을 한 번 요청하고, 리다이렉트, 전송 오류, 허용 범위 밖의 상태이면 알립니다. 리다이렉트는 상태 코드가 기본값 `200-399` 안에 있어도 실패입니다.
- 설정했다면 `nginx -t`를 실행하고 마스터 pid 파일을 읽습니다. 둘 다 기본값은 꺼짐이라 root 없이 돌 수 있습니다.
- 샘플을 로컬 이력 파일에 추가하고, 그 파일을 루프백에서 제공합니다.

계속 참인 조건은 반복 알림을 줄입니다. 복구되면 그 제한을 지워서, 다음 사건은 바로 알립니다. 재시작은 조건이 아니라 사건이므로 매번 알립니다.

Slack이 사건 메시지 전송을 거절하거나 시간 초과가 나면 알림을 메모리에 두고 다음 사이클에 다시 보냅니다. 원래 시각을 유지하고 `delivered late at` 줄을 덧붙입니다. 그 사이클에 조건이 아직 참이면 새 알림이 큐의 알림을 대신하고 새 시각을 씁니다. 재시작은 합치지 않으며, 대상별로 최대 10개까지 전달을 기다립니다. 전송이 한 번 실패하면 그 사이클의 나머지 전송도 기다리므로, Slack에 닿지 않아도 샘플링이 느려지지 않습니다. 실패한 복구 메시지는 큐에 넣지 않습니다. 다음 정상 사이클이 복구 메시지를 새로 보내고, 그보다 먼저 조건이 다시 생기면 새 사건은 반복 억제 시간을 기다리지 않고 알립니다. 큐는 프로세스가 재시작되면 사라집니다.

한 사이클을 마치면 NGINX가 다운이어도 프로세스는 성공으로 끝냅니다. 다운은 Slack 알림이지, 프로세스 실패가 아닙니다. 알리려는 조건 때문에 systemd가 재시작을 반복하지 않게 하려는 목적입니다. `RUN_ONCE=true`는 스모크 테스트용 1회 실행입니다.

## 요구 사항

- Node.js 22 이상
- `http_stub_status_module`이 포함된 오픈소스 NGINX (현재 배포 패키지에는 들어 있습니다)
- localhost만 허용하는 `stub_status` location
- Slack Incoming Webhook URL
- 지원 운영 체제는 Linux

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

모듈과 페이지 확인:

```bash
nginx -V 2>&1 | grep http_stub_status_module
curl -sS http://127.0.0.1/nginx_status
```

정상적인 페이지는 이런 모양입니다.

```text
Active connections: 3
server accepts handled requests
 1200 1200 3560
Reading: 0 Writing: 1 Waiting: 2
```

`Active connections`에는 대기 연결이 포함됩니다. `accepts`, `handled`, `requests`는 NGINX가 시작된 뒤의 누적값입니다. 자원 한계로 연결을 버리지 않는 한 `accepts`와 `handled`는 같습니다. `Reading`은 요청 헤더를 읽는 중, `Writing`은 응답을 보내는 중, `Waiting`은 유휴 keepalive입니다.

## 설정

설정 계약은 [.env.example](.env.example)입니다. 실제 값은 `.env` 또는 프로세스 환경 변수에 둡니다. 프로세스 환경 변수가 `.env`보다 우선합니다.

```env
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL
```

연결 한계는 NGINX 설정에서 나옵니다. 워커 4개와 `worker_connections 1024`이면 용량은 4096입니다. 활성 연결 경고의 시작점으로 용량의 약 70퍼센트를 쓸 수 있습니다.

```env
ACTIVE_CONNECTIONS_THRESHOLD=2800
WAITING_CONNECTIONS_THRESHOLD=2000
```

임계값 `0`은 그 알림을 끕니다. 연결 하나가 버려지는 것만으로도 시끄럽다면 `DROPPED_CONNECTIONS_MIN`을 올립니다.

조용한 시간대가 의도된 경우에만 스케줄을 좁힙니다.

```env
CRON_SCHEDULE=*/1 8-19 * * 1-5
CRON_TIMEZONE=America/New_York
```

## 설정 참고

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `SLACK_WEBHOOK_URL` | 필수 | Slack Incoming Webhook URL. |
| `STATUS_URL` | `http://127.0.0.1/nginx_status` | `stub_status` URL. |
| `STATUS_URLS` | 비어 있음 | 추가 `stub_status` URL. 쉼표로 구분합니다. |
| `ALLOW_REMOTE_STATUS` | `false` | 루프백이 아닌 상태 URL을 허용합니다. |
| `STATUS_TIMEOUT_MS` | `5000` | 상태 페이지 요청 시간 제한. `0`이나 2147483647보다 큰 값은 기본값을 씁니다. |
| `CRON_SCHEDULE` | `* * * * *` | 다섯 필드 node-cron 스케줄. 초 필드는 거절합니다. |
| `CRON_TIMEZONE` | `UTC` | 스케줄에 쓰는 시간대. 알림 시각은 UTC입니다. |
| `ACTIVE_CONNECTIONS_THRESHOLD` | `0` | 활성 연결 알림. `0`이면 꺼집니다. |
| `WAITING_CONNECTIONS_THRESHOLD` | `0` | 대기 연결 알림. `0`이면 꺼집니다. |
| `DROPPED_CONNECTIONS_MIN` | `1` | 한 구간에서 버려진 연결의 최소 개수. `0`이면 꺼집니다. |
| `REQUEST_STALL_ENABLED` | `false` | 요청 카운터가 모니터 자신의 요청만큼만 움직이면 알립니다. |
| `REQUEST_STALL_WINDOWS` | `5` | 정체 알림에 필요한 연속된 조용한 정상 샘플 수. |
| `PROBE_URL` | 비어 있음 | NGINX를 통해 요청할 URL. |
| `PROBE_TIMEOUT_MS` | `5000` | 프로브 시간 제한. 상태 페이지 시간 제한과 같은 범위입니다. |
| `ALLOW_REMOTE_PROBE` | `false` | 루프백이 아닌 프로브 URL을 허용합니다. |
| `PROBE_ACCEPTED_STATUSES` | `200-399` | 허용 프로브 상태. 목록 또는 양 끝 포함 범위. |
| `NGINX_TEST_ENABLED` | `false` | 매 사이클에 `nginx -t`를 실행합니다. |
| `NGINX_BIN` | `nginx` | `nginx -t`에 쓸 실행 파일. |
| `NGINX_PID_FILE` | 비어 있음 | 마스터 pid 파일. 흔히 `/run/nginx.pid`. |
| `THROTTLE_DURATION_MS` | `900000` | 같은 조건의 반복 알림 최소 간격. |
| `SLACK_TIMEOUT_MS` | `10000` | Slack 요청 시간 제한. 상태 페이지 시간 제한과 같은 범위입니다. |
| `RUN_ONCE` | `false` | 한 사이클만 실행하고 종료합니다. |
| `WEB_ENABLED` | `true` | 상태 HTTP 엔드포인트를 켭니다. |
| `HOST` | `127.0.0.1` | 상태 엔드포인트 바인드 주소. |
| `PORT` | `3032` | 상태 엔드포인트 포트. 65535 이하의 정수여야 합니다. |
| `STATUS_LOG_FILE` | `./status-history.json` | 런타임 상태 이력 파일. |
| `MAX_HISTORY` | `1440` | 보관할 상태 스냅샷 수. |
| `STATUS_TOKEN` | 비어 있음 | `/status`용 Bearer 토큰. `HOST`가 루프백이 아니면 필수입니다. |

## 상태 엔드포인트

런타임이 켜지면 다음을 제공합니다.

```text
GET /healthz
GET /status
```

`/healthz`는 `{ "ok": true }`만 반환하고 NGINX 정보는 주지 않습니다. `/status`는 이력 파일을 반환합니다.

기본 바인드는 `127.0.0.1:3032`입니다. pm2-monitor와 포트를 하나 비워 둔 값입니다. 이 루프백 바인드에서 `STATUS_TOKEN`이 비어 있으면 로컬 호출을 허용합니다. `HOST`가 그 외의 값이면 `STATUS_TOKEN`을 설정하기 전까지 `/status`는 닫혀 있습니다.

```bash
curl -H "Authorization: Bearer $STATUS_TOKEN" http://127.0.0.1:3032/status
```

토큰은 `Authorization` 헤더로만 받습니다.

## 예시

운영자 설정은 `examples/`에 있습니다. 프로그램이 이 파일을 설치하지는 않습니다.

- `examples/nginx-stub-status.conf`는 localhost `stub_status` location입니다.
- `examples/nginx-monitor.service`는 systemd 유닛입니다.
- `examples/ecosystem.config.cjs`는 선택적 PM2 프로세스이며 이름은 `nginx-monitor`입니다.

## 실행

```bash
npm install
npm test
npm run check
npm start
```

`npm start`는 `node nginx-monitor.js`를 실행합니다. PM2가 필요하지 않습니다. `npm test`는 `node --test`를 쓰며 Slack이나 NGINX를 호출하지 않습니다.

문서에 적은 감독 프로세스는 systemd입니다. 예시 유닛은 `Restart=on-failure`, 권한 없는 사용자, `NoNewPrivileges=true`를 씁니다. NGINX가 다운된 것이 프로세스의 실패 종료가 되면 안 됩니다.

이미 PM2를 쓰는 호스트에서는 선택적 ecosystem 파일이 같은 Node 프로세스를 `nginx-monitor`라는 이름으로 감독할 수 있습니다.

## 보안

- Slack 웹훅은 git, 로그, Slack 메시지 본문에 넣지 않습니다.
- `stub_status`는 localhost에만 엽니다. 허용 플래그가 없으면 모니터는 루프백이 아닌 상태 URL과 프로브 URL을 거절합니다.
- 상태 페이지 요청과 프로브는 리다이렉트를 따라가지 않습니다.
- 이력 파일에는 개수, 차이, 프로브 상태 코드, 검사 불리언, 알고 있는 마스터 pid를 저장합니다. 요청 URI, 클라이언트 주소, 명령 출력, 웹훅은 저장하지 않습니다.
- 모니터는 NGINX를 리로드하거나 재시작하지 않습니다.
- 프로세스는 상태 페이지를 읽을 수 있는 권한 없는 사용자로 실행합니다.

## 라이선스

[Unlicense](LICENSE). pm2-monitor와 같은 퍼블릭 도메인 기증입니다.
