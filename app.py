"""
Toss Securities Stock Chart Analysis Backend
토스증권 Open API 연동 및 기술적 지표(이동평균선, 골든/데드크로스) 분석 서버
"""

from threading import RLock, Thread, Timer
import queue
import os
import sys
import json
import time
import hashlib
import math
import random
from datetime import datetime, timedelta, timezone
from typing import List, Dict, Any, Optional

import requests
import websocket
from flask import Flask, request, jsonify, send_from_directory
from flask_sock import Sock
from dotenv import load_dotenv

load_dotenv()

# Configure UTF-8 for Windows console
if sys.platform.startswith("win"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

app = Flask(__name__, static_folder="static", static_url_path="")
sock = Sock(app)

STOCK_MASTER_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "stock_master.json")
TOSS_API_BASE = "https://openapi.tossinvest.com"
BUILD_VERSION = "public-ws-20260929-1"
TOSS_WS_URL = "wss://openapi-ws.tossinvest.com/ws/v1"

# Public deployment settings. Secrets are read only from server environment variables.
def _env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        value = default
    return max(minimum, min(maximum, value))

def _env_float(name: str, default: float, minimum: float, maximum: float) -> float:
    try:
        value = float(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        value = default
    return max(minimum, min(maximum, value))

def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}

MAX_REALTIME_SYMBOLS = _env_int("MAX_REALTIME_SYMBOLS", 90, 1, 100)
MAX_BROWSER_WS_CLIENTS = _env_int("MAX_BROWSER_WS_CLIENTS", 250, 1, 2000)
SNAPSHOT_CACHE_SECONDS_1M = _env_float("SNAPSHOT_CACHE_SECONDS_1M", 5.0, 1.0, 60.0)
SNAPSHOT_CACHE_SECONDS_1D = _env_float("SNAPSHOT_CACHE_SECONDS_1D", 15.0, 1.0, 120.0)
SNAPSHOT_MIN_INTERVAL_SECONDS = _env_float("SNAPSHOT_MIN_INTERVAL_SECONDS", 0.12, 0.05, 1.0)
MAX_MARKET_CACHE_ENTRIES = _env_int("MAX_MARKET_CACHE_ENTRIES", 512, 64, 4096)
ALLOW_DEMO = _env_bool("ALLOW_DEMO", False)

class QuoteError(Exception):
    def __init__(self, message, status=502, retry_after=2):
        super().__init__(message)
        self.status = status
        self.retry_after = retry_after


def check_market_response(resp):
    if resp.status_code == 429:
        try:
            delay = max(2, min(300, int(resp.headers.get("Retry-After", 10))))
        except (TypeError, ValueError):
            delay = 10
        raise QuoteError("조회 한도를 초과했습니다. 잠시 후 다시 연결합니다.", 429, delay)
    if resp.status_code in (401, 403):
        clear_token_cache()
        raise QuoteError(_auth_error_message(resp.status_code), resp.status_code, 10)
    if resp.status_code != 200:
        raise QuoteError("토스 시세 조회에 실패했습니다.", 502, 5)


market_lock = RLock()
market_cache = {}
market_retry_at = 0.0
market_last_snapshot_at = 0.0


def fetch_market_snapshot(symbol, interval, count, token, use_cache=True):
    """REST 스냅샷을 서버 캐시로 공유하고 외부 호출 빈도를 보호한다."""
    global market_retry_at, market_last_snapshot_at
    key = (symbol, interval, count)
    with market_lock:
        now = time.monotonic()
        if now < market_retry_at:
            raise QuoteError("조회 대기 중입니다. 잠시 후 다시 연결합니다.", 429,
                             max(2, math.ceil(market_retry_at - now)))
        cached = market_cache.get(key)
        cache_ttl = SNAPSHOT_CACHE_SECONDS_1M if interval == "1m" else SNAPSHOT_CACHE_SECONDS_1D
        if use_cache and cached and now - cached[0] < cache_ttl:
            return cached[1]
        wait_for = SNAPSHOT_MIN_INTERVAL_SECONDS - (time.monotonic() - market_last_snapshot_at)
        if wait_for > 0:
            time.sleep(wait_for)
        market_last_snapshot_at = time.monotonic()
        try:
            candles = fetch_toss_candles(symbol, interval, count, token)
            resp = requests.get(f"{TOSS_API_BASE}/api/v1/prices",
                                headers={"Authorization": f"Bearer {token}"},
                                params={"symbols": symbol}, timeout=10)
            check_market_response(resp)
            item = next((q for q in resp.json().get("result", [])
                         if q.get("symbol", "").upper() == symbol.upper()), None)
            if not item:
                raise QuoteError("현재가를 찾을 수 없습니다.", 404, 5)
            price = float(item["lastPrice"])
            if not math.isfinite(price) or price <= 0:
                raise ValueError("invalid price")
            quote = {"price": price, "timestamp": item.get("timestamp"),
                     "currency": item.get("currency", "")}
        except QuoteError as exc:
            if exc.status == 429:
                market_retry_at = time.monotonic() + exc.retry_after
            raise
        except (requests.RequestException, ValueError, TypeError, KeyError):
            raise QuoteError("시세 응답을 받지 못했습니다. 연결을 재시도합니다.", 502, 5)
        snapshot = (candles, quote, datetime.now(timezone.utc).isoformat())
        if len(market_cache) >= MAX_MARKET_CACHE_ENTRIES:
            market_cache.pop(next(iter(market_cache)))
        market_cache[key] = (time.monotonic(), snapshot)
        return snapshot

# Stock Master In-Memory Cache
stock_master_list: List[Dict[str, str]] = []
symbol_map: Dict[str, Dict[str, str]] = {}
name_map: Dict[str, Dict[str, str]] = {}


def load_stock_master():
    global stock_master_list, symbol_map, name_map
    if os.path.exists(STOCK_MASTER_FILE):
        try:
            with open(STOCK_MASTER_FILE, "r", encoding="utf-8") as f:
                stock_master_list = json.load(f)
                symbol_map = {s["symbol"].upper(): s for s in stock_master_list}
                name_map = {s["name"].replace(" ", "").lower(): s for s in stock_master_list}
                print(f"[Master] Loaded {len(stock_master_list)} stocks from stock_master.json")
        except Exception as e:
            print(f"[Warning] Failed to load stock_master.json: {e}")

load_stock_master()


def resolve_stock(query: str):
    """
    종목명 또는 심볼을 정규 종목 정보로 변환
    예: '카카오' -> ('035720', '카카오', 'KOSPI')
        '005930' -> ('005930', '삼성전자', 'KOSPI')
        'AAPL' -> ('AAPL', '애플 (Apple)', 'NASDAQ')
    """
    q_clean = query.strip()
    q_upper = q_clean.upper()
    q_nospace = q_clean.replace(" ", "").lower()
    
    # 1. Direct symbol match
    if q_upper in symbol_map:
        item = symbol_map[q_upper]
        return item["symbol"], item["name"], item.get("market", "KRX")
        
    # 2. Exact name match
    if q_nospace in name_map:
        item = name_map[q_nospace]
        return item["symbol"], item["name"], item.get("market", "KRX")
        
    # 3. Partial name match
    for s in stock_master_list:
        if q_clean.lower() in s["name"].lower():
            return s["symbol"], s["name"], s.get("market", "KRX")
            
    # Default to query if not found
    return q_upper, q_clean, "KRX" if q_upper.isdigit() else "US"


# In-memory token cache. Cache is bound to the exact credential pair.
token_lock = RLock()
token_cache = {
    "access_token": None,
    "expires_at": 0,
    "client_id": None,
    "secret_fingerprint": None,
}

auth_state = {
    "ok": False,
    "status": None,
    "code": None,
    "message": "API 인증을 아직 확인하지 않았습니다.",
}


def _secret_fingerprint(secret: str) -> str:
    return hashlib.sha256((secret or "").encode("utf-8")).hexdigest()


def _set_auth_state(ok: bool, status=None, code=None, message=""):
    auth_state.update({
        "ok": bool(ok),
        "status": status,
        "code": code,
        "message": message,
    })


def _auth_error_message(status, code=None):
    suffix = f" ({code})" if code else ""
    if status == 401:
        return "토스 API 인증 실패(401): Client ID 또는 Client Secret이 올바른지 확인해주세요." + suffix
    if status == 403:
        return "토스 API 접근 거부(403): 현재 공인 IP를 WTS > 설정 > Open API > 허용 IP 관리에 등록했는지 확인해주세요." + suffix
    return f"토스 API 토큰 발급 실패(HTTP {status}). 잠시 후 다시 시도해주세요." + suffix


def get_api_credentials() -> tuple[str, str]:
    """Read Toss API credentials from server-side environment variables only."""
    return (
        os.getenv("TOSS_CLIENT_ID", "").strip(),
        os.getenv("TOSS_CLIENT_SECRET", "").strip(),
    )

def clear_token_cache():
    token_cache["access_token"] = None
    token_cache["expires_at"] = 0
    token_cache["client_id"] = None
    token_cache["secret_fingerprint"] = None


def _get_toss_token_unlocked(client_id: str, client_secret: str, force_refresh: bool = False) -> Optional[str]:
    """토스증권 OAuth 2.0 Client Credentials 토큰 발급 및 자격증명별 캐싱."""
    now = time.time()
    client_id = (client_id or "").strip()
    client_secret = (client_secret or "").strip()
    fingerprint = _secret_fingerprint(client_secret)

    if not client_id or not client_secret:
        _set_auth_state(False, 401, "missing-credentials", "Client ID와 Client Secret을 모두 입력해주세요.")
        return None

    if (
        not force_refresh
        and token_cache["access_token"]
        and token_cache["expires_at"] > now + 60
        and token_cache.get("client_id") == client_id
        and token_cache.get("secret_fingerprint") == fingerprint
    ):
        return token_cache["access_token"]

    url = f"{TOSS_API_BASE}/oauth2/token"
    data = {
        "grant_type": "client_credentials",
        "client_id": client_id,
        "client_secret": client_secret,
    }
    headers = {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
    }

    try:
        resp = requests.post(url, data=data, headers=headers, timeout=10)
        if resp.status_code == 200:
            result = resp.json()
            access_token = result.get("access_token")
            if not access_token:
                clear_token_cache()
                _set_auth_state(False, 502, "missing-access-token", "토스 토큰 응답에 access_token이 없습니다.")
                return None
            expires_in = int(result.get("expires_in", 3600))
            token_cache["access_token"] = access_token
            token_cache["expires_at"] = now + expires_in
            token_cache["client_id"] = client_id
            token_cache["secret_fingerprint"] = fingerprint
            _set_auth_state(True, 200, None, "토스증권 API 인증 성공")
            print(f"[Auth] Successfully issued Toss API token (expires in {expires_in}s)")
            return access_token

        try:
            body = resp.json()
        except Exception:
            body = {}
        code = body.get("code") or body.get("error")
        message = _auth_error_message(resp.status_code, code)
        clear_token_cache()
        _set_auth_state(False, resp.status_code, code, message)
        print(f"[Auth Error] Status {resp.status_code}" + (f" code={code}" if code else ""))
        return None
    except requests.RequestException as exc:
        clear_token_cache()
        message = f"토스 인증 서버에 연결하지 못했습니다: {exc.__class__.__name__}"
        _set_auth_state(False, 502, "network-error", message)
        print(f"[Auth Exception] {exc}")
        return None


def get_toss_token(client_id: str, client_secret: str, force_refresh: bool = False) -> Optional[str]:
    with token_lock:
        return _get_toss_token_unlocked(client_id, client_secret, force_refresh)


class RealtimeCapacityError(Exception):
    pass


class TossRealtimeHub:
    """토스 실시간 체결 WebSocket 1개를 여러 브라우저 세션에 중계한다."""

    def __init__(self):
        self.lock = RLock()
        self.clients = {}
        self.upstream = None
        self.thread = None
        self.connected = False
        self.subscription_timer = None
        self.last_subscription_serialized = None

    @staticmethod
    def _is_domestic(market: str) -> bool:
        return (market or "").upper() in {"KOSPI", "KOSDAQ", "KRX", "NXT"}

    def _unique_symbols_locked(self):
        return {c["symbol"] for c in self.clients.values()}

    def register(self, symbol: str, market: str):
        symbol = symbol.upper()
        client_queue = queue.Queue(maxsize=64)
        client_id = id(client_queue)
        with self.lock:
            if len(self.clients) >= MAX_BROWSER_WS_CLIENTS:
                raise RealtimeCapacityError("현재 실시간 접속자가 많습니다. 잠시 후 다시 시도해주세요.")
            unique_symbols = self._unique_symbols_locked()
            if symbol not in unique_symbols and len(unique_symbols) >= MAX_REALTIME_SYMBOLS:
                raise RealtimeCapacityError(
                    f"동시에 실시간으로 제공할 수 있는 종목 수({MAX_REALTIME_SYMBOLS}개)에 도달했습니다."
                )
            self.clients[client_id] = {
                "symbol": symbol,
                "market": market,
                "queue": client_queue,
            }
            self._ensure_thread_locked()
            self._schedule_subscription_update_locked()
        return client_id, client_queue

    def unregister(self, client_id: int):
        upstream_to_close = None
        timer_to_cancel = None
        with self.lock:
            self.clients.pop(client_id, None)
            if self.clients:
                self._schedule_subscription_update_locked()
            else:
                upstream_to_close = self.upstream
                timer_to_cancel = self.subscription_timer
                self.subscription_timer = None
                self.last_subscription_serialized = None
        if timer_to_cancel is not None:
            try:
                timer_to_cancel.cancel()
            except Exception:
                pass
        if upstream_to_close is not None:
            try:
                upstream_to_close.close()
            except Exception:
                pass

    def restart(self):
        with self.lock:
            upstream = self.upstream
            self.last_subscription_serialized = None
        if upstream is not None:
            try:
                upstream.close()
            except Exception:
                pass
        self._broadcast({
            "type": "status",
            "status": "reconnecting",
            "message": "실시간 연결을 다시 시작합니다.",
        })

    def _ensure_thread_locked(self):
        if self.thread is None or not self.thread.is_alive():
            self.thread = Thread(target=self._run, name="toss-realtime-hub", daemon=True)
            self.thread.start()

    def _has_clients(self):
        with self.lock:
            return bool(self.clients)

    def _subscription_payload(self):
        with self.lock:
            snapshot = list(self.clients.values())
        kr_codes = sorted({c["symbol"] for c in snapshot if self._is_domestic(c["market"])})
        us_codes = sorted({c["symbol"] for c in snapshot if not self._is_domestic(c["market"])})
        payload = []
        if kr_codes:
            payload.append({"type": "trade:kr", "codes": kr_codes})
        if us_codes:
            payload.append({"type": "trade:us", "codes": us_codes})
        return payload

    def _schedule_subscription_update_locked(self):
        if self.subscription_timer is not None and self.subscription_timer.is_alive():
            return
        timer = Timer(0.35, self._push_subscription_now)
        timer.daemon = True
        self.subscription_timer = timer
        timer.start()

    def _push_subscription_now(self):
        with self.lock:
            self.subscription_timer = None
            ws = self.upstream
            connected = self.connected
        if ws is None or not connected:
            return
        payload = self._subscription_payload()
        serialized = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        with self.lock:
            if serialized == self.last_subscription_serialized:
                return
        try:
            ws.send(serialized)
            with self.lock:
                self.last_subscription_serialized = serialized
        except Exception as exc:
            print(f"[Realtime] subscription update failed: {exc}")

    @staticmethod
    def _put_latest(q: queue.Queue, payload: Dict[str, Any]):
        try:
            q.put_nowait(payload)
            return
        except queue.Full:
            pass
        try:
            q.get_nowait()
        except queue.Empty:
            pass
        try:
            q.put_nowait(payload)
        except queue.Full:
            pass

    def _broadcast(self, payload: Dict[str, Any], symbol: Optional[str] = None):
        symbol = symbol.upper() if symbol else None
        with self.lock:
            targets = [
                c["queue"] for c in self.clients.values()
                if symbol is None or c["symbol"] == symbol
            ]
        for q in targets:
            self._put_latest(q, payload)

    def _run(self):
        backoff = 1.0
        try:
            while self._has_clients():
                client_id, client_secret = get_api_credentials()
                token = get_toss_token(client_id, client_secret)
                if not token:
                    self._broadcast({
                        "type": "status",
                        "status": "error",
                        "message": auth_state.get("message") or "토스 API 인증에 실패했습니다.",
                    })
                    self._sleep_with_client_check(min(backoff, 30))
                    backoff = min(backoff * 2, 30)
                    continue

                self._broadcast({
                    "type": "status",
                    "status": "connecting",
                    "message": "토스 실시간 체결 서버에 연결 중입니다.",
                })

                def on_open(ws):
                    nonlocal backoff
                    backoff = 1.0
                    with self.lock:
                        self.upstream = ws
                        self.connected = True
                    with self.lock:
                        self.last_subscription_serialized = None
                    self._push_subscription_now()

                    def keepalive_loop():
                        while True:
                            time.sleep(55)
                            with self.lock:
                                still_open = self.upstream is ws and self.connected
                            if not still_open:
                                return
                            try:
                                # Toss requires a plain text PING frame, not JSON.
                                ws.send("PING")
                            except Exception:
                                return

                    Thread(target=keepalive_loop, name="toss-ws-keepalive", daemon=True).start()

                def on_message(ws, raw):
                    try:
                        msg = json.loads(raw)
                    except Exception:
                        return
                    frame_type = msg.get("type")
                    if frame_type == "subscriptions":
                        rejected = msg.get("rejected") or []
                        if rejected:
                            self._broadcast({
                                "type": "status",
                                "status": "warning",
                                "message": "일부 실시간 종목 구독이 거부되었습니다.",
                                "rejected": rejected,
                                "subscribed": msg.get("subscribed") or [],
                            })
                        else:
                            self._broadcast({
                                "type": "status",
                                "status": "active",
                                "message": "WebSocket 실시간 체결 구독 중",
                                "subscribed": msg.get("subscribed") or [],
                            })
                        return
                    if frame_type == "error":
                        error = msg.get("error") or {}
                        code = error.get("code", "websocket-error")
                        self._broadcast({
                            "type": "status",
                            "status": "error",
                            "message": error.get("message") or code,
                            "code": code,
                        })
                        if code == "server-shutdown":
                            try:
                                ws.close()
                            except Exception:
                                pass
                        return
                    if frame_type != "message":
                        return

                    topic = str(msg.get("topic", ""))
                    if not topic.startswith("trade:"):
                        return
                    data = msg.get("data") or {}
                    symbol = topic.rsplit(":", 1)[-1].upper()
                    try:
                        price = float(data.get("price"))
                        if not math.isfinite(price) or price <= 0:
                            return
                    except (TypeError, ValueError):
                        return
                    try:
                        volume = float(data.get("volume")) if data.get("volume") is not None else None
                    except (TypeError, ValueError):
                        volume = None
                    self._broadcast({
                        "type": "trade",
                        "symbol": symbol,
                        "price": price,
                        "volume": volume,
                        "timestamp": data.get("timestamp"),
                        "currency": data.get("currency", ""),
                    }, symbol=symbol)

                def on_error(ws, error):
                    message = str(error)
                    print(f"[Realtime] upstream error: {message}")
                    if "401" in message:
                        clear_token_cache()
                    self._broadcast({
                        "type": "status",
                        "status": "reconnecting",
                        "message": "실시간 연결이 끊겨 재연결합니다.",
                    })

                def on_close(ws, code, reason):
                    with self.lock:
                        if self.upstream is ws:
                            self.upstream = None
                            self.connected = False
                            self.last_subscription_serialized = None
                    if self._has_clients():
                        self._broadcast({
                            "type": "status",
                            "status": "reconnecting",
                            "message": "실시간 연결 재시도 중",
                        })

                ws_app = websocket.WebSocketApp(
                    TOSS_WS_URL,
                    header=[f"Authorization: Bearer {token}"],
                    on_open=on_open,
                    on_message=on_message,
                    on_error=on_error,
                    on_close=on_close,
                )
                with self.lock:
                    self.upstream = ws_app
                try:
                    ws_app.run_forever()
                except Exception as exc:
                    print(f"[Realtime] run_forever exception: {exc}")
                finally:
                    with self.lock:
                        if self.upstream is ws_app:
                            self.upstream = None
                            self.connected = False
                            self.last_subscription_serialized = None

                if self._has_clients():
                    self._sleep_with_client_check(backoff + random.uniform(0, min(0.5, backoff / 4)))
                    backoff = min(backoff * 2, 30)
        finally:
            with self.lock:
                self.upstream = None
                self.connected = False
                self.thread = None
                should_restart = bool(self.clients)
            if should_restart:
                with self.lock:
                    self._ensure_thread_locked()

    def _sleep_with_client_check(self, seconds: float):
        deadline = time.monotonic() + max(0, seconds)
        while time.monotonic() < deadline:
            if not self._has_clients():
                return
            time.sleep(min(0.25, max(0, deadline - time.monotonic())))


realtime_hub = TossRealtimeHub()


def fetch_toss_candles(symbol: str, interval: str = "1d", count: int = 150, token: str = "") -> List[Dict[str, Any]]:
    """토스증권 /api/v1/candles 호출 및 수치형 정규화"""
    url = f"{TOSS_API_BASE}/api/v1/candles"
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json"
    }
    params = {
        "symbol": symbol,
        "interval": interval,
        "count": min(count, 200),
        "adjusted": "true"
    }
    
    try:
        resp = requests.get(url, headers=headers, params=params, timeout=10)
        check_market_response(resp)
        if resp.status_code == 200:
            data = resp.json()
            raw_candles = data.get("result", {}).get("candles", [])
            print(f"[Candles] Successfully fetched {len(raw_candles)} candles from Toss API for {symbol}")
            
            normalized = []
            for c in raw_candles:
                try:
                    normalized.append({
                        "timestamp": str(c["timestamp"]),
                        "openPrice": float(c["openPrice"]),
                        "highPrice": float(c["highPrice"]),
                        "lowPrice": float(c["lowPrice"]),
                        "closePrice": float(c["closePrice"]),
                        "volume": float(c.get("volume", 0))
                    })
                except Exception as ex:
                    print(f"[Candle Parse Warning] {ex}")
                    
            # 토스 API는 최신순(내림차순)으로 반환하므로, 차트용으로 과거순(오름차순)으로 정렬
            return sorted(normalized, key=lambda x: x["timestamp"])
        else:
            print(f"[Candle Error] Status {resp.status_code}: {resp.text}")
            return []
    except QuoteError:
        raise
    except Exception:
        raise QuoteError("캔들 데이터를 조회하지 못했습니다.", 502, 5)


def generate_mock_candles(symbol: str, interval: str = "1d", count: int = 150) -> List[Dict[str, Any]]:
    """실제 API 키가 없거나 테스트용으로 생성하는 현실적인 캔들 데이터 시뮬레이터"""
    candles = []
    
    # 종목별 기본 가격대 및 변동성 설정
    presets = {
        "005930": {"name": "삼성전자", "price": 75000, "volatility": 0.015, "market": "KRX"},
        "000660": {"name": "SK하이닉스", "price": 185000, "volatility": 0.022, "market": "KRX"},
        "005380": {"name": "현대차", "price": 240000, "volatility": 0.018, "market": "KRX"},
        "035420": {"name": "NAVER", "price": 180000, "volatility": 0.020, "market": "KRX"},
        "086520": {"name": "에코프로", "price": 95000, "volatility": 0.035, "market": "KRX"},
        "AAPL": {"name": "Apple Inc.", "price": 225, "volatility": 0.014, "market": "US"},
        "NVDA": {"name": "NVIDIA", "price": 130, "volatility": 0.030, "market": "US"},
        "TSLA": {"name": "Tesla", "price": 250, "volatility": 0.035, "market": "US"},
        "MSFT": {"name": "Microsoft", "price": 430, "volatility": 0.015, "market": "US"}
    }
    
    info = presets.get(symbol.upper(), {"name": symbol, "price": 10000 if symbol.isdigit() else 100, "volatility": 0.02, "market": "KRX"})
    current_price = float(info["price"])
    volatility = info["volatility"]
    
    now = datetime.now(timezone.utc)
    rng = random.Random(symbol)  # 다른 요청의 난수 상태에 영향을 주지 않는다
    
    # 시간 간격 결정
    time_delta = timedelta(days=1) if interval == "1d" else timedelta(minutes=1)
    
    # 기준 시작 시각 계산 (영업일 고려)
    timestamps = []
    curr = now
    while len(timestamps) < count:
        if interval == "1d":
            curr -= time_delta
            # 주말 제외
            if curr.weekday() < 5:
                timestamps.append(curr.replace(hour=0, minute=0, second=0, microsecond=0))
        else:
            curr -= time_delta
            timestamps.append(curr)
    
    timestamps.reverse()
    
    trend = 0.0003
    for ts in timestamps:
        # 현실적인 가격 파동 (랜덤 워크 + 약한 추세 + 노이즈)
        pct_change = rng.gauss(trend, volatility)
        open_p = current_price
        close_p = open_p * (1.0 + pct_change)
        
        high_extra = abs(rng.gauss(0, volatility * 0.7))
        low_extra = abs(rng.gauss(0, volatility * 0.7))
        high_p = max(open_p, close_p) * (1.0 + high_extra)
        low_p = min(open_p, close_p) * (1.0 - low_extra)
        
        # 라운딩
        if info["market"] == "KRX":
            open_p = float(round(open_p, -1) if open_p > 1000 else round(open_p))
            close_p = float(round(close_p, -1) if close_p > 1000 else round(close_p))
            high_p = float(round(high_p, -1) if high_p > 1000 else round(high_p))
            low_p = float(round(low_p, -1) if low_p > 1000 else round(low_p))
            vol = float(rng.randint(50000, 3000000))
        else:
            open_p = round(open_p, 2)
            close_p = round(close_p, 2)
            high_p = round(high_p, 2)
            low_p = round(low_p, 2)
            vol = float(rng.randint(100000, 15000000))
            
        current_price = close_p
        
        candles.append({
            "timestamp": ts.isoformat().replace("+00:00", "Z"),
            "openPrice": open_p,
            "highPrice": high_p,
            "lowPrice": low_p,
            "closePrice": close_p,
            "volume": vol
        })
        
    return candles


def calculate_technical_indicators(candles: List[Dict[str, Any]]) -> Dict[str, Any]:
    """이동평균선(SMA 5, 20, 60, 120), 골든/데드크로스, RSI 계산"""
    if not candles:
        return {}
        
    closes = [float(c["closePrice"]) for c in candles]
    timestamps = [str(c["timestamp"]) for c in candles]
    n = len(closes)
    
    def sma(period: int) -> List[Optional[float]]:
        res = [None] * n
        for i in range(period - 1, n):
            sub = closes[i - period + 1:i + 1]
            res[i] = round(sum(sub) / period, 2)
        return res
        
    sma5 = sma(5)
    sma20 = sma(20)
    sma60 = sma(60)
    sma120 = sma(120)
    
    # 골든크로스 / 데드크로스 탐지 (5일선과 20일선 기준)
    cross_signals = []
    for i in range(1, n):
        prev_5, curr_5 = sma5[i - 1], sma5[i]
        prev_20, curr_20 = sma20[i - 1], sma20[i]
        
        if prev_5 is not None and curr_5 is not None and prev_20 is not None and curr_20 is not None:
            # 골든크로스: 이전에는 5일선이 20일선 아래였다가 현재 20일선 위로 돌파
            if prev_5 <= prev_20 and curr_5 > curr_20:
                cross_signals.append({
                    "type": "GOLDEN_CROSS",
                    "title": "골든크로스 (매수 신호)",
                    "index": i,
                    "timestamp": timestamps[i],
                    "price": closes[i],
                    "sma5": curr_5,
                    "sma20": curr_20,
                    "description": f"5일선({curr_5:,.1f})이 20일선({curr_20:,.1f})을 상향 돌파"
                })
            # 데드크로스: 이전에는 5일선이 20일선 위였다가 현재 20일선 아래로 이탈
            elif prev_5 >= prev_20 and curr_5 < curr_20:
                cross_signals.append({
                    "type": "DEAD_CROSS",
                    "title": "데드크로스 (매도 신호)",
                    "index": i,
                    "timestamp": timestamps[i],
                    "price": closes[i],
                    "sma5": curr_5,
                    "sma20": curr_20,
                    "description": f"5일선({curr_5:,.1f})이 20일선({curr_20:,.1f})을 하향 이탈"
                })

    # RSI (14) 계산
    rsi = [None] * n
    if n > 14:
        gains = []
        losses = []
        for i in range(1, 15):
            diff = closes[i] - closes[i - 1]
            gains.append(max(0, diff))
            losses.append(max(0, -diff))
            
        avg_gain = sum(gains) / 14
        avg_loss = sum(losses) / 14
        rs = avg_gain / avg_loss if avg_loss != 0 else 100
        rsi[14] = round(100 - (100 / (1 + rs)), 2)
        
        for i in range(15, n):
            diff = closes[i] - closes[i - 1]
            gain = max(0, diff)
            loss = max(0, -diff)
            avg_gain = (avg_gain * 13 + gain) / 14
            avg_loss = (avg_loss * 13 + loss) / 14
            rs = avg_gain / avg_loss if avg_loss != 0 else 100
            rsi[i] = round(100 - (100 / (1 + rs)), 2)
            
    # 현재 배열 상태 분석 (최근 캔들 기준)
    arrangement = "혼조세"
    c5, c20, c60, c120 = sma5[-1], sma20[-1], sma60[-1], sma120[-1]
    if c5 and c20 and c60:
        if c5 > c20 > c60:
            arrangement = "정배열 (상승 추세)"
        elif c5 < c20 < c60:
            arrangement = "역배열 (하락 추세)"
            
    return {
        "sma5": [{"timestamp": timestamps[i], "value": sma5[i]} for i in range(n) if sma5[i] is not None],
        "sma20": [{"timestamp": timestamps[i], "value": sma20[i]} for i in range(n) if sma20[i] is not None],
        "sma60": [{"timestamp": timestamps[i], "value": sma60[i]} for i in range(n) if sma60[i] is not None],
        "sma120": [{"timestamp": timestamps[i], "value": sma120[i]} for i in range(n) if sma120[i] is not None],
        "cross_signals": cross_signals,
        "rsi": [{"timestamp": timestamps[i], "value": rsi[i]} for i in range(n) if rsi[i] is not None],
        "latest_summary": {
            "close": closes[-1],
            "sma5": c5,
            "sma20": c20,
            "sma60": c60,
            "sma120": c120,
            "rsi": rsi[-1],
            "arrangement": arrangement,
            "last_signal": cross_signals[-1] if cross_signals else None
        }
    }


# ================= Routes =================

@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.after_request
def no_market_cache(response):
    if request.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.route("/api/version")
def api_version():
    return jsonify({"version": BUILD_VERSION})


@app.route("/healthz")
def healthz():
    return jsonify({"ok": True, "version": BUILD_VERSION})


@app.route("/api/status")
def public_status():
    client_id, client_secret = get_api_credentials()
    configured = bool(client_id and client_secret)
    return jsonify({
        "configured": configured,
        "mode": "live" if configured else ("demo" if ALLOW_DEMO else "unconfigured"),
        "realtime": configured,
        "version": BUILD_VERSION,
        "max_realtime_symbols": MAX_REALTIME_SYMBOLS,
    })


@app.route("/api/search")
def search_route():
    q = request.args.get("q", "").strip().lower()
    if not q:
        return jsonify([])
        
    q_nospace = q.replace(" ", "")
    results = []
    
    # 1. Prefix matches first
    for s in stock_master_list:
        sym = s["symbol"].lower()
        nm = s["name"].lower()
        nm_nospace = nm.replace(" ", "")
        
        if sym.startswith(q) or nm_nospace.startswith(q_nospace):
            results.append({
                "symbol": s["symbol"],
                "name": s["name"],
                "market": s.get("market", "KRX")
            })
            if len(results) >= 10:
                break
                
    # 2. Substring matches next
    if len(results) < 10:
        for s in stock_master_list:
            sym = s["symbol"].lower()
            nm = s["name"].lower()
            if q in sym or q_nospace in nm.replace(" ", ""):
                item = {
                    "symbol": s["symbol"],
                    "name": s["name"],
                    "market": s.get("market", "KRX")
                }
                if item not in results:
                    results.append(item)
                    if len(results) >= 10:
                        break
                        
    return jsonify(results)


@app.route("/api/candles")
def get_candles():
    try:
        raw_query = request.args.get("symbol", "005930").strip()
        interval = request.args.get("interval", "1d").strip().lower()
        count = int(request.args.get("count", 150))
        force_mock = ALLOW_DEMO and request.args.get("mock", "false").lower() == "true"
        if not raw_query or interval not in ("1d", "1m") or not 1 <= count <= 200:
            return jsonify(success=False, error="종목, 봉 단위(1d/1m), 조회 개수(1~200)를 확인해주세요."), 400
        
        # Resolve symbol, name, and market from stock master
        resolved_symbol, stock_name, market = resolve_stock(raw_query)
        
        client_id, client_secret = get_api_credentials()
        has_keys = bool(client_id and client_secret)
        
        candles = []
        is_live = False
        quote = None
        fetched_at = datetime.now(timezone.utc).isoformat()
        
        # If API keys are registered, use live Toss API
        if not force_mock and has_keys:
            token = get_toss_token(client_id, client_secret)
            if not token:
                status = auth_state.get("status") if auth_state.get("status") in (401, 403) else 502
                return jsonify({
                    "success": False,
                    "error": auth_state.get("message") or "토스 API 인증에 실패했습니다.",
                    "auth_status": auth_state.get("status"),
                    "auth_code": auth_state.get("code"),
                }), status
            if token:
                candles, quote, fetched_at = fetch_market_snapshot(
                    resolved_symbol, interval, count, token, use_cache=True
                )
                if candles:
                    is_live = True
                else:
                    # TOSS API returned 0 candles! Do NOT generate fake mock data in live mode!
                    return jsonify({
                        "success": False,
                        "error": f"종목 '{raw_query}'(코드: {resolved_symbol})의 시세 데이터를 찾을 수 없습니다. 종목명(예: 카카오, 삼성전자)이나 올바른 종목코드를 입력해주세요.",
                        "symbol": resolved_symbol,
                        "name": stock_name
                    }), 404
                    
        # Public mode never asks visitors for credentials. Demo data is optional and disabled by default.
        if not candles:
            if ALLOW_DEMO and (not has_keys or force_mock):
                candles = generate_mock_candles(resolved_symbol, interval, count)
                is_live = False
            elif not has_keys:
                return jsonify({
                    "success": False,
                    "error": "서버에 토스 Open API 환경변수가 설정되지 않았습니다. 운영자가 TOSS_CLIENT_ID와 TOSS_CLIENT_SECRET을 설정해야 합니다."
                }), 503
            else:
                return jsonify({
                    "success": False,
                    "error": f"종목 '{raw_query}'의 시세 데이터를 조회할 수 없습니다."
                }), 404
            
        # Calculate indicators
        analysis = calculate_technical_indicators(candles)
        
        # Format for TradingView Lightweight Charts (deduplicate times)
        formatted_candles = []
        formatted_volume = []
        seen_times = set()
        
        for c in candles:
            ts_str = str(c["timestamp"])
            try:
                dt = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                time_val = dt.strftime("%Y-%m-%d") if interval == "1d" else int(dt.timestamp())
            except Exception:
                time_val = ts_str[:10] if interval == "1d" else int(time.time())
                
            if time_val in seen_times:
                continue
            seen_times.add(time_val)
            
            o = float(c["openPrice"])
            h = float(c["highPrice"])
            l = float(c["lowPrice"])
            cl = float(c["closePrice"])
            vol = float(c.get("volume", 0))
            
            formatted_candles.append({
                "time": time_val,
                "open": o,
                "high": h,
                "low": l,
                "close": cl
            })
            
            formatted_volume.append({
                "time": time_val,
                "value": vol,
                "color": "rgba(240, 68, 82, 0.45)" if cl >= o else "rgba(49, 130, 246, 0.45)"
            })
            
        return jsonify({
            "success": True,
            "symbol": resolved_symbol,
            "name": stock_name,
            "market": market,
            "interval": interval,
            "is_live": is_live,
            "quote": quote,
            "fetched_at": fetched_at,
            "refresh_after_ms": 2000,
            "candles": formatted_candles,
            "volume": formatted_volume,
            "analysis": analysis
        })
    except QuoteError as e:
        response = jsonify(success=False, error=str(e), retry_after_ms=e.retry_after * 1000)
        response.headers["Retry-After"] = str(e.retry_after)
        return response, e.status
    except ValueError:
        return jsonify(success=False, error="조회 개수는 1~200 사이의 정수여야 합니다."), 400
    except Exception as e:
        print(f"[API Candles Error] {e}")
        import traceback
        traceback.print_exc()
        return jsonify({
            "success": False,
            "error": str(e),
            "candles": [],
            "volume": [],
            "analysis": {}
        }), 500



@sock.route("/ws/market")
def market_websocket(ws):
    """브라우저용 WebSocket. 토스 체결 스트림을 서버에서 인증한 뒤 안전하게 중계한다."""
    raw_query = request.args.get("symbol", "005930").strip()
    if not raw_query:
        ws.send(json.dumps({"type": "status", "status": "error", "message": "종목 코드가 필요합니다."}, ensure_ascii=False))
        return

    symbol, stock_name, market = resolve_stock(raw_query)
    client_id, client_secret = get_api_credentials()
    if not (client_id and client_secret):
        ws.send(json.dumps({
            "type": "status",
            "status": "error",
            "message": "서버의 토스 Open API 설정이 완료되지 않았습니다.",
        }, ensure_ascii=False))
        return

    try:
        client_id, client_queue = realtime_hub.register(symbol, market)
    except RealtimeCapacityError as exc:
        ws.send(json.dumps({
            "type": "status",
            "status": "error",
            "message": str(exc),
        }, ensure_ascii=False))
        return

    try:
        ws.send(json.dumps({
            "type": "status",
            "status": "connecting",
            "message": "실시간 체결 구독을 준비합니다.",
            "symbol": symbol,
            "name": stock_name,
            "market": market,
        }, ensure_ascii=False))
        while True:
            try:
                payload = client_queue.get(timeout=25)
            except queue.Empty:
                payload = {
                    "type": "heartbeat",
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                }
            ws.send(json.dumps(payload, ensure_ascii=False))
    except Exception:
        pass
    finally:
        realtime_hub.unregister(client_id)



if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    client_id, client_secret = get_api_credentials()
    configured = bool(client_id and client_secret)
    print("\n==================================================")
    print(f"  Toss Stock Chart Server [{BUILD_VERSION}]")
    print(f"  Browser: http://127.0.0.1:{port}")
    print(f"  Toss credentials: {'configured' if configured else 'NOT configured'}")
    print("==================================================\n")
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)
