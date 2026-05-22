import dotenv from "dotenv";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BiyingClient } from "./biying-client";
import { clamp, round } from "../src/lib/math";
import type { Exchange, IntradayPulseItem, IntradayPulseReport, RealQuote, StockListItem } from "../src/lib/types";
import { inferExchange, isMainBoardNonSt, plainCode, toInstrumentCode } from "../src/lib/universe";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const statePath = resolve(root, process.env.INTRADAY_STATE_PATH ?? ".cache/intraday-state.json");
const outputPath = resolve(root, process.env.INTRADAY_REPORT_PATH ?? "public/reports/intraday.json");

dotenv.config({ path: resolve(root, ".env.local"), override: false });
dotenv.config({ path: resolve(root, ".env"), override: false });

type PulseStock = {
  dm: string;
  mc: string;
  jys: Exchange | string;
};

type PulseSnapshot = {
  code: string;
  name: string;
  exchange: Exchange;
  time: string;
  tradeDate: string;
  price: number;
  open: number;
  high: number;
  low: number;
  pct: number;
  amount: number;
  volume: number;
  turnover: number;
  volumeRatio: number;
};

type PulseBar = {
  time: string;
  price: number;
  amountDelta: number;
  volumeDelta: number;
  pctDelta: number;
};

type PulseState = {
  tradeDate?: string;
  stockCacheDate?: string;
  stocks?: PulseStock[];
  previous: Record<string, PulseSnapshot>;
  bars: Record<string, PulseBar[]>;
};

function intEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function chinaDateTime(date = new Date()) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  })
    .format(date)
    .replace(/\//g, "-");
}

function chinaTradeDate(date = new Date()) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  })
    .format(date)
    .replace(/\//g, "-");
}

function chinaTimeParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return {
    weekday: part("weekday"),
    hour: Number(part("hour")),
    minute: Number(part("minute"))
  };
}

function isTradingWindow(date = new Date()) {
  const { weekday, hour, minute } = chinaTimeParts(date);
  if (weekday.includes("六") || weekday.includes("日") || weekday.toLowerCase().includes("sat") || weekday.toLowerCase().includes("sun")) {
    return false;
  }

  const current = hour * 60 + minute;
  return (current >= 9 * 60 + 30 && current <= 11 * 60 + 30) || (current >= 13 * 60 && current <= 15 * 60);
}

function normalizeTime(value?: string) {
  return String(value ?? chinaDateTime()).replace("T", " ");
}

function minuteKey(value: string) {
  return normalizeTime(value).slice(0, 16);
}

function quoteDate(quote?: RealQuote) {
  return String(quote?.t ?? "").slice(0, 10) || chinaTradeDate();
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeStatusReport(status: IntradayPulseReport["meta"]["status"], notes: string[]) {
  const report: IntradayPulseReport = {
    meta: {
      generatedAt: chinaDateTime(),
      tradeDate: chinaTradeDate(),
      source: "Biying all-realtime minute pulse",
      mode: "live",
      status,
      intervalSeconds: intEnv("INTRADAY_INTERVAL_SECONDS", 60),
      notes
    },
    summary: {
      universe: 0,
      quoted: 0,
      compared: 0,
      hot: 0,
      watch: 0,
      risk: 0
    },
    hot: [],
    watch: [],
    risk: []
  };
  await writeJson(outputPath, report);
}

function safeDivide(value: number, base: number, fallback = 0) {
  return Number.isFinite(value) && Number.isFinite(base) && base > 0 ? value / base : fallback;
}

function average(values: number[]) {
  const clean = values.filter((value) => Number.isFinite(value) && value > 0);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : 0;
}

function elapsedMarketMinutes(time: string) {
  const date = new Date(`${minuteKey(time).replace(" ", "T")}:00+08:00`);
  const minutes = date.getHours() * 60 + date.getMinutes();
  const morningStart = 9 * 60 + 30;
  const morningEnd = 11 * 60 + 30;
  const afternoonStart = 13 * 60;
  const afternoonEnd = 15 * 60;
  if (minutes <= morningStart) return 1;
  if (minutes <= morningEnd) return minutes - morningStart + 1;
  if (minutes < afternoonStart) return 121;
  if (minutes <= afternoonEnd) return 121 + minutes - afternoonStart + 1;
  return 240;
}

function snapshot(stock: StockListItem, quote: RealQuote): PulseSnapshot | undefined {
  const price = Number(quote.p ?? 0);
  const amount = Number(quote.cje ?? 0);
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(amount) || amount <= 0) return undefined;

  const code = plainCode(stock.dm);
  const exchange = inferExchange(code, stock.jys);
  return {
    code,
    name: stock.mc,
    exchange,
    time: normalizeTime(quote.t),
    tradeDate: quoteDate(quote),
    price,
    open: Number(quote.o ?? price),
    high: Number(quote.h ?? price),
    low: Number(quote.l ?? price),
    pct: Number(quote.pc ?? 0),
    amount,
    volume: Number(quote.v ?? 0),
    turnover: Number(quote.hs ?? quote.tr ?? 0),
    volumeRatio: Number(quote.lb ?? 0)
  };
}

function closeLocation(current: PulseSnapshot) {
  return clamp((current.price - current.low) / Math.max(0.01, current.high - current.low), 0, 1);
}

function buildItem(args: {
  current: PulseSnapshot;
  previous: PulseSnapshot;
  bars: PulseBar[];
  amountDelta: number;
  volumeDelta: number;
  minutePct: number;
  topN: number;
}): IntradayPulseItem | undefined {
  if (args.amountDelta <= 0 || args.current.tradeDate !== args.previous.tradeDate) return undefined;

  const previousBars = args.bars.slice(-20);
  const dayAverage = safeDivide(args.current.amount, elapsedMarketMinutes(args.current.time), 0);
  const amountBase = average(previousBars.map((bar) => bar.amountDelta)) || dayAverage;
  const amountBurstRatio = safeDivide(args.amountDelta, amountBase, 0);
  const location = closeLocation(args.current);
  const bullishMinute = args.minutePct >= 0;
  const bullishDailyBody = args.current.price >= args.current.open;
  const strongMove = args.minutePct >= 0.6 || args.current.pct >= 2;
  const heavyBearish = amountBurstRatio >= 5 && (!bullishMinute || !bullishDailyBody || location < 0.35);

  const burstScore = amountBurstRatio >= 12 ? 34 : amountBurstRatio >= 8 ? 29 : amountBurstRatio >= 5 ? 23 : amountBurstRatio >= 3 ? 14 : 0;
  const amountScore = Math.min(18, Math.max(0, Math.log10(Math.max(args.amountDelta, 1_000_000) / 1_000_000) * 9));
  const moveScore = args.minutePct >= 1.5 ? 22 : args.minutePct >= 0.8 ? 16 : args.minutePct >= 0.25 ? 9 : args.minutePct >= 0 ? 3 : -12;
  const dayScore = args.current.pct >= 2 && args.current.pct <= 7.5 ? 14 : args.current.pct > 9 ? -14 : args.current.pct < 0 ? -10 : 4;
  const locationScore = location >= 0.72 ? 12 : location >= 0.55 ? 7 : location < 0.32 ? -10 : 0;
  const turnoverScore = args.current.turnover >= 0.8 && args.current.turnover <= 8 ? 8 : args.current.turnover > 12 ? -8 : 2;
  const bearishPenalty = heavyBearish ? 30 : amountBurstRatio >= 5 && !strongMove ? 14 : 0;
  const score = clamp(28 + burstScore + amountScore + moveScore + dayScore + locationScore + turnoverScore - bearishPenalty);

  const reasons: string[] = [];
  const risks: string[] = [];
  if (amountBurstRatio >= 5) reasons.push(`分钟成交额 ${round(amountBurstRatio, 1)}x`);
  if (args.minutePct > 0) reasons.push(`分钟价格 ${round(args.minutePct, 2)}%`);
  if (args.current.pct > 0) reasons.push(`日内涨幅 ${round(args.current.pct, 2)}%`);
  if (location >= 0.65) reasons.push("价格贴近日内强位");
  if (args.current.volumeRatio >= 2) reasons.push(`量比 ${round(args.current.volumeRatio, 2)}`);
  if (!bullishMinute) risks.push("放量分钟为阴线");
  if (!bullishDailyBody) risks.push("日内实体偏弱");
  if (location < 0.35) risks.push("放量但收在日内低位");
  if (args.current.pct > 8.5) risks.push("涨幅过高，追高性价比下降");
  if (args.current.turnover > 12) risks.push("换手过热");

  const signal: IntradayPulseItem["signal"] = heavyBearish ? "risk" : score >= 72 && amountBurstRatio >= 4 ? "hot" : "watch";
  if (signal === "watch" && score < 58) return undefined;

  return {
    rank: 0,
    code: args.current.code,
    instrument: toInstrumentCode(args.current.code, args.current.exchange),
    name: args.current.name,
    time: minuteKey(args.current.time),
    price: round(args.current.price, 2),
    pct: round(args.current.pct, 2),
    minutePct: round(args.minutePct, 2),
    minuteAmount: round(args.amountDelta, 0),
    minuteVolume: round(args.volumeDelta, 0),
    amountBurstRatio: round(amountBurstRatio, 2),
    dayAmount: round(args.current.amount, 0),
    turnover: round(args.current.turnover, 2),
    volumeRatio: round(args.current.volumeRatio, 2),
    closeLocation: round(location * 100, 1),
    score: round(score, 1),
    signal,
    reasons: reasons.slice(0, 4),
    risks: risks.slice(0, 4)
  };
}

async function loadUniverse(client: BiyingClient, state: PulseState, tradeDate: string) {
  if (state.stockCacheDate === tradeDate && state.stocks?.length) return state.stocks;
  const listed = await client.stockList();
  const stocks = listed.filter(isMainBoardNonSt).map((stock) => ({
    dm: plainCode(stock.dm),
    mc: stock.mc,
    jys: inferExchange(stock.dm, stock.jys)
  }));
  state.stockCacheDate = tradeDate;
  state.stocks = stocks;
  return stocks;
}

async function run() {
  const license = process.env.BIYING_LICENSE;
  if (!license) {
    await writeStatusReport("missing_license", [
      "服务器尚未配置 BIYING_LICENSE，分钟级盘中扫描已安装但不会调用接口。",
      "写入 /etc/a-share-money-radar.env 后，下一次 timer 会自动生成真实数据。"
    ]);
    console.log(`[intraday] ${chinaDateTime()} BIYING_LICENSE is not configured, skipped`);
    return;
  }

  if (process.env.INTRADAY_FORCE !== "1" && process.env.INTRADAY_MARKET_HOURS_ONLY !== "false" && !isTradingWindow()) {
    await writeStatusReport("closed", ["当前不在 A 股交易时间，分钟级扫描跳过。"]);
    console.log(`[intraday] ${chinaDateTime()} outside A-share trading window, skipped`);
    return;
  }

  const client = new BiyingClient(license);
  const state = await readJson<PulseState>(statePath, { previous: {}, bars: {} });
  const quotes = await client.allRealtime();
  const latestQuote = [...quotes].filter((quote) => quote.t).sort((a, b) => String(b.t).localeCompare(String(a.t)))[0];
  const tradeDate = quoteDate(latestQuote);
  const stocks = await loadUniverse(client, state, tradeDate);
  const stockByCode = new Map(stocks.map((stock) => [plainCode(stock.dm), stock]));
  const quoteByCode = new Map(quotes.map((quote) => [plainCode(quote.dm), quote]));

  if (state.tradeDate && state.tradeDate !== tradeDate) {
    state.previous = {};
    state.bars = {};
  }
  state.tradeDate = tradeDate;

  const compared: IntradayPulseItem[] = [];
  const nextPrevious: Record<string, PulseSnapshot> = {};

  for (const stock of stocks) {
    const code = plainCode(stock.dm);
    const quote = quoteByCode.get(code);
    if (!quote) continue;

    const current = snapshot(stock, quote);
    if (!current) continue;

    nextPrevious[code] = current;
    const previous = state.previous[code];
    const bars = state.bars[code] ?? [];
    if (!previous) continue;

    const amountDelta = current.amount >= previous.amount ? current.amount - previous.amount : 0;
    const volumeDelta = current.volume >= previous.volume ? current.volume - previous.volume : 0;
    const minutePct = safeDivide(current.price - previous.price, previous.price, 0) * 100;
    const item = buildItem({ current, previous, bars, amountDelta, volumeDelta, minutePct, topN: intEnv("INTRADAY_TOP_N", 30) });

    const key = minuteKey(current.time);
    const nextBar = { time: key, price: current.price, amountDelta, volumeDelta, pctDelta: minutePct };
    const last = bars[bars.length - 1];
    state.bars[code] = (last?.time === key ? [...bars.slice(0, -1), nextBar] : [...bars, nextBar]).slice(-80);

    if (item) compared.push(item);
  }

  state.previous = nextPrevious;

  const topN = intEnv("INTRADAY_TOP_N", 30);
  const sorted = compared.sort((a, b) => b.score - a.score || b.minuteAmount - a.minuteAmount);
  const hot = sorted.filter((item) => item.signal === "hot").slice(0, topN).map((item, index) => ({ ...item, rank: index + 1 }));
  const watch = sorted.filter((item) => item.signal === "watch").slice(0, topN).map((item, index) => ({ ...item, rank: index + 1 }));
  const risk = sorted.filter((item) => item.signal === "risk").slice(0, topN).map((item, index) => ({ ...item, rank: index + 1 }));

  const report: IntradayPulseReport = {
    meta: {
      generatedAt: chinaDateTime(),
      tradeDate,
      source: "Biying all-realtime minute pulse",
      mode: "live",
      status: "ok",
      intervalSeconds: intEnv("INTRADAY_INTERVAL_SECONDS", 60),
      notes: [
        "分钟级脉冲只使用全市场实时快照，适合高频盯盘；日线精筛仍由原扫描任务负责。",
        "放量柱必须价格同步走强；放量阴线、日内低位放量会进入风险列表或被扣分。"
      ]
    },
    summary: {
      universe: stocks.length,
      quoted: nextPrevious ? Object.keys(nextPrevious).length : 0,
      compared: compared.length,
      hot: hot.length,
      watch: watch.length,
      risk: risk.length
    },
    hot,
    watch,
    risk
  };

  await writeJson(statePath, state);
  await writeJson(outputPath, report);
  console.log(`[intraday] ${report.meta.generatedAt} hot=${hot.length} watch=${watch.length} risk=${risk.length}`);
}

await run();
