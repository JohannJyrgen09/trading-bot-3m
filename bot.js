/**
 * Claude + TradingView MCP — Automated Trading Bot
 *
 * Cloud mode: runs on Railway on a schedule. Pulls candle data direct from
 * Binance (free, no auth), calculates all indicators, runs safety check,
 * executes via Binance Spot API if everything lines up.
 *
 * Local mode: run manually — node bot.js
 * Cloud mode: deploy to Railway, set env vars, Railway triggers on cron schedule
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";
import { execSync } from "child_process";

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const required = ["BINANCE_API_KEY", "BINANCE_SECRET_KEY"];
  const missing = required.filter((k) => !process.env[k]);

  // In cloud (Railway), env vars are injected directly — no .env file needed
  const hasEnvVars = required.every((k) => process.env[k]);
  if (!hasEnvVars && !existsSync(".env")) {
    console.log(
      "\n⚠️  No .env file found — opening it for you to fill in...\n",
    );
    writeFileSync(
      ".env",
      [
        "# Binance credentials",
        "BINANCE_API_KEY=",
        "BINANCE_SECRET_KEY=",
        "",
        "# Trading config",
        "PORTFOLIO_VALUE_USD=1000",
        "MAX_TRADE_SIZE_USD=100",
        "MAX_TRADES_PER_DAY=3",
        "PAPER_TRADING=true",
        "SYMBOL=BTCUSDT",
        "TIMEFRAME=4H",
      ].join("\n") + "\n",
    );
    try {
      execSync("open .env");
    } catch {}
    console.log(
      "Fill in your Binance credentials in .env then re-run: node bot.js\n",
    );
    process.exit(0);
  }

  if (missing.length > 0) {
    console.log(`\n⚠️  Missing credentials in .env: ${missing.join(", ")}`);
    console.log("Opening .env for you now...\n");
    try {
      execSync("open .env");
    } catch {}
    console.log("Add the missing values then re-run: node bot.js\n");
    process.exit(0);
  }

  // Always print the CSV location so users know where to find their trade log
  const csvPath = new URL("trades.csv", import.meta.url).pathname;
  console.log(`\n📄 Trade log: ${csvPath}`);
  console.log(
    `   Open in Google Sheets or Excel any time — or tell Claude to move it:\n` +
      `   "Move my trades.csv to ~/Desktop" or "Move it to my Documents folder"\n`,
  );
}

// ─── Config ────────────────────────────────────────────────────────────────

const CONFIG = {
  symbol: process.env.SYMBOL || "BTCUSDT",
  timeframe: process.env.TIMEFRAME || "4H",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "100"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
  paperTrading: process.env.PAPER_TRADING !== "false",
  tradeMode: process.env.TRADE_MODE || "spot",
  binance: {
    apiKey: process.env.BINANCE_API_KEY,
    secretKey: process.env.BINANCE_SECRET_KEY,
    baseUrl: "https://api.binance.com",
  },
};

// /data is a Railway persistent volume — survives container restarts
// Falls back to local directory when running on your machine
const DATA_DIR = existsSync("/data") ? "/data" : ".";
const LOG_FILE       = `${DATA_DIR}/safety-check-log.json`;
const POSITIONS_FILE = `${DATA_DIR}/positions.json`;
const POSITIONS_CSV  = `${DATA_DIR}/positions.csv`;
const PERF_FILE      = `${DATA_DIR}/performance.json`;

const POSITIONS_CSV_HEADERS =
  "Trade ID,Symbol,Direction,Entry Time,Entry Price,TP,SL,Size USD," +
  "Close Time,Exit Price,P&L USD,P&L %,Result,Exit Reason,Mode";

// ─── Positions & Performance ─────────────────────────────────────────────────

function loadPositions() {
  if (!existsSync(POSITIONS_FILE)) return [];
  return JSON.parse(readFileSync(POSITIONS_FILE, "utf8"));
}

function savePositions(positions) {
  writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2));

  // Rebuild the CSV from scratch every time
  const rows = positions.map((p) =>
    [
      p.id,
      p.symbol,
      p.direction,
      p.entryTime,
      p.entryPrice,
      p.tp,
      p.sl,
      p.sizeUSD,
      p.closeTime  ?? "",
      p.exitPrice  ?? "",
      p.pnlUSD     != null ? p.pnlUSD.toFixed(4)  : "",
      p.pnlPct     != null ? p.pnlPct.toFixed(4)   : "",
      p.result     ?? "OPEN",
      p.exitReason ?? "",
      p.mode,
    ].join(",")
  );
  writeFileSync(POSITIONS_CSV, POSITIONS_CSV_HEADERS + "\n" + rows.join("\n") + "\n");
}

function addOpenPosition(trade) {
  const positions = loadPositions();
  const id = `T${String(positions.length + 1).padStart(4, "0")}`;
  positions.push({
    id,
    symbol:     trade.symbol,
    direction:  trade.direction,
    entryTime:  trade.entryTime,
    entryPrice: trade.entryPrice,
    tp:         trade.tp,
    sl:         trade.sl,
    sizeUSD:    trade.sizeUSD,
    closeTime:  null,
    exitPrice:  null,
    pnlUSD:     null,
    pnlPct:     null,
    result:     "OPEN",
    exitReason: null,
    mode:       trade.mode,
    orderId:    trade.orderId,
  });
  savePositions(positions);
  return id;
}

function closePosition(exitPrice, exitReason, mode) {
  const positions = loadPositions();
  const idx = positions.findIndex((p) => p.result === "OPEN");
  if (idx === -1) return null;

  const pos = positions[idx];
  const pnlUSD = pos.direction === "BUY"
    ? (exitPrice - pos.entryPrice) / pos.entryPrice * pos.sizeUSD
    : (pos.entryPrice - exitPrice) / pos.entryPrice * pos.sizeUSD;
  const pnlPct = pos.direction === "BUY"
    ? (exitPrice - pos.entryPrice) / pos.entryPrice * 100
    : (pos.entryPrice - exitPrice) / pos.entryPrice * 100;

  positions[idx] = {
    ...pos,
    closeTime:  new Date().toISOString(),
    exitPrice,
    pnlUSD,
    pnlPct,
    result:     pnlUSD >= 0 ? "WIN" : "LOSS",
    exitReason,
  };

  savePositions(positions);
  rebuildPerformance(positions);
  return positions[idx];
}

function rebuildPerformance(positions) {
  const closed = positions.filter((p) => p.result !== "OPEN");
  if (closed.length === 0) {
    writeFileSync(PERF_FILE, JSON.stringify({
      verdict: "INSUFFICIENT DATA — no closed trades yet",
      closedTrades: 0,
      lastUpdated: new Date().toISOString(),
    }, null, 2));
    return;
  }

  const wins   = closed.filter((p) => p.result === "WIN");
  const losses = closed.filter((p) => p.result === "LOSS");
  const totalPnl    = closed.reduce((s, p) => s + p.pnlUSD, 0);
  const grossProfit = wins.reduce((s, p) => s + p.pnlUSD, 0);
  const grossLoss   = Math.abs(losses.reduce((s, p) => s + p.pnlUSD, 0));
  const profitFactor = grossLoss === 0 ? Infinity : grossProfit / grossLoss;
  const avgWin   = wins.length   ? grossProfit / wins.length   : 0;
  const avgLoss  = losses.length ? grossLoss   / losses.length : 0;
  const winRate  = (wins.length / closed.length) * 100;

  // Max drawdown — largest peak-to-trough in cumulative P&L
  let peak = 0, cumPnl = 0, maxDD = 0;
  for (const p of closed) {
    cumPnl += p.pnlUSD;
    if (cumPnl > peak) peak = cumPnl;
    const dd = peak - cumPnl;
    if (dd > maxDD) maxDD = dd;
  }

  // Consecutive wins/losses
  let maxConsecWins = 0, maxConsecLoss = 0, curW = 0, curL = 0;
  for (const p of closed) {
    if (p.result === "WIN") { curW++; curL = 0; maxConsecWins = Math.max(maxConsecWins, curW); }
    else                    { curL++; curW = 0; maxConsecLoss = Math.max(maxConsecLoss, curL); }
  }

  const best  = closed.reduce((a, b) => b.pnlUSD > a.pnlUSD ? b : a);
  const worst = closed.reduce((a, b) => b.pnlUSD < a.pnlUSD ? b : a);

  const perf = {
    strategy:          "VWAP + RSI(3) + EMA(8) Scalping",
    symbol:            CONFIG.symbol,
    timeframe:         CONFIG.timeframe,
    mode:              CONFIG.paperTrading ? "PAPER" : "LIVE",
    closedTrades:      closed.length,
    openTrades:        positions.filter((p) => p.result === "OPEN").length,
    wins:              wins.length,
    losses:            losses.length,
    winRate:           parseFloat(winRate.toFixed(2)),
    totalPnlUSD:       parseFloat(totalPnl.toFixed(4)),
    grossProfit:       parseFloat(grossProfit.toFixed(4)),
    grossLoss:         parseFloat(grossLoss.toFixed(4)),
    profitFactor:      profitFactor === Infinity ? "∞" : parseFloat(profitFactor.toFixed(3)),
    avgWinUSD:         parseFloat(avgWin.toFixed(4)),
    avgLossUSD:        parseFloat(avgLoss.toFixed(4)),
    maxDrawdownUSD:    parseFloat(maxDD.toFixed(4)),
    bestTradeUSD:      parseFloat(best.pnlUSD.toFixed(4)),
    worstTradeUSD:     parseFloat(worst.pnlUSD.toFixed(4)),
    maxConsecWins,
    maxConsecLoss,
    verdict: totalPnl > 0 && profitFactor > 1
      ? "✅ PROFITABLE"
      : totalPnl < 0
        ? "❌ UNPROFITABLE"
        : "⚠️  BREAK EVEN",
    lastUpdated: new Date().toISOString(),
  };

  writeFileSync(PERF_FILE, JSON.stringify(perf, null, 2));
  console.log(`📊 Performance updated → ${PERF_FILE} | ${perf.verdict} | WR: ${perf.winRate}% | P&L: $${perf.totalPnlUSD}`);
  return perf;
}

// ─── Logging ────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(
    (t) => t.timestamp.startsWith(today) && t.orderPlaced,
  ).length;
}

// ─── Market Data (Binance public API — free, no auth) ───────────────────────

async function fetchCandles(symbol, interval, limit = 100) {
  // Map our timeframe format to Binance interval format
  const intervalMap = {
    "1m": "1m",
    "3m": "3m",
    "5m": "5m",
    "15m": "15m",
    "30m": "30m",
    "1H": "1h",
    "4H": "4h",
    "1D": "1d",
    "1W": "1w",
  };
  const binanceInterval = intervalMap[interval] || "1m";

  // data-api.binance.vision is Binance's global CDN mirror — same data,
  // no geo-blocking (accessible from US-based servers like Railway)
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${binanceInterval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance API error: ${res.status}`);
  const data = await res.json();

  return data.map((k) => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ─── Indicator Calculations ──────────────────────────────────────────────────

function calcEMA(closes, period) {
  const multiplier = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * multiplier + ema * (1 - multiplier);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0,
    losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// VWAP — session-based, resets at midnight UTC
function calcVWAP(candles) {
  const midnightUTC = new Date();
  midnightUTC.setUTCHours(0, 0, 0, 0);
  const sessionCandles = candles.filter((c) => c.time >= midnightUTC.getTime());
  if (sessionCandles.length === 0) return null;
  const cumTPV = sessionCandles.reduce(
    (sum, c) => sum + ((c.high + c.low + c.close) / 3) * c.volume,
    0,
  );
  const cumVol = sessionCandles.reduce((sum, c) => sum + c.volume, 0);
  return cumVol === 0 ? null : cumTPV / cumVol;
}

// ─── Safety Check ───────────────────────────────────────────────────────────

function runSafetyCheck(price, ema8, vwap, rsi3, rules) {
  const results = [];

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    const icon = pass ? "✅" : "🚫";
    console.log(`  ${icon} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  console.log("\n── Safety Check ─────────────────────────────────────────\n");

  // Determine bias using VWAP only — price above VWAP = bullish, below = bearish
  const bullishBias = price > vwap;
  const bearishBias = price < vwap;

  if (bullishBias) {
    console.log("  Bias: BULLISH — checking long entry conditions\n");

    // 1. Price above VWAP
    check(
      "Price above VWAP (buyers in control)",
      `> ${vwap.toFixed(2)}`,
      price.toFixed(2),
      price > vwap,
    );

    // 2. Price above EMA(8)
    check(
      "Price above EMA(8) (uptrend confirmed)",
      `> ${ema8.toFixed(2)}`,
      price.toFixed(2),
      price > ema8,
    );

    // 3. RSI(3) pullback
    check(
      "RSI(3) below 30 (snap-back setup in uptrend)",
      "< 30",
      rsi3.toFixed(2),
      rsi3 < 30,
    );

    // 4. Not overextended from VWAP
    const distFromVWAP = Math.abs((price - vwap) / vwap) * 100;
    check(
      "Price within 1.5% of VWAP (not overextended)",
      "< 1.5%",
      `${distFromVWAP.toFixed(2)}%`,
      distFromVWAP < 1.5,
    );
  } else if (bearishBias) {
    console.log("  Bias: BEARISH — checking short entry conditions\n");

    check(
      "Price below VWAP (sellers in control)",
      `< ${vwap.toFixed(2)}`,
      price.toFixed(2),
      price < vwap,
    );

    check(
      "Price below EMA(8) (downtrend confirmed)",
      `< ${ema8.toFixed(2)}`,
      price.toFixed(2),
      price < ema8,
    );

    check(
      "RSI(3) above 70 (reversal setup in downtrend)",
      "> 70",
      rsi3.toFixed(2),
      rsi3 > 70,
    );

    const distFromVWAP = Math.abs((price - vwap) / vwap) * 100;
    check(
      "Price within 1.5% of VWAP (not overextended)",
      "< 1.5%",
      `${distFromVWAP.toFixed(2)}%`,
      distFromVWAP < 1.5,
    );
  } else {
    console.log("  Bias: NEUTRAL — no clear direction. No trade.\n");
    results.push({
      label: "Market bias",
      required: "Bullish or bearish",
      actual: "Neutral",
      pass: false,
    });
  }

  const allPass = results.every((r) => r.pass);
  return { results, allPass };
}

// ─── Trade Limits ────────────────────────────────────────────────────────────

function checkTradeLimits(log) {
  const todayCount = countTodaysTrades(log);

  console.log("\n── Trade Limits ─────────────────────────────────────────\n");

  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(
      `🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`,
    );
    return false;
  }

  console.log(
    `✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay} — within limit`,
  );

  const tradeSize = Math.min(
    CONFIG.portfolioValue * 0.01,
    CONFIG.maxTradeSizeUSD,
  );

  if (tradeSize > CONFIG.maxTradeSizeUSD) {
    console.log(
      `🚫 Trade size $${tradeSize.toFixed(2)} exceeds max $${CONFIG.maxTradeSizeUSD}`,
    );
    return false;
  }

  console.log(
    `✅ Trade size: $${tradeSize.toFixed(2)} — within max $${CONFIG.maxTradeSizeUSD}`,
  );

  return true;
}

// ─── Binance Execution ───────────────────────────────────────────────────────

function signBinance(params) {
  const queryString = new URLSearchParams(params).toString();
  return crypto
    .createHmac("sha256", CONFIG.binance.secretKey)
    .update(queryString)
    .digest("hex");
}

async function binanceRequest(path, params) {
  const timestamp = Date.now();
  const allParams = { ...params, timestamp };
  const signature = signBinance(allParams);
  const queryString = new URLSearchParams({ ...allParams, signature }).toString();
  const res = await fetch(`${CONFIG.binance.baseUrl}${path}?${queryString}`, {
    method: "POST",
    headers: { "X-MBX-APIKEY": CONFIG.binance.apiKey },
  });
  const data = await res.json();
  if (data.code) throw new Error(`Binance error: ${data.msg} (code: ${data.code})`);
  return data;
}

async function placeOrder(symbol, side, sizeUSD, price) {
  // MARGIN cross — borrows automatically, works for both longs and shorts
  // BUY  (long entry / short close) : quoteOrderQty = spend X USDT
  // SELL (short entry / long close) : quantity      = sell X coins
  const qty = (sizeUSD / price).toFixed(6);
  const data = await binanceRequest("/sapi/v1/margin/order", {
    symbol,
    isIsolated: "FALSE",          // cross margin
    side:       side.toUpperCase(),
    type:       "MARKET",
    sideEffectType: "MARGIN_BUY", // auto-borrow if needed
    ...(side.toUpperCase() === "BUY"
      ? { quoteOrderQty: sizeUSD.toFixed(2) }
      : { quantity: qty }),
  });
  return { orderId: data.orderId, price: parseFloat(data.fills?.[0]?.price || price) };
}

async function closeOrder(symbol, side, sizeUSD, price) {
  // Closing side is opposite of entry — AUTO_REPAY pays back the loan
  const closeSide = side.toUpperCase() === "BUY" ? "SELL" : "BUY";
  const qty = (sizeUSD / price).toFixed(6);
  const data = await binanceRequest("/sapi/v1/margin/order", {
    symbol,
    isIsolated:     "FALSE",
    side:           closeSide,
    type:           "MARKET",
    sideEffectType: "AUTO_REPAY", // repay borrowed funds on close
    ...(closeSide === "BUY"
      ? { quoteOrderQty: sizeUSD.toFixed(2) }
      : { quantity: qty }),
  });
  return { orderId: data.orderId, price: parseFloat(data.fills?.[0]?.price || price) };
}

// ─── TP / SL Calculation (van de Poppe 2:1 RR, 0.3% SL from rules.json) ──────

function calcTPSL(entryPrice, direction) {
  const SL_PCT = 0.003; // 0.3% hard stop — from rules.json
  const TP_PCT = 0.006; // 0.6% take profit — 2:1 RR (van de Poppe minimum)
  if (direction === "BUY") {
    return {
      tp: parseFloat((entryPrice * (1 + TP_PCT)).toFixed(4)),
      sl: parseFloat((entryPrice * (1 - SL_PCT)).toFixed(4)),
    };
  } else {
    return {
      tp: parseFloat((entryPrice * (1 - TP_PCT)).toFixed(4)),
      sl: parseFloat((entryPrice * (1 + SL_PCT)).toFixed(4)),
    };
  }
}

// ─── Telegram Notifications ──────────────────────────────────────────────────

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log("Telegram: no token/chatId configured, skipping");
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "HTML" }),
    });
    const data = await res.json();
    if (data.ok) {
      console.log("📱 Telegram notification sent");
    } else {
      console.log("Telegram error:", JSON.stringify(data));
    }
  } catch (e) {
    console.log("Telegram send failed (non-fatal):", e.message);
  }
}

async function sendFile(filePath, caption) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  if (!existsSync(filePath)) {
    await sendTelegram(`📭 ${filePath} not found yet.`);
    return;
  }
  try {
    const form = new FormData();
    form.append("chat_id", chatId);
    const ext = filePath.endsWith(".csv") ? "text/csv" : "application/json";
    const filename = filePath.split("/").pop();
    form.append("document", new Blob([readFileSync(filePath)], { type: ext }), filename);
    form.append("caption", caption);
    const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
      method: "POST",
      body: form,
    });
    const data = await res.json();
    if (data.ok) console.log(`📱 Sent ${filename} via Telegram`);
    else console.log("Telegram sendDocument error:", JSON.stringify(data));
  } catch (e) {
    console.log("sendFile failed:", e.message);
  }
}

async function sendTradesFile() {
  const date = new Date().toISOString().slice(0, 10);

  // 1. All decisions log (trades.csv)
  await sendFile(CSV_FILE, `📋 All decisions — trades.csv (${date})`);

  // 2. Executed trades only (positions.csv)
  await sendFile(POSITIONS_CSV, `📌 Executed trades — positions.csv (${date})`);

  // 3. Performance summary as a formatted message
  if (existsSync(PERF_FILE)) {
    const p = JSON.parse(readFileSync(PERF_FILE, "utf8"));
    if (p.closedTrades > 0) {
      await sendTelegram(
        `📊 <b>Strategy Performance — ${p.symbol} ${p.timeframe}</b>\n` +
        `─────────────────────────────\n` +
        `Mode: ${p.mode}\n` +
        `Closed trades: ${p.closedTrades}  |  Open: ${p.openTrades}\n` +
        `Wins: ${p.wins}  |  Losses: ${p.losses}  |  WR: ${p.winRate}%\n` +
        `Total P&amp;L: ${p.totalPnlUSD >= 0 ? "+" : ""}$${p.totalPnlUSD.toFixed(3)}\n` +
        `Avg win: +$${p.avgWinUSD.toFixed(3)}  |  Avg loss: -$${p.avgLossUSD.toFixed(3)}\n` +
        `Profit factor: ${p.profitFactor}\n` +
        `Max drawdown: -$${p.maxDrawdownUSD.toFixed(3)}\n` +
        `Best trade: +$${p.bestTradeUSD.toFixed(3)}  |  Worst: $${p.worstTradeUSD.toFixed(3)}\n` +
        `Max consec. wins: ${p.maxConsecWins}  |  losses: ${p.maxConsecLoss}\n` +
        `─────────────────────────────\n` +
        `Verdict: ${p.verdict}`
      );
    } else {
      await sendTelegram("📊 No closed trades yet — strategy verdict pending.");
    }
    // Also send the raw performance.json
    await sendFile(PERF_FILE, `📊 performance.json (${date})`);
  }
}

// ─── Tax CSV Logging ─────────────────────────────────────────────────────────

const CSV_FILE = `${DATA_DIR}/trades.csv`;

// Always ensure trades.csv exists with headers — open it in Excel/Sheets any time
function initCsv() {
  if (!existsSync(CSV_FILE)) {
    const funnyNote = `,,,,,,,,,,,"NOTE","Hey, if you're at this stage of the video, you must be enjoying it... perhaps you could hit subscribe now? :)"`;
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n" + funnyNote + "\n");
    console.log(
      `📄 Created ${CSV_FILE} — open in Google Sheets or Excel to track trades.`,
    );
  }
}
const CSV_HEADERS = [
  "Date",
  "Time (UTC)",
  "Exchange",
  "Symbol",
  "Side",
  "Quantity",
  "Price",
  "Total USD",
  "Fee (est.)",
  "Net Amount",
  "Order ID",
  "Mode",
  "Notes",
].join(",");

function writeTradeCsv(logEntry) {
  const now = new Date(logEntry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  let side = "";
  let quantity = "";
  let totalUSD = "";
  let fee = "";
  let netAmount = "";
  let orderId = "";
  let mode = "";
  let notes = "";

  if (!logEntry.allPass) {
    const failed = logEntry.conditions
      .filter((c) => !c.pass)
      .map((c) => c.label)
      .join("; ");
    mode = "BLOCKED";
    orderId = "BLOCKED";
    notes = `Failed: ${failed}`;
  } else if (logEntry.paperTrading) {
    side = "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "PAPER";
    notes = "All conditions met";
  } else {
    side = "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "LIVE";
    notes = logEntry.error ? `Error: ${logEntry.error}` : "All conditions met";
  }

  const row = [
    date,
    time,
    "Binance",
    logEntry.symbol,
    side,
    quantity,
    logEntry.price.toFixed(2),
    totalUSD,
    fee,
    netAmount,
    orderId,
    mode,
    `"${notes}"`,
  ].join(",");

  if (!existsSync(CSV_FILE)) {
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  }

  appendFileSync(CSV_FILE, row + "\n");
  console.log(`Tax record saved → ${CSV_FILE}`);
}

// Tax summary command: node bot.js --tax-summary
function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) {
    console.log("No trades.csv found — no trades have been recorded yet.");
    return;
  }

  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows = lines.slice(1).map((l) => l.split(","));

  const live = rows.filter((r) => r[11] === "LIVE");
  const paper = rows.filter((r) => r[11] === "PAPER");
  const blocked = rows.filter((r) => r[11] === "BLOCKED");

  const totalVolume = live.reduce((sum, r) => sum + parseFloat(r[7] || 0), 0);
  const totalFees = live.reduce((sum, r) => sum + parseFloat(r[8] || 0), 0);

  console.log("\n── Tax Summary ──────────────────────────────────────────\n");
  console.log(`  Total decisions logged : ${rows.length}`);
  console.log(`  Live trades executed   : ${live.length}`);
  console.log(`  Paper trades           : ${paper.length}`);
  console.log(`  Blocked by safety check: ${blocked.length}`);
  console.log(`  Total volume (USD)     : $${totalVolume.toFixed(2)}`);
  console.log(`  Total fees paid (est.) : $${totalFees.toFixed(4)}`);
  console.log(`\n  Full record: ${CSV_FILE}`);
  console.log("─────────────────────────────────────────────────────────\n");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  checkOnboarding();
  initCsv();
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude Trading Bot");
  console.log(`  ${new Date().toISOString()}`);
  console.log(
    `  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`,
  );
  console.log("═══════════════════════════════════════════════════════════");

  // Load strategy
  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  console.log(`\nStrategy: ${rules.strategy.name}`);
  console.log(`Symbol: ${CONFIG.symbol} | Timeframe: ${CONFIG.timeframe}`);

  // Load log and check daily limits
  const log = loadLog();
  const withinLimits = checkTradeLimits(log);
  if (!withinLimits) {
    console.log("\nBot stopping — trade limits reached for today.");
    return;
  }

  // Fetch candle data — need enough for EMA(8) + full session for VWAP
  console.log("\n── Fetching market data from Binance ───────────────────\n");
  const candles = await fetchCandles(CONFIG.symbol, CONFIG.timeframe, 500);
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];
  // Use last candle's high/low to catch TP/SL wicks missed between runs
  const lastHigh = candles[candles.length - 1].high;
  const lastLow  = candles[candles.length - 1].low;
  console.log(`  Current price: $${price.toFixed(2)} | High: $${lastHigh.toFixed(2)} | Low: $${lastLow.toFixed(2)}`);

  // Calculate indicators
  const ema8 = calcEMA(closes, 8);
  const vwap = calcVWAP(candles);
  const rsi3 = calcRSI(closes, 3);

  console.log(`  EMA(8):  $${ema8.toFixed(2)}`);
  console.log(`  VWAP:    $${vwap ? vwap.toFixed(2) : "N/A"}`);
  console.log(`  RSI(3):  ${rsi3 ? rsi3.toFixed(2) : "N/A"}`);

  if (!vwap || !rsi3) {
    console.log("\n⚠️  Not enough data to calculate indicators. Exiting.");
    return;
  }

  // ── Check open position ────────────────────────────────────────────────────
  if (log.openPosition) {
    const pos = log.openPosition;
    // Check close price AND last candle high/low — catches TP/SL hit as a wick
    const hitTP = pos.direction === "BUY" ? (price >= pos.tp || lastHigh >= pos.tp) : (price <= pos.tp || lastLow <= pos.tp);
    const hitSL = pos.direction === "BUY" ? (price <= pos.sl || lastLow  <= pos.sl) : (price >= pos.sl || lastHigh >= pos.sl);

    if (hitTP || hitSL) {
      const exitReason = hitTP ? "TP HIT" : "SL HIT";
      let actualExitPrice = price;

      // In live mode, place real close order on Binance margin
      if (!CONFIG.paperTrading) {
        try {
          const closeResult = await closeOrder(pos.symbol, pos.direction, pos.tradeSize, price);
          actualExitPrice = closeResult.price || price;
          console.log(`✅ CLOSE ORDER PLACED — ${closeResult.orderId} @ $${actualExitPrice}`);
        } catch (err) {
          console.log(`❌ CLOSE ORDER FAILED — ${err.message}`);
          await sendTelegram(`⚠️ <b>Close order failed!</b>\nManually close your ${pos.direction} ${pos.symbol} position.\nError: ${err.message}`);
        }
      }

      const closed = closePosition(actualExitPrice, exitReason, CONFIG.paperTrading ? "PAPER" : "LIVE");
      const pnlUSD = closed.pnlUSD;
      const pnlPct = closed.pnlPct;
      const pnlIcon = pnlUSD >= 0 ? "🟢" : "🔴";
      const exitIcon = hitTP ? "✅" : "❌";

      console.log(`\n── Position Closed — ${exitReason} ${exitIcon} ──────────────`);
      console.log(`  Direction: ${pos.direction} | ID: ${closed.id}`);
      console.log(`  Entry: $${pos.entryPrice.toFixed(2)} → Exit: $${price.toFixed(2)}`);
      console.log(`  P&L: ${pnlIcon} $${pnlUSD.toFixed(4)} (${pnlPct.toFixed(2)}%)`);

      // Load updated performance to include in Telegram
      const perf = existsSync(PERF_FILE)
        ? JSON.parse(readFileSync(PERF_FILE, "utf8"))
        : null;
      const perfLine = perf
        ? `\n📊 Strategy: ${perf.wins}W/${perf.losses}L | WR: ${perf.winRate}% | Total P&amp;L: ${perf.totalPnlUSD >= 0 ? "+" : ""}$${perf.totalPnlUSD.toFixed(3)} | ${perf.verdict}`
        : "";

      await sendTelegram(
        `${pnlIcon} <b>CLOSED ${pos.direction} ${pos.symbol} 3m</b> [${exitReason} ${exitIcon}]\n` +
        `Entry: $${pos.entryPrice.toFixed(2)} → Exit: $${price.toFixed(2)}\n` +
        `P&amp;L: ${pnlUSD >= 0 ? "+" : ""}$${pnlUSD.toFixed(4)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)` +
        `${perfLine}`
      );

      delete log.openPosition;
      saveLog(log);
    } else {
      console.log(`\n📌 Open position: ${pos.direction} @ $${pos.entryPrice.toFixed(2)} | TP $${pos.tp.toFixed(2)} | SL $${pos.sl.toFixed(2)} | Current $${price.toFixed(2)}`);
    }
  }

  // Run safety check — skip entry if we already have an open position
  if (log.openPosition) {
    console.log("  Skipping new entry — position already open.");
    return;
  }

  const { results, allPass } = runSafetyCheck(price, ema8, vwap, rsi3, rules);

  // Calculate position size
  const tradeSize = Math.min(
    CONFIG.portfolioValue * 0.01,
    CONFIG.maxTradeSizeUSD,
  );

  // Decision
  console.log("\n── Decision ─────────────────────────────────────────────\n");

  const direction = price > vwap ? "BUY" : "SELL";
  const { tp, sl } = calcTPSL(price, direction);

  const logEntry = {
    timestamp: new Date().toISOString(),
    symbol: CONFIG.symbol,
    timeframe: CONFIG.timeframe,
    price,
    direction,
    tp,
    sl,
    indicators: { ema8, vwap, rsi3 },
    conditions: results,
    allPass,
    tradeSize,
    orderPlaced: false,
    orderId: null,
    paperTrading: CONFIG.paperTrading,
    limits: {
      maxTradeSizeUSD: CONFIG.maxTradeSizeUSD,
      maxTradesPerDay: CONFIG.maxTradesPerDay,
      tradesToday: countTodaysTrades(log),
    },
  };

  if (!allPass) {
    const failed = results.filter((r) => !r.pass).map((r) => r.label);
    console.log(`🚫 TRADE BLOCKED`);
    console.log(`   Failed conditions:`);
    failed.forEach((f) => console.log(`   - ${f}`));
  } else {
    console.log(`✅ ALL CONDITIONS MET`);

    if (CONFIG.paperTrading) {
      console.log(
        `\n📋 PAPER TRADE — ${direction} ${CONFIG.symbol} ~$${tradeSize.toFixed(2)} at market`,
      );
      console.log(`   TP: $${tp.toFixed(2)} | SL: $${sl.toFixed(2)}`);
      console.log(`   (Set PAPER_TRADING=false in .env to place real orders)`);
      logEntry.orderPlaced = true;
      logEntry.orderId = `PAPER-${Date.now()}`;
    } else {
      console.log(
        `\n💰 PLACING LIVE ORDER — $${tradeSize.toFixed(2)} ${direction} ${CONFIG.symbol}`,
      );
      console.log(`   TP: $${tp.toFixed(2)} | SL: $${sl.toFixed(2)}`);
      try {
        const order = await placeOrder(
          CONFIG.symbol,
          direction,
          tradeSize,
          price,
        );
        logEntry.orderPlaced = true;
        logEntry.orderId = order.orderId;
        console.log(`✅ ORDER PLACED — ${order.orderId}`);
      } catch (err) {
        console.log(`❌ ORDER FAILED — ${err.message}`);
        logEntry.error = err.message;
      }
    }
  }

  // Register executed trade in positions log and store in openPosition tracker
  if (logEntry.orderPlaced) {
    const posId = addOpenPosition({
      symbol:     logEntry.symbol,
      direction:  logEntry.direction,
      entryPrice: logEntry.price,
      tp:         logEntry.tp,
      sl:         logEntry.sl,
      sizeUSD:    logEntry.tradeSize,
      entryTime:  logEntry.timestamp,
      orderId:    logEntry.orderId,
      mode:       CONFIG.paperTrading ? "PAPER" : "LIVE",
    });
    logEntry.positionId = posId;
    console.log(`📌 Position registered → ${posId} | positions.json`);

    log.openPosition = {
      symbol:     logEntry.symbol,
      direction:  logEntry.direction,
      entryPrice: logEntry.price,
      tp:         logEntry.tp,
      sl:         logEntry.sl,
      tradeSize:  logEntry.tradeSize,
      entryTime:  logEntry.timestamp,
      orderId:    logEntry.orderId,
      positionId: posId,
    };
  }

  // Save decision log
  log.trades.push(logEntry);
  saveLog(log);
  console.log(`\nDecision log saved → ${LOG_FILE}`);

  // Write tax CSV row for every run (executed, paper, or blocked)
  writeTradeCsv(logEntry);

  // Telegram notification
  const mode = CONFIG.paperTrading ? "📋 PAPER" : "💰 LIVE";
  const dir = logEntry.direction; // "BUY" or "SELL"
  const dirIcon = dir === "BUY" ? "🟢" : "🔴";
  const { ema8: tgEma8, vwap: tgVwap, rsi3: tgRsi3 } = logEntry.indicators;
  const failed = logEntry.conditions.filter(r => !r.pass).map(r => `  • ${r.label}`).join("\n");
  const tgMsg = logEntry.allPass
    ? `${dirIcon} <b>${CONFIG.paperTrading ? "PAPER " : ""}${dir} ${logEntry.symbol}</b> [3m | ${mode}]\n` +
      `Entry: $${logEntry.price.toFixed(2)} | Size: $${logEntry.tradeSize.toFixed(2)}\n` +
      `🎯 TP: $${logEntry.tp.toFixed(2)}  🛑 SL: $${logEntry.sl.toFixed(2)}\n` +
      `RSI(3): ${tgRsi3.toFixed(1)} | EMA8: $${tgEma8.toFixed(2)} | VWAP: $${tgVwap.toFixed(2)}\n` +
      `${logEntry.timestamp}`
    : `⏸ <b>BLOCKED ${dir} — ${logEntry.symbol} 3m</b>\n` +
      `Price: $${logEntry.price.toFixed(2)} | VWAP: $${tgVwap.toFixed(2)}\n` +
      (failed ? `Failed:\n${failed}\n` : "") +
      `${logEntry.timestamp}`;
  await sendTelegram(tgMsg);

  console.log("═══════════════════════════════════════════════════════════\n");
}

if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else if (process.env.SEND_TRADES_NOW === "true") {
  // Set SEND_TRADES_NOW=true in Railway env vars to push the CSV to Telegram
  sendTradesFile().then(() => {
    console.log("Trades file sent. Remove SEND_TRADES_NOW var to resume normal operation.");
    process.exit(0);
  });
} else {
  // Run in an infinite loop — no cron needed, always-on service
  const INTERVAL_MS = 3 * 60 * 1000; // 3 minutes
  (async () => {
    while (true) {
      try {
        await run();
      } catch (err) {
        console.error("Bot error:", err.message);
        await sendTelegram(`⚠️ <b>Bot error</b>\n${err.message}`);
      }
      console.log(`⏳ Next run in 3 minutes...\n`);
      await new Promise((r) => setTimeout(r, INTERVAL_MS));
    }
  })();
}
