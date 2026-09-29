/**
 * Toss Stock Chart Pro - Frontend Engine
 * TradingView Lightweight Charts & Technical Indicator Visualizer
 */

// Stock Preset Metadata
const STOCK_PRESETS = {
  "005930": { name: "삼성전자", market: "KRX", currency: "KRW" },
  "000660": { name: "SK하이닉스", market: "KRX", currency: "KRW" },
  "005380": { name: "현대차", market: "KRX", currency: "KRW" },
  "035420": { name: "NAVER", market: "KRX", currency: "KRW" },
  "086520": { name: "에코프로", market: "KRX", currency: "KRW" },
  "035720": { name: "카카오", market: "KRX", currency: "KRW" },
  "AAPL": { name: "애플 (Apple)", market: "NASDAQ", currency: "USD" },
  "NVDA": { name: "엔비디아 (NVIDIA)", market: "NASDAQ", currency: "USD" },
  "TSLA": { name: "테슬라 (Tesla)", market: "NASDAQ", currency: "USD" },
  "MSFT": { name: "마이크로소프트 (MSFT)", market: "NASDAQ", currency: "USD" }
};

// State
let currentSymbol = "005930";
let currentInterval = "1d";
let isLiveApi = false;
let currentData = null;
let currentStockInfo = { symbol: "005930", name: "삼성전자", market: "KOSPI" };

// Realtime state: Toss WebSocket trades + periodic REST integrity sync
let marketSocket = null;
let marketSocketGeneration = 0;
let marketReconnectTimer = null;
let marketReconnectFailures = 0;
let snapshotTimer = null;
let snapshotController = null;
let requestGeneration = 0;
let latestRealtimeTrade = null;
let realtimeAnalysisTimer = null;
const SNAPSHOT_RESYNC_MS = 60000;
const REALTIME_ANALYSIS_THROTTLE_MS = 200;

// Charts & Series References
let mainChart = null;
let volumeChart = null;
let rsiChart = null;

let candleSeries = null;
let volumeSeries = null;
let ma5Series = null;
let ma20Series = null;
let ma60Series = null;
let ma120Series = null;
let rsiSeries = null;

// DOM Elements
const symbolInput = document.getElementById("symbolInput");
const searchBtn = document.getElementById("searchBtn");
const searchDropdown = document.getElementById("searchDropdown");
const presetChips = document.getElementById("presetChips");
const apiStatusBadge = document.getElementById("apiStatusBadge");
const loadingOverlay = document.getElementById("loadingOverlay");
const chartTooltip = document.getElementById("chartTooltip");

// Stock Info Elements
const displayStockName = document.getElementById("displayStockName");
const displayStockSymbol = document.getElementById("displayStockSymbol");
const displayMarketTag = document.getElementById("displayMarketTag");
const displayStockPrice = document.getElementById("displayStockPrice");
const displayCurrency = document.getElementById("displayCurrency");
const displayStockChange = document.getElementById("displayStockChange");

// Indicator Toggles
const toggleMA5 = document.getElementById("toggleMA5");
const toggleMA20 = document.getElementById("toggleMA20");
const toggleMA60 = document.getElementById("toggleMA60");
const toggleMA120 = document.getElementById("toggleMA120");
const toggleCrossMarkers = document.getElementById("toggleCrossMarkers");
const toggleRSI = document.getElementById("toggleRSI");

// Diagnosis Elements
const trendBadge = document.getElementById("trendBadge");
const diagArrangement = document.getElementById("diagArrangement");
const diagLastCross = document.getElementById("diagLastCross");
const diagRSI = document.getElementById("diagRSI");
const diagDisparity = document.getElementById("diagDisparity");
const signalAlertBox = document.getElementById("signalAlertBox");
const alertTitle = document.getElementById("alertTitle");
const alertDesc = document.getElementById("alertDesc");
const valMA5 = document.getElementById("valMA5");
const valMA20 = document.getElementById("valMA20");
const valMA60 = document.getElementById("valMA60");
const valMA120 = document.getElementById("valMA120");
const signalList = document.getElementById("signalList");
const crossCount = document.getElementById("crossCount");


// ================= Initialize Charts =================

function initCharts() {
  const chartCommonOptions = {
    layout: {
      background: { color: "#0b0e14" },
      textColor: "#94a3b8",
      fontFamily: "'JetBrains Mono', 'Pretendard', sans-serif"
    },
    grid: {
      vertLines: { color: "rgba(255, 255, 255, 0.05)" },
      horzLines: { color: "rgba(255, 255, 255, 0.05)" }
    },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
      vertLine: {
        color: "rgba(255, 255, 255, 0.2)",
        width: 1,
        style: LightweightCharts.LineStyle.Dashed
      },
      horzLine: {
        color: "rgba(255, 255, 255, 0.2)",
        width: 1,
        style: LightweightCharts.LineStyle.Dashed
      }
    },
    timeScale: {
      borderColor: "rgba(255, 255, 255, 0.08)",
      timeVisible: true,
      secondsVisible: false
    }
  };

  // 1. Main Candlestick Chart
  const mainContainer = document.getElementById("mainChart");
  mainChart = LightweightCharts.createChart(mainContainer, {
    ...chartCommonOptions,
    height: mainContainer.clientHeight || 450,
    rightPriceScale: {
      borderColor: "rgba(255, 255, 255, 0.08)",
      scaleMargins: { top: 0.1, bottom: 0.15 }
    }
  });

  candleSeries = mainChart.addCandlestickSeries({
    upColor: "#f04452",           // 상승(빨강)
    downColor: "#3182f6",         // 하락(파랑)
    borderUpColor: "#f04452",
    borderDownColor: "#3182f6",
    wickUpColor: "#f04452",
    wickDownColor: "#3182f6"
  });

  // Moving Average Series
  ma5Series = mainChart.addLineSeries({
    color: "#f59e0b",
    lineWidth: 1.5,
    title: "MA 5",
    priceLineVisible: false,
    crosshairMarkerVisible: true
  });

  ma20Series = mainChart.addLineSeries({
    color: "#38bdf8",
    lineWidth: 2,
    title: "MA 20",
    priceLineVisible: false,
    crosshairMarkerVisible: true
  });

  ma60Series = mainChart.addLineSeries({
    color: "#a855f7",
    lineWidth: 1.5,
    title: "MA 60",
    priceLineVisible: false,
    crosshairMarkerVisible: true
  });

  ma120Series = mainChart.addLineSeries({
    color: "#fb923c",
    lineWidth: 1.5,
    title: "MA 120",
    priceLineVisible: false,
    crosshairMarkerVisible: true
  });

  // 2. Volume Sub-chart
  const volumeContainer = document.getElementById("volumeChart");
  volumeChart = LightweightCharts.createChart(volumeContainer, {
    ...chartCommonOptions,
    height: volumeContainer.clientHeight || 120,
    rightPriceScale: {
      borderColor: "rgba(255, 255, 255, 0.08)",
      scaleMargins: { top: 0.2, bottom: 0 }
    }
  });

  volumeSeries = volumeChart.addHistogramSeries({
    priceFormat: { type: "volume" }
  });

  // 3. RSI Sub-chart
  const rsiContainer = document.getElementById("rsiChart");
  rsiChart = LightweightCharts.createChart(rsiContainer, {
    ...chartCommonOptions,
    height: rsiContainer.clientHeight || 120,
    rightPriceScale: {
      borderColor: "rgba(255, 255, 255, 0.08)",
      scaleMargins: { top: 0.1, bottom: 0.1 }
    }
  });

  rsiSeries = rsiChart.addLineSeries({
    color: "#60a5fa",
    lineWidth: 1.5,
    title: "RSI(14)"
  });

  // Add RSI 70 and 30 baseline markers
  rsiSeries.createPriceLine({
    price: 70,
    color: "rgba(240, 68, 82, 0.6)",
    lineWidth: 1,
    lineStyle: LightweightCharts.LineStyle.Dotted,
    axisLabelVisible: true,
    title: "과매수 70"
  });

  rsiSeries.createPriceLine({
    price: 30,
    color: "rgba(49, 130, 246, 0.6)",
    lineWidth: 1,
    lineStyle: LightweightCharts.LineStyle.Dotted,
    axisLabelVisible: true,
    title: "과매도 30"
  });

  // Time Scale Synchronization across Charts
  syncTimeScales([mainChart, volumeChart, rsiChart]);

  // Crosshair Tooltip
  setupCrosshairTooltip();

  // Resize Observer
  const resizeObserver = new ResizeObserver(() => {
    mainChart.applyOptions({ width: mainContainer.clientWidth, height: mainContainer.clientHeight });
    volumeChart.applyOptions({ width: volumeContainer.clientWidth, height: volumeContainer.clientHeight });
    rsiChart.applyOptions({ width: rsiContainer.clientWidth, height: rsiContainer.clientHeight });
  });
  resizeObserver.observe(document.querySelector(".charts-wrapper"));
}

function syncTimeScales(charts) {
  let isSyncing = false;
  charts.forEach((sourceChart) => {
    sourceChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (isSyncing || !range) return;
      isSyncing = true;
      charts.forEach((targetChart) => {
        if (targetChart !== sourceChart) {
          targetChart.timeScale().setVisibleLogicalRange(range);
        }
      });
      isSyncing = false;
    });
  });
}

function setupCrosshairTooltip() {
  mainChart.subscribeCrosshairMove((param) => {
    if (!param.time || !param.point || param.point.x < 0 || param.point.y < 0) {
      chartTooltip.style.display = "none";
      return;
    }

    const candle = param.seriesData.get(candleSeries);
    if (!candle) {
      chartTooltip.style.display = "none";
      return;
    }

    const o = candle.open;
    const h = candle.high;
    const l = candle.low;
    const c = candle.close;
    const diff = c - o;
    const diffPct = ((diff / o) * 100).toFixed(2);
    const diffClass = diff >= 0 ? "val-up" : "val-down";
    const sign = diff >= 0 ? "+" : "";

    const dateStr = typeof param.time === "object" 
      ? `${param.time.year}-${String(param.time.month).padStart(2, "0")}-${String(param.time.day).padStart(2, "0")}`
      : new Date(param.time * 1000).toLocaleString();

    chartTooltip.style.display = "block";
    chartTooltip.innerHTML = `
      <span>날짜: <strong>${dateStr}</strong></span>
      <span>시가: ${o.toLocaleString()}</span>
      <span>고가: ${h.toLocaleString()}</span>
      <span>저가: ${l.toLocaleString()}</span>
      <span>종가: <strong class="${diffClass}">${c.toLocaleString()} (${sign}${diffPct}%)</strong></span>
    `;
  });
}


// ================= Data Fetching & Rendering =================

function clearSnapshotTimer() {
  if (snapshotTimer) {
    clearTimeout(snapshotTimer);
    snapshotTimer = null;
  }
}

function abortSnapshotRequest() {
  if (snapshotController) {
    snapshotController.abort();
    snapshotController = null;
  }
}

function disconnectMarketSocket() {
  marketSocketGeneration += 1;
  if (marketReconnectTimer) {
    clearTimeout(marketReconnectTimer);
    marketReconnectTimer = null;
  }
  if (marketSocket) {
    const ws = marketSocket;
    marketSocket = null;
    try { ws.close(1000, "selection changed"); } catch (_) {}
  }
}

function scheduleSnapshotSync(delayMs = SNAPSHOT_RESYNC_MS, generation = requestGeneration) {
  clearSnapshotTimer();
  if (!isLiveApi || document.hidden || !currentData) return;
  snapshotTimer = setTimeout(() => {
    loadStockData(currentSymbol, currentInterval, {
      background: true,
      generation
    });
  }, Math.max(1000, Number(delayMs) || SNAPSHOT_RESYNC_MS));
}

function formatQuoteTime(timestamp) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function setRealtimeStatus(text, kind = "live") {
  apiStatusBadge.className = kind === "live" ? "status-badge live" : "status-badge";
  apiStatusBadge.querySelector(".status-text").textContent = text;
}

function connectMarketSocket(symbol) {
  disconnectMarketSocket();
  if (!isLiveApi || document.hidden || !symbol) return;

  const generation = marketSocketGeneration;
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const url = `${scheme}://${location.host}/ws/market?symbol=${encodeURIComponent(symbol)}`;
  const ws = new WebSocket(url);
  marketSocket = ws;
  setRealtimeStatus("WebSocket 연결 중...", "live");

  ws.addEventListener("open", () => {
    if (generation !== marketSocketGeneration || marketSocket !== ws) return;
    setRealtimeStatus("WebSocket 연결됨 · 체결 구독 대기", "live");
  });

  ws.addEventListener("message", (event) => {
    if (generation !== marketSocketGeneration || marketSocket !== ws) return;
    let msg;
    try { msg = JSON.parse(event.data); } catch (_) { return; }

    if (msg.type === "trade") {
      if (String(msg.symbol || "").toUpperCase() !== String(currentSymbol).toUpperCase()) return;
      marketReconnectFailures = 0;
      latestRealtimeTrade = msg;
      applyRealtimeTrade(msg);
      const t = formatQuoteTime(msg.timestamp);
      setRealtimeStatus(t ? `WebSocket 실시간 · ${t}` : "WebSocket 실시간", "live");
      return;
    }

    if (msg.type === "status") {
      if (msg.status === "active") {
        marketReconnectFailures = 0;
        setRealtimeStatus("WebSocket 실시간 · 체결 대기", "live");
      } else if (msg.status === "warning") {
        setRealtimeStatus(msg.message || "일부 실시간 구독 실패", "warn");
      } else if (msg.status === "error") {
        setRealtimeStatus(msg.message || "실시간 연결 오류", "warn");
      } else {
        setRealtimeStatus(msg.message || "WebSocket 재연결 중...", "live");
      }
    }
  });

  ws.addEventListener("close", () => {
    if (generation !== marketSocketGeneration || marketSocket !== ws) return;
    marketSocket = null;
    if (!isLiveApi || document.hidden) return;
    marketReconnectFailures += 1;
    const delay = Math.min(30000, 1000 * (2 ** Math.min(marketReconnectFailures - 1, 5)));
    setRealtimeStatus(`브라우저 실시간 연결 재시도 · ${Math.ceil(delay / 1000)}초`, "warn");
    marketReconnectTimer = setTimeout(() => {
      if (generation === marketSocketGeneration && isLiveApi && !document.hidden) {
        connectMarketSocket(currentSymbol);
      }
    }, delay);
  });

  ws.addEventListener("error", () => {
    if (generation === marketSocketGeneration && marketSocket === ws) {
      setRealtimeStatus("WebSocket 연결 확인 중...", "warn");
    }
  });
}

async function loadStockData(query, interval = "1d", options = {}) {
  const background = options.background === true;
  let generation = options.generation;

  if (!background) {
    requestGeneration += 1;
    generation = requestGeneration;
    clearSnapshotTimer();
    abortSnapshotRequest();
    disconnectMarketSocket();
    latestRealtimeTrade = null;
    marketReconnectFailures = 0;
    showLoading(true);
  } else {
    if (generation !== requestGeneration || document.hidden) return;
    if (snapshotController) return;
  }

  const ownController = new AbortController();
  snapshotController = ownController;
  const timeoutId = setTimeout(() => ownController.abort(), 35000);

  try {
    const params = new URLSearchParams({
      symbol: query,
      interval,
      count: "150"
    });
    const res = await fetch(`/api/candles?${params.toString()}`, {
      cache: "no-store",
      signal: ownController.signal
    });
    const data = await parseJsonResponse(res, "시세 조회");

    if (generation !== requestGeneration) return;
    if (!res.ok || data.success === false) {
      const error = new Error(data.error || `서버 응답 오류 (HTTP ${res.status})`);
      error.retryAfterMs = Number(data.retry_after_ms) || 0;
      throw error;
    }
    if (!data.candles || data.candles.length === 0) {
      throw new Error("조회된 캔들 데이터가 없습니다.");
    }

    currentSymbol = data.symbol;
    currentInterval = data.interval || interval;
    currentStockInfo = {
      symbol: data.symbol,
      name: data.name || data.symbol,
      market: data.market || "KRX"
    };
    currentData = data;

    renderData(data, { preserveView: background });

    if (data.is_live) {
      isLiveApi = true;
      if (!background || !marketSocket) {
        setRealtimeStatus("WebSocket 실시간 준비 중", "live");
        connectMarketSocket(data.symbol);
      } else {
        setRealtimeStatus("WebSocket 실시간 · REST 정합성 동기화 완료", "live");
      }

      // REST 응답 직전에 받은 더 최신 체결만 다시 덮어쓴다.
      if (latestRealtimeTrade && String(latestRealtimeTrade.symbol).toUpperCase() === String(data.symbol).toUpperCase()) {
        const tradeMs = Date.parse(latestRealtimeTrade.timestamp || "");
        const quoteMs = Date.parse(data.quote?.timestamp || "");
        if (!Number.isFinite(tradeMs) || !Number.isFinite(quoteMs) || tradeMs >= quoteMs) {
          applyRealtimeTrade(latestRealtimeTrade, { skipBoundarySync: true });
        }
      }
      scheduleSnapshotSync(SNAPSHOT_RESYNC_MS, generation);
    } else {
      isLiveApi = false;
      disconnectMarketSocket();
      clearSnapshotTimer();
      setRealtimeStatus("시뮬레이터 모드 (Demo)", "demo");
    }
  } catch (err) {
    if (generation !== requestGeneration || err.name === "AbortError") return;
    console.error(background ? "정합성 동기화 실패:" : "데이터 로드 실패:", err);
    if (!background) {
      alert(`시세 데이터를 가져오는데 실패했습니다:\n${err.message}`);
    } else {
      const retryDelay = Math.max(Number(err.retryAfterMs) || 0, 15000);
      setRealtimeStatus(`REST 정합성 동기화 지연 · ${Math.ceil(retryDelay / 1000)}초 후 재시도`, "warn");
      scheduleSnapshotSync(retryDelay, generation);
    }
  } finally {
    clearTimeout(timeoutId);
    if (snapshotController === ownController) snapshotController = null;
    if (!background) showLoading(false);
  }
}

function renderData(data, options = {}) {
  const { preserveView = false } = options;
  const { candles, volume, analysis, symbol, interval } = data;
  if (!candles || candles.length === 0) return;

  const visibleRanges = preserveView ? [
    mainChart.timeScale().getVisibleLogicalRange(),
    volumeChart.timeScale().getVisibleLogicalRange(),
    rsiChart.timeScale().getVisibleLogicalRange()
  ] : null;

  // 1. Update Header Info - REST 현재가(quote)를 캔들 종가보다 우선 사용
  updateHeaderInfo(symbol, candles, data.name, data.market, data.quote);

  // 2. Set Candlestick & Volume Data
  candleSeries.setData(candles);
  volumeSeries.setData(volume);

  // 3. Set Moving Average / RSI Data
  ma5Series.setData(formatAnalysisSeries(analysis.sma5 || [], interval));
  ma20Series.setData(formatAnalysisSeries(analysis.sma20 || [], interval));
  ma60Series.setData(formatAnalysisSeries(analysis.sma60 || [], interval));
  ma120Series.setData(formatAnalysisSeries(analysis.sma120 || [], interval));
  rsiSeries.setData(formatAnalysisSeries(analysis.rsi || [], interval));

  // 4. Update Cross Markers / Sidebar
  updateMarkers(analysis.cross_signals || [], interval);
  updateSidebar(analysis, candles);

  // 첫 조회에서만 전체 구간을 맞춘다. 자동 갱신 때는 사용자의 줌/이동 상태를 보존한다.
  if (!preserveView) {
    mainChart.timeScale().fitContent();
    volumeChart.timeScale().fitContent();
    rsiChart.timeScale().fitContent();
  } else if (visibleRanges) {
    const chartList = [mainChart, volumeChart, rsiChart];
    visibleRanges.forEach((range, index) => {
      if (range) chartList[index].timeScale().setVisibleLogicalRange(range);
    });
  }
}

function formatAnalysisSeries(arr, interval) {
  const seen = new Set();
  const result = [];
  for (const item of arr) {
    let t = item.timestamp;
    if (interval === "1d") {
      t = String(t).substring(0, 10);
    } else {
      t = Math.floor(new Date(t).getTime() / 1000);
    }
    if (!seen.has(t) && Number.isFinite(Number(item.value))) {
      seen.add(t);
      result.push({ time: t, value: Number(item.value) });
    }
  }
  return result;
}

function tradeBucketTime(timestamp, interval) {
  if (interval === "1d") {
    const raw = String(timestamp || "");
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
    return new Date().toISOString().slice(0, 10);
  }
  const ms = Date.parse(timestamp || "");
  const safeMs = Number.isFinite(ms) ? ms : Date.now();
  return Math.floor(safeMs / 60000) * 60;
}

function candleAnalysisTimestamp(time, interval) {
  if (interval === "1d") return `${String(time).slice(0, 10)}T00:00:00`;
  return new Date(Number(time) * 1000).toISOString();
}

function calculateRealtimeAnalysis(candles, interval) {
  if (!candles || !candles.length) return {};
  const closes = candles.map(c => Number(c.close));
  const timestamps = candles.map(c => candleAnalysisTimestamp(c.time, interval));
  const n = closes.length;

  const sma = (period) => {
    const out = Array(n).fill(null);
    let rolling = 0;
    for (let i = 0; i < n; i += 1) {
      rolling += closes[i];
      if (i >= period) rolling -= closes[i - period];
      if (i >= period - 1) out[i] = Math.round((rolling / period) * 100) / 100;
    }
    return out;
  };

  const sma5 = sma(5);
  const sma20 = sma(20);
  const sma60 = sma(60);
  const sma120 = sma(120);
  const crossSignals = [];

  for (let i = 1; i < n; i += 1) {
    const prev5 = sma5[i - 1], curr5 = sma5[i];
    const prev20 = sma20[i - 1], curr20 = sma20[i];
    if (prev5 == null || curr5 == null || prev20 == null || curr20 == null) continue;
    if (prev5 <= prev20 && curr5 > curr20) {
      crossSignals.push({
        type: "GOLDEN_CROSS",
        title: "골든크로스 (매수 신호)",
        index: i,
        timestamp: timestamps[i],
        price: closes[i],
        sma5: curr5,
        sma20: curr20,
        description: `5일선(${curr5.toLocaleString(undefined, { maximumFractionDigits: 1 })})이 20일선(${curr20.toLocaleString(undefined, { maximumFractionDigits: 1 })})을 상향 돌파`
      });
    } else if (prev5 >= prev20 && curr5 < curr20) {
      crossSignals.push({
        type: "DEAD_CROSS",
        title: "데드크로스 (매도 신호)",
        index: i,
        timestamp: timestamps[i],
        price: closes[i],
        sma5: curr5,
        sma20: curr20,
        description: `5일선(${curr5.toLocaleString(undefined, { maximumFractionDigits: 1 })})이 20일선(${curr20.toLocaleString(undefined, { maximumFractionDigits: 1 })})을 하향 이탈`
      });
    }
  }

  const rsi = Array(n).fill(null);
  if (n > 14) {
    let gains = 0, losses = 0;
    for (let i = 1; i <= 14; i += 1) {
      const diff = closes[i] - closes[i - 1];
      gains += Math.max(0, diff);
      losses += Math.max(0, -diff);
    }
    let avgGain = gains / 14;
    let avgLoss = losses / 14;
    let rs = avgLoss !== 0 ? avgGain / avgLoss : 100;
    rsi[14] = Math.round((100 - (100 / (1 + rs))) * 100) / 100;
    for (let i = 15; i < n; i += 1) {
      const diff = closes[i] - closes[i - 1];
      const gain = Math.max(0, diff);
      const loss = Math.max(0, -diff);
      avgGain = (avgGain * 13 + gain) / 14;
      avgLoss = (avgLoss * 13 + loss) / 14;
      rs = avgLoss !== 0 ? avgGain / avgLoss : 100;
      rsi[i] = Math.round((100 - (100 / (1 + rs))) * 100) / 100;
    }
  }

  const c5 = sma5[n - 1], c20 = sma20[n - 1], c60 = sma60[n - 1], c120 = sma120[n - 1];
  let arrangement = "혼조세";
  if (c5 && c20 && c60) {
    if (c5 > c20 && c20 > c60) arrangement = "정배열 (상승 추세)";
    else if (c5 < c20 && c20 < c60) arrangement = "역배열 (하락 추세)";
  }

  const makeSeries = values => values
    .map((value, i) => value == null ? null : ({ timestamp: timestamps[i], value }))
    .filter(Boolean);

  return {
    sma5: makeSeries(sma5),
    sma20: makeSeries(sma20),
    sma60: makeSeries(sma60),
    sma120: makeSeries(sma120),
    cross_signals: crossSignals,
    rsi: makeSeries(rsi),
    latest_summary: {
      close: closes[n - 1],
      sma5: c5,
      sma20: c20,
      sma60: c60,
      sma120: c120,
      rsi: rsi[n - 1],
      arrangement,
      last_signal: crossSignals.length ? crossSignals[crossSignals.length - 1] : null
    }
  };
}

function refreshRealtimeIndicators() {
  realtimeAnalysisTimer = null;
  if (!currentData?.candles?.length) return;
  const analysis = calculateRealtimeAnalysis(currentData.candles, currentInterval);
  currentData.analysis = analysis;
  ma5Series.setData(formatAnalysisSeries(analysis.sma5 || [], currentInterval));
  ma20Series.setData(formatAnalysisSeries(analysis.sma20 || [], currentInterval));
  ma60Series.setData(formatAnalysisSeries(analysis.sma60 || [], currentInterval));
  ma120Series.setData(formatAnalysisSeries(analysis.sma120 || [], currentInterval));
  rsiSeries.setData(formatAnalysisSeries(analysis.rsi || [], currentInterval));
  updateMarkers(analysis.cross_signals || [], currentInterval);
  updateSidebar(analysis, currentData.candles);
}

function scheduleRealtimeIndicatorRefresh() {
  if (realtimeAnalysisTimer) return;
  realtimeAnalysisTimer = setTimeout(refreshRealtimeIndicators, REALTIME_ANALYSIS_THROTTLE_MS);
}

function applyRealtimeTrade(trade, options = {}) {
  if (!currentData?.candles?.length) return;
  const price = Number(trade.price);
  if (!Number.isFinite(price) || price <= 0) return;

  const timestamp = trade.timestamp || new Date().toISOString();
  const incomingMs = Date.parse(timestamp);
  const currentQuoteMs = Date.parse(currentData.quote?.timestamp || "");
  if (Number.isFinite(incomingMs) && Number.isFinite(currentQuoteMs) && incomingMs < currentQuoteMs) return;

  currentData.quote = {
    price,
    timestamp,
    currency: trade.currency || currentData.quote?.currency || ""
  };

  const bucket = tradeBucketTime(timestamp, currentInterval);
  const candles = currentData.candles;
  let latest = candles[candles.length - 1];
  const latestKey = currentInterval === "1d" ? String(latest.time) : Number(latest.time);
  const bucketKey = currentInterval === "1d" ? String(bucket) : Number(bucket);
  let shifted = false;
  let createdNewCandle = false;

  if (bucketKey === latestKey) {
    latest = {
      ...latest,
      high: Math.max(Number(latest.high), price),
      low: Math.min(Number(latest.low), price),
      close: price
    };
    candles[candles.length - 1] = latest;
  } else if (bucketKey > latestKey) {
    latest = { time: bucket, open: price, high: price, low: price, close: price };
    candles.push(latest);
    createdNewCandle = true;
    if (candles.length > 150) {
      candles.shift();
      shifted = true;
    }

    currentData.volume = currentData.volume || [];
    currentData.volume.push({
      time: bucket,
      value: 0,
      color: "rgba(240, 68, 82, 0.45)"
    });
    if (currentData.volume.length > 150) currentData.volume.shift();
  }

  if (shifted) candleSeries.setData(candles);
  else candleSeries.update(latest);

  const volumes = currentData.volume || [];
  if (volumes.length) {
    let vol = volumes[volumes.length - 1];
    if (String(vol.time) === String(latest.time)) {
      vol = {
        ...vol,
        color: price >= Number(latest.open)
          ? "rgba(240, 68, 82, 0.45)"
          : "rgba(49, 130, 246, 0.45)"
      };
      volumes[volumes.length - 1] = vol;
      if (shifted) volumeSeries.setData(volumes);
      else volumeSeries.update(vol);
    }
  }

  updateHeaderInfo(currentSymbol, candles, currentStockInfo.name, currentStockInfo.market, currentData.quote);
  scheduleRealtimeIndicatorRefresh();

  // 체결 스트림은 누적 거래량을 복원할 수 없으므로 새 봉이 시작되면 REST 캔들로 빠르게 정합성 보정한다.
  if (createdNewCandle && !options.skipBoundarySync) {
    scheduleSnapshotSync(1500, requestGeneration);
  }
}

function updateMarkers(crossSignals, interval) {
  if (!toggleCrossMarkers.checked) {
    candleSeries.setMarkers([]);
    return;
  }

  const seen = new Set();
  const markers = [];
  for (const sig of crossSignals) {
    let t = sig.timestamp;
    if (interval === "1d") {
      t = t.substring(0, 10);
    } else {
      t = Math.floor(new Date(t).getTime() / 1000);
    }

    if (!seen.has(t)) {
      seen.add(t);
      if (sig.type === "GOLDEN_CROSS") {
        markers.push({
          time: t,
          position: "belowBar",
          color: "#f04452",
          shape: "arrowUp",
          text: "▲ 골든크로스"
        });
      } else {
        markers.push({
          time: t,
          position: "aboveBar",
          color: "#3182f6",
          shape: "arrowDown",
          text: "▼ 데드크로스"
        });
      }
    }
  }

  candleSeries.setMarkers(markers);
}

function updateHeaderInfo(symbol, candles, stockName, market, quote = null) {
  const isKRX = market === "KOSPI" || market === "KOSDAQ" || market === "KRX" || market === "NXT";
  const currency = quote?.currency || (isKRX ? "KRW" : "USD");

  displayStockName.textContent = stockName || symbol;
  displayStockSymbol.textContent = symbol;
  displayMarketTag.textContent = market || (isKRX ? "KRX" : "US");
  displayCurrency.textContent = currency;

  const latest = candles[candles.length - 1];
  const prev = candles.length > 1 ? candles[candles.length - 2] : latest;

  // 실시간 현재가가 있으면 그것을 사용하고, 없을 때만 마지막 캔들 종가를 사용한다.
  const quotePrice = Number(quote?.price);
  const currentPrice = Number.isFinite(quotePrice) && quotePrice > 0 ? quotePrice : latest.close;
  const prevClose = prev.close;
  const change = currentPrice - prevClose;
  const changePct = prevClose ? ((change / prevClose) * 100).toFixed(2) : "0.00";
  const sign = change >= 0 ? "+" : "";

  displayStockPrice.textContent = isKRX
    ? Math.round(currentPrice).toLocaleString()
    : currentPrice.toFixed(2);

  displayStockChange.textContent = `${sign}${isKRX ? Math.round(change).toLocaleString() : change.toFixed(2)} (${sign}${changePct}%)`;
  displayStockChange.className = `stock-change ${change >= 0 ? "up" : "down"}`;
}

function updateSidebar(analysis, candles) {
  const sum = analysis.latest_summary || {};
  const isKRX = currentStockInfo.market === "KOSPI" || currentStockInfo.market === "KOSDAQ" || currentStockInfo.market === "KRX" || currentStockInfo.market === "NXT";
  const currency = isKRX ? "KRW" : "USD";

  // Arrangement
  diagArrangement.textContent = sum.arrangement || "-";
  if (sum.arrangement && sum.arrangement.includes("정배열")) {
    trendBadge.textContent = "상승 추세";
    trendBadge.className = "badge up";
  } else if (sum.arrangement && sum.arrangement.includes("역배열")) {
    trendBadge.textContent = "하락 추세";
    trendBadge.className = "badge down";
  } else {
    trendBadge.textContent = "수렴/박스권";
    trendBadge.className = "badge";
  }

  // Last Cross
  if (sum.last_signal) {
    const isGold = sum.last_signal.type === "GOLDEN_CROSS";
    diagLastCross.textContent = `${isGold ? "골든크로스" : "데드크로스"} (${sum.last_signal.timestamp.substring(0, 10)})`;
    diagLastCross.style.color = isGold ? "#f87171" : "#60a5fa";
  } else {
    diagLastCross.textContent = "최근 교차 없음";
    diagLastCross.style.color = "var(--text-muted)";
  }

  // RSI
  const rsiVal = sum.rsi !== undefined && sum.rsi !== null ? sum.rsi : "-";
  diagRSI.textContent = rsiVal;
  if (typeof rsiVal === "number") {
    if (rsiVal >= 70) diagRSI.textContent += " (과매수 구간)";
    else if (rsiVal <= 30) diagRSI.textContent += " (과매도 구간)";
    else diagRSI.textContent += " (중립)";
  }

  // Disparity (이격도: 종가 / 20일선 * 100)
  if (sum.close && sum.sma20) {
    const disp = ((sum.close / sum.sma20) * 100).toFixed(1);
    diagDisparity.textContent = `${disp}%`;
  } else {
    diagDisparity.textContent = "-";
  }

  // Current MA Values
  const formatVal = (v) => v ? (currency === "KRW" ? Math.round(v).toLocaleString() : v.toFixed(2)) : "-";
  valMA5.textContent = formatVal(sum.sma5);
  valMA20.textContent = formatVal(sum.sma20);
  valMA60.textContent = formatVal(sum.sma60);
  valMA120.textContent = formatVal(sum.sma120);

  // Cross Alert Box
  if (sum.last_signal) {
    const isGold = sum.last_signal.type === "GOLDEN_CROSS";
    signalAlertBox.className = `signal-alert-box ${isGold ? "golden" : "dead"}`;
    alertTitle.textContent = isGold ? "🔥 단기 매수 우위 (골든크로스 발생)" : "⚠️ 단기 매도 주의 (데드크로스 발생)";
    alertDesc.textContent = sum.last_signal.description;
  } else {
    signalAlertBox.className = "signal-alert-box";
    alertTitle.textContent = "추세 유지 중";
    alertDesc.textContent = "현재 5일선과 20일선 간의 급격한 교차 신호 없이 추세를 유지하고 있습니다.";
  }

  // Signal History Table
  const signals = analysis.cross_signals || [];
  crossCount.textContent = `${signals.length}건`;

  if (signals.length === 0) {
    signalList.innerHTML = `<div class="empty-state">조회 기간 내 발생한 크로스 신호가 없습니다.</div>`;
  } else {
    // Show newest first
    const reversed = [...signals].reverse();
    signalList.innerHTML = reversed.map(s => {
      const isGold = s.type === "GOLDEN_CROSS";
      const dateStr = s.timestamp.substring(0, 10);
      const prc = currency === "KRW" ? Math.round(s.price).toLocaleString() + "원" : "$" + s.price.toFixed(2);
      return `
        <div class="signal-row">
          <div class="signal-top">
            <span class="signal-badge ${isGold ? "golden" : "dead"}">${isGold ? "골든크로스" : "데드크로스"}</span>
            <span class="signal-date">${dateStr}</span>
          </div>
          <div class="signal-desc">${s.description}</div>
          <div class="signal-price">당시 주가: ${prc}</div>
        </div>
      `;
    }).join("");
  }
}

function showLoading(show) {
  if (show) {
    loadingOverlay.classList.remove("hidden");
  } else {
    loadingOverlay.classList.add("hidden");
  }
}


// ================= Event Handlers =================

// Check server-side Toss API status. Visitors never enter or receive API credentials.
async function checkServerStatus() {
  try {
    const res = await fetch("/api/status", { cache: "no-store" });
    const data = await parseJsonResponse(res, "서버 상태 확인");
    if (data.configured) {
      isLiveApi = true;
      apiStatusBadge.className = "status-badge live";
      apiStatusBadge.querySelector(".status-text").textContent = "실시간 시세 연결 준비";
    } else if (data.mode === "demo") {
      isLiveApi = false;
      apiStatusBadge.className = "status-badge";
      apiStatusBadge.querySelector(".status-text").textContent = "시뮬레이터 모드";
    } else {
      isLiveApi = false;
      apiStatusBadge.className = "status-badge";
      apiStatusBadge.querySelector(".status-text").textContent = "서버 API 설정 필요";
    }
  } catch (e) {
    isLiveApi = false;
    apiStatusBadge.className = "status-badge";
    apiStatusBadge.querySelector(".status-text").textContent = "서버 연결 오류";
    console.warn("서버 상태 확인 실패:", e);
  }
}


async function parseJsonResponse(res, label = "서버 요청") {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch (_) {
    const compact = text.replace(/\s+/g, " ").trim().slice(0, 140);
    throw new Error(`${label}: 서버가 JSON 대신 HTML/텍스트를 반환했습니다 (HTTP ${res.status}). ${compact || "응답 내용 없음"}`);
  }
}

// ================= Search Autocomplete =================

let searchDebounceTimer = null;
let selectedDropdownIndex = -1;

function hideDropdown() {
  searchDropdown.classList.remove("active");
  searchDropdown.innerHTML = "";
  selectedDropdownIndex = -1;
}

function renderDropdown(results) {
  if (!results || results.length === 0) {
    hideDropdown();
    return;
  }
  searchDropdown.innerHTML = results.map((r, i) => `
    <div class="search-item" data-symbol="${r.symbol}" data-name="${r.name}" data-idx="${i}">
      <div class="search-item-left">
        <span class="search-item-name">${r.name}</span>
        <span class="search-item-symbol">${r.symbol}</span>
      </div>
      <span class="search-item-market">${r.market}</span>
    </div>
  `).join("");
  searchDropdown.classList.add("active");
  selectedDropdownIndex = -1;

  searchDropdown.querySelectorAll(".search-item").forEach(item => {
    item.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const sym = item.dataset.symbol;
      const nm = item.dataset.name;
      symbolInput.value = nm;
      hideDropdown();
      presetChips.querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c.dataset.symbol === sym));
      loadStockData(sym, currentInterval);
    });
  });
}

symbolInput.addEventListener("input", () => {
  clearTimeout(searchDebounceTimer);
  const q = symbolInput.value.trim();
  if (!q) { hideDropdown(); return; }
  searchDebounceTimer = setTimeout(async () => {
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const results = await parseJsonResponse(res, "API 설정 확인");
      renderDropdown(results);
    } catch (e) { hideDropdown(); }
  }, 200);
});

symbolInput.addEventListener("keydown", (e) => {
  const items = searchDropdown.querySelectorAll(".search-item");
  if (e.key === "ArrowDown") {
    e.preventDefault();
    selectedDropdownIndex = Math.min(selectedDropdownIndex + 1, items.length - 1);
    items.forEach((el, i) => el.classList.toggle("selected", i === selectedDropdownIndex));
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    selectedDropdownIndex = Math.max(selectedDropdownIndex - 1, -1);
    items.forEach((el, i) => el.classList.toggle("selected", i === selectedDropdownIndex));
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (selectedDropdownIndex >= 0 && items[selectedDropdownIndex]) {
      items[selectedDropdownIndex].dispatchEvent(new MouseEvent("mousedown"));
    } else {
      const q = symbolInput.value.trim();
      if (q) {
        hideDropdown();
        presetChips.querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
        loadStockData(q, currentInterval);
      }
    }
  } else if (e.key === "Escape") {
    hideDropdown();
  }
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".stock-search-wrap")) hideDropdown();
});

// Preset Chip Clicks
presetChips.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;

  presetChips.querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
  chip.classList.add("active");

  const symbol = chip.dataset.symbol;
  symbolInput.value = "";
  hideDropdown();
  loadStockData(symbol, currentInterval);
});

// Search Button
searchBtn.addEventListener("click", () => {
  const q = symbolInput.value.trim();
  if (q) {
    hideDropdown();
    presetChips.querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
    loadStockData(q, currentInterval);
  }
});

// Interval Buttons
document.querySelectorAll(".int-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".int-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentInterval = btn.dataset.interval;
    loadStockData(currentSymbol, currentInterval);
  });
});

// Indicator Toggles
toggleMA5.addEventListener("change", (e) => {
  ma5Series.applyOptions({ visible: e.target.checked });
});
toggleMA20.addEventListener("change", (e) => {
  ma20Series.applyOptions({ visible: e.target.checked });
});
toggleMA60.addEventListener("change", (e) => {
  ma60Series.applyOptions({ visible: e.target.checked });
});
toggleMA120.addEventListener("change", (e) => {
  ma120Series.applyOptions({ visible: e.target.checked });
});
toggleCrossMarkers.addEventListener("change", () => {
  if (currentData) {
    updateMarkers(currentData.analysis.cross_signals || [], currentInterval);
  }
});
toggleRSI.addEventListener("change", (e) => {
  const rsiEl = document.getElementById("rsiChart");
  rsiEl.style.display = e.target.checked ? "block" : "none";
});

// ================= Boot Application =================

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearSnapshotTimer();
    abortSnapshotRequest();
    disconnectMarketSocket();
  } else if (isLiveApi && currentData) {
    // 숨겨진 동안 놓친 체결/거래량을 REST로 동기화한 뒤 WebSocket을 다시 연결한다.
    loadStockData(currentSymbol, currentInterval, {
      background: true,
      generation: requestGeneration
    });
  }
});

window.addEventListener("beforeunload", () => {
  clearSnapshotTimer();
  abortSnapshotRequest();
  disconnectMarketSocket();
});

window.addEventListener("DOMContentLoaded", async () => {
  initCharts();
  await checkServerStatus();
  await loadStockData(currentSymbol, currentInterval);
});
