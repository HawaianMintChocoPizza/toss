# Toss Cross Analyzer — 공개 배포용 WebSocket 버전

토스증권 Open API를 서버에서만 인증하고, 방문자는 API 키 입력 없이 종목을 검색해 실시간 체결가와 이동평균선, RSI, 골든/데드크로스를 확인하는 공개 웹 앱입니다.

## 공개 배포 구조

```text
방문자 브라우저 (API 키 없음)
        │
        │ HTTPS / WebSocket
        ▼
Flask 서버 (API 키는 환경변수로만 보관)
        │
        ├─ REST: 초기 캔들 / 정합성 동기화
        └─ WebSocket 1개 공유: 실시간 체결
                │
                ▼
        토스증권 Open API
```

같은 종목을 여러 사람이 보고 있어도 토스 쪽에는 그 종목을 한 번만 구독합니다. 서버 프로세스 하나가 브라우저 연결을 모아서 토스 WebSocket 구독 목록을 관리합니다.

## 보안상 달라진 점

- 웹 화면의 `API 설정` 버튼과 키 입력창을 제거했습니다.
- `/api/config` POST 및 `/api/test-connection` 같은 방문자용 키 설정 API를 제거했습니다.
- `client_id`, `client_secret`은 `TOSS_CLIENT_ID`, `TOSS_CLIENT_SECRET` 환경변수에서만 읽습니다.
- `.env`, `config.json`, `config*.json`은 `.gitignore`에 포함되어 GitHub에 올라가지 않습니다.
- 배포판의 기본값은 `ALLOW_DEMO=false`입니다. 서버 키가 없으면 가짜 시세 대신 설정 오류를 반환합니다.

## 실시간/다중 사용자 처리

- 토스 WebSocket 상류 연결은 서버 프로세스당 1개만 사용합니다.
- 여러 방문자가 같은 종목을 보면 중복 구독하지 않습니다.
- 구독 목록 변경을 0.35초 단위로 묶어 선언 빈도 제한을 피하도록 했습니다.
- 기본 최대 동시 실시간 종목 수는 90개입니다. (`MAX_REALTIME_SYMBOLS`)
- 브라우저 WebSocket 연결 기본 상한은 250개입니다. (`MAX_BROWSER_WS_CLIENTS`)
- REST 스냅샷은 서버 캐시를 공유합니다. 기본 캐시는 1분봉 5초, 일봉 15초입니다.
- 외부 REST 스냅샷 호출은 기본 0.12초 이상 간격을 두어 공개 접속자가 몰릴 때 API 호출 폭주를 완화합니다.
- 실시간 체결은 현재가와 진행 중인 봉을 즉시 반영하고, REST는 주기적으로 OHLCV 정합성을 보정합니다.

토스 공식 WebSocket 한도는 계정당 동시 연결 2개, 연결당 구독 100건, 구독 선언 5회/초입니다. 공식 문서: https://developers.tossinvest.com/docs/connection

## 로컬 실행

### 1. Python 설치

Python 3.10 이상을 권장합니다.

### 2. `run.bat` 실행

Windows에서 `run.bat`을 더블클릭합니다. 처음 실행 시 필요한 패키지를 설치하고 `.env`가 없으면 API 키를 입력하는 로컬 설정 절차가 시작됩니다.

API 비밀키는 입력할 때 화면에 표시되지 않으며 `.env`에만 저장됩니다.

이후 브라우저에서 다음 주소로 접속합니다.

```text
http://127.0.0.1:5000
```

직접 설정하려면 `.env.example`을 `.env`로 복사하고 아래 값을 입력해도 됩니다.

```env
TOSS_CLIENT_ID=...
TOSS_CLIENT_SECRET=...
ALLOW_DEMO=false
```

## GitHub에 올리기

이 폴더 자체를 저장소 루트로 사용하면 됩니다.

```bash
git init
git add .
git commit -m "public websocket deployment"
git branch -M main
git remote add origin <YOUR_GITHUB_REPOSITORY_URL>
git push -u origin main
```

업로드 전에 반드시 다음 명령으로 비밀 파일이 추적되지 않는지 확인하세요.

```bash
git status
```

`.env`와 `config.json`이 목록에 없어야 합니다.

> GitHub Pages만으로는 이 앱을 운영할 수 없습니다. Python 서버, 비밀 환경변수, 서버 측 WebSocket 중계가 필요하기 때문에 GitHub 저장소와 별도의 Web Service 호스팅이 필요합니다.

## 배포 환경변수

호스팅 서비스의 Secret/Environment Variables 메뉴에 설정합니다.

| 변수 | 필수 | 기본값 | 설명 |
|---|---|---:|---|
| `TOSS_CLIENT_ID` | 예 | - | 토스 Open API Client ID |
| `TOSS_CLIENT_SECRET` | 예 | - | 토스 Open API Client Secret |
| `ALLOW_DEMO` | 아니오 | `false` | `true`일 때만 키가 없으면 모의 데이터 허용 |
| `MAX_REALTIME_SYMBOLS` | 아니오 | `90` | 동시에 토스에 구독할 서로 다른 종목 수 |
| `MAX_BROWSER_WS_CLIENTS` | 아니오 | `250` | 브라우저 WebSocket 세션 상한 |
| `SNAPSHOT_CACHE_SECONDS_1M` | 아니오 | `5` | 1분봉 REST 서버 캐시 시간 |
| `SNAPSHOT_CACHE_SECONDS_1D` | 아니오 | `15` | 일봉 REST 서버 캐시 시간 |
| `SNAPSHOT_MIN_INTERVAL_SECONDS` | 아니오 | `0.12` | 토스 REST 스냅샷 사이의 최소 간격 |
| `MAX_MARKET_CACHE_ENTRIES` | 아니오 | `512` | 서버 메모리의 스냅샷 캐시 최대 항목 수 |
| `PORT` | 호스팅에 따라 | `5000` | HTTP 서버 포트 |

## 배포 서버에서 중요한 조건: 고정 아웃바운드 IP

토스 Open API는 허용 IP 등록이 필요합니다. 따라서 서버가 토스로 나갈 때 사용하는 **공인 아웃바운드 IP를 토스 WTS의 Open API 허용 IP 관리에 등록**해야 합니다.

호스팅 서비스의 아웃바운드 IP가 계속 바뀌면 인증이 403으로 실패합니다. 고정/전용 아웃바운드 IPv4를 제공하는 호스팅을 사용하거나, 고정 IP 프록시를 사용해야 합니다.

## Render 배포

이 저장소에는 `render.yaml`이 포함되어 있습니다. Render Web Service는 WebSocket을 지원하고 `$PORT`에 바인딩해 실행할 수 있습니다.

1. GitHub에 저장소를 올립니다.
2. Render에서 Blueprint 또는 Web Service로 저장소를 연결합니다.
3. `TOSS_CLIENT_ID`, `TOSS_CLIENT_SECRET`을 Secret 환경변수로 입력합니다.
4. 서비스의 **아웃바운드 IP**를 확인합니다.
5. 토스 WTS > 설정 > Open API > 허용 IP 관리에 등록합니다.
6. `/healthz`가 200을 반환하는지 확인합니다.
7. 사이트에서 실시간 상태가 `WebSocket 실시간`으로 바뀌는지 확인합니다.

주의: Render의 일반 서비스는 지역별 공유 아웃바운드 IP 범위를 사용할 수 있습니다. 토스 허용 IP에 정확한 고정 주소가 필요한 경우 Render Dedicated Outbound IP 또는 별도의 고정 IP 방식을 사용해야 합니다. Render 문서: https://render.com/docs/outbound-ip-addresses

## 운영 실행 명령

공개 배포에서는 다음처럼 **Gunicorn worker를 반드시 1개**로 유지하는 것을 권장합니다.

```bash
gunicorn -b 0.0.0.0:$PORT --workers 1 --threads 100 --timeout 0 app:app
```

이 프로젝트의 토스 WebSocket 허브와 구독 상태는 메모리에 있으므로 여러 worker를 띄우면 각 worker가 별도의 토스 WebSocket을 만들 수 있습니다. `render.yaml`, `Procfile`, `Dockerfile`은 모두 worker 1개로 설정되어 있습니다.

Flask-Sock의 Gunicorn WebSocket 배포 가이드: https://flask-sock.readthedocs.io/en/latest/web_servers.html

## 상태 확인 주소

```text
/healthz
/api/status
/api/version
```

`/api/status`에는 키 자체나 Client ID가 포함되지 않습니다.

## 주요 파일

```text
app.py                 Flask + 토스 REST + 토스 WebSocket 공유 허브
static/index.html       공개 화면
static/app.js           브라우저 WebSocket / 차트 / 기술적 분석
static/style.css        UI
stock_master.json       종목 검색 데이터
requirements.txt        Python 패키지
.env.example            로컬 환경변수 예시
setup_local.py          로컬 .env 설정 도우미
run.bat                 Windows 로컬 실행
render.yaml             Render Blueprint
Procfile                일반 PaaS 실행 명령
Dockerfile              Docker 배포
.gitignore              비밀키 제외
```

## 배포 전 체크리스트

- 기존에 외부로 노출된 적 있는 Client Secret은 재발급합니다.
- GitHub 저장소에 `.env` 또는 `config.json`이 없는지 확인합니다.
- 배포 서비스의 고정 아웃바운드 IP를 토스에 등록합니다.
- 배포 환경에 `TOSS_CLIENT_ID`, `TOSS_CLIENT_SECRET`을 설정합니다.
- Gunicorn worker는 1개로 유지합니다.
- `/healthz`, `/api/status`를 확인합니다.
- 장중 실제 체결이 들어올 때 가격이 WebSocket으로 갱신되는지 확인합니다.
