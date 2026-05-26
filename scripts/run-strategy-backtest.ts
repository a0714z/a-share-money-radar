import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scoreCandidate } from "../src/lib/scoring";
import { average, pctChange, round } from "../src/lib/math";
import type { KLine, MoneyFlow, RealQuote, SetupState, StockActionState, StockListItem, StockPick } from "../src/lib/types";
import { inferExchange, isMainBoardNonSt, plainCode, toInstrumentCode } from "../src/lib/universe";
import { klineCacheRoot, readKLineCache, readStockListCache } from "./kline-cache";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

dotenv.config({ path: resolve(root, ".env.local"), override: false, quiet: true });
dotenv.config({ path: resolve(root, ".env"), override: false, quiet: true });

type Horizon = 5 | 10;
type StrategyPreset = "baseline" | "swing";
type EvidenceMode = "any" | "intraday" | "daily" | "both";
type SignalLayer = "main" | "watch";
type AestheticBucket = "near-main" | "intraday-support" | "low-repair";
type AestheticPriority = "high" | "medium" | "low";

const ACTION_STATES = ["ready", "pullback", "track", "risk", "invalid"] as const satisfies readonly StockActionState[];
const SETUP_STATES = ["二次突破", "承接确认", "缩量回踩", "爆量启动", "承接转弱", "放量派发风险", "跌破失效", "常规观察"] as const satisfies readonly SetupState[];
const SIGNAL_LAYERS = ["main", "watch"] as const satisfies readonly SignalLayer[];
const AESTHETIC_BUCKETS = ["near-main", "intraday-support", "low-repair"] as const satisfies readonly AestheticBucket[];

const aestheticBucketLabels: Record<AestheticBucket, string> = {
  "near-main": "接近主策略",
  "intraday-support": "30m承接审美",
  "low-repair": "低位修复观察"
};

type SwingFilterConfig = {
  minFlowRatio: number;
  maxFlowRatio: number;
  minValuePosition: number;
  maxValuePosition: number;
  minScore: number;
  maxScore: number;
  minPullbackFromHigh: number;
  maxPullbackFromHigh: number;
  states: StockActionState[];
  setups: SetupState[];
  allowHardRisks: boolean;
  evidence: EvidenceMode;
  minIntradayScore: number;
  minIntradaySupportScore: number;
  maxIntradayDaysSince: number;
  maxIntradayPullbackAmountRatio: number;
  requireIntradayHeldMidpoint: boolean;
  minThirtyMinutePullbackScore: number;
  maxThirtyMinuteShrinkRatio: number;
};

type BacktestConfig = {
  from?: string;
  to?: string;
  selectDate?: string;
  horizons: Horizon[];
  top: number;
  historyDays: number;
  flowDays: number;
  targetPct: number;
  strongTargetPct: number;
  stretchTargetPct: number;
  cooldownDays: number;
  maxDates: number;
  outputDir: string;
  preset: StrategyPreset;
  aestheticTop: number;
  strongWatchTop: number;
  useIntraday30m: boolean;
  intraday30mBars: number;
  refineCandidates: number;
  swing: SwingFilterConfig;
};

type ReplayResult = {
  horizon: Horizon;
  status: "complete" | "pending";
  entryPrice: number;
  availableDays?: number;
  remainingDays?: number;
  latestDate?: string;
  dueDate?: string;
  closeReturnPct?: number;
  maxRunupPct?: number;
  maxRunupDate?: string;
  maxRunupDay?: number;
  maxDrawdownPct?: number;
  maxDrawdownDate?: string;
  maxDrawdownDay?: number;
  targetHit?: boolean;
  strongTargetHit?: boolean;
  stretchTargetHit?: boolean;
  firstTargetDate?: string;
  firstStrongTargetDate?: string;
  firstStretchTargetDate?: string;
};

type BacktestPick = {
  tradeDate: string;
  rank: number;
  instrument: string;
  name: string;
  score: number;
  strategyScore: number;
  signal: StockPick["signal"];
  signalLayer: SignalLayer;
  actionState: StockActionState;
  actionLabel?: string;
  price: number;
  pctChange: number;
  setupState: StockPick["setupState"];
  flowRatio5d: number;
  valuePosition: number;
  pullbackFromHigh: number;
  amountRatio20?: number;
  actionReason?: string;
  intradayScore?: number;
  intradaySupportScore?: number;
  intradayDaysSince?: number;
  intradayPullbackAmountRatio?: number;
  intradayHeldMidpoint?: boolean;
  surgeScore?: number;
  surgeDaysSince?: number;
  surgePullbackAmountRatio?: number;
  thirtyMinutePullbackScore?: number;
  thirtyMinuteShrinkRatio?: number;
  thirtyMinuteDrawdownFromHigh?: number;
  thirtyMinuteDistanceFromLow?: number;
  thirtyMinuteHeldRecentLow?: boolean;
  thirtyMinuteCloseAboveMa20?: boolean;
  thirtyMinuteCloseAboveMa60?: boolean;
  reasons: string[];
  risks: string[];
  cooldownDuplicate?: boolean;
  replay: Record<string, ReplayResult>;
};

type AestheticWatchPick = BacktestPick & {
  bucket: AestheticBucket;
  bucketLabel: string;
  bucketScore: number;
  priority: AestheticPriority;
  watchReason: string;
  matchReasons: string[];
};

type StrongWatchPick = AestheticWatchPick & {
  strongWatchScore: number;
  strongWatchTier: "A" | "B";
  strongWatchReason: string;
};

type Stats = {
  samples: number;
  completed: number;
  targetHits: number;
  strongTargetHits: number;
  stretchTargetHits: number;
  winRate?: number;
  positiveCloseRate?: number;
  strongTargetRate?: number;
  stretchTargetRate?: number;
  avgCloseReturnPct?: number;
  avgMaxRunupPct?: number;
  avgMaxDrawdownPct?: number;
  avgPeakDay?: number;
};

type BacktestReport = {
  meta: {
    generatedAt: string;
    mode: "cache-only";
    from?: string;
    to?: string;
    selectDate?: string;
    horizons: Horizon[];
    top: number;
    historyDays: number;
    flowDays: number;
    targetPct: number;
    strongTargetPct: number;
    stretchTargetPct: number;
    cooldownDays: number;
    preset: StrategyPreset;
    aestheticTop: number;
    strongWatchTop: number;
    useIntraday30m: boolean;
    intraday30mBars: number;
    refineCandidates: number;
    swing?: SwingFilterConfig;
    rejected: Record<string, number>;
    evaluatedDates: number;
    universe: number;
    notes: string[];
  };
  cache: {
    stocksWithDaily: number;
    stocksWithMoneyFlow: number;
    stocksWithIntraday30m: number;
    intraday30mRefinedCandidates: number;
    skippedNoDaily: number;
  };
  summary: Record<string, Stats>;
  cooldownSummary: Record<string, Stats>;
  byActionState: Record<string, Record<string, Stats>>;
  bySetupState: Record<string, Record<string, Stats>>;
  bySignalLayer: Record<SignalLayer, Record<string, Stats>>;
  cooldownBySignalLayer: Record<SignalLayer, Record<string, Stats>>;
  aestheticWatch?: AestheticWatchReport;
  strongWatch?: StrongWatchReport;
  dailyRecords: DailyRecord[];
  picks: BacktestPick[];
};

type DailyRecordPick = {
  rank: number;
  instrument: string;
  name: string;
  layer: SignalLayer;
  state: StockActionState;
  setup: SetupState;
  price: number;
  score: number;
  strategyScore: number;
  flowRatio5d: number;
  valuePosition: number;
  pullbackFromHigh: number;
  thirtyMinutePullbackScore?: number;
  thirtyMinuteShrinkRatio?: number;
  cooldownDuplicate: boolean;
  replay: Record<string, ReplayResult>;
};

type DailyRecord = {
  tradeDate: string;
  signals: number;
  mainSignals: number;
  watchSignals: number;
  cooldownEligibleSignals: number;
  cooldownSkippedSignals: number;
  picks: DailyRecordPick[];
};

type AestheticDailyRecordPick = DailyRecordPick & {
  bucket: AestheticBucket;
  bucketLabel: string;
  bucketScore: number;
  priority: AestheticPriority;
  watchReason: string;
  matchReasons: string[];
};

type StrongWatchDailyRecordPick = AestheticDailyRecordPick & {
  strongWatchScore: number;
  strongWatchTier: "A" | "B";
  strongWatchReason: string;
};

type AestheticDailyRecord = {
  tradeDate: string;
  signals: number;
  cooldownEligibleSignals: number;
  cooldownSkippedSignals: number;
  byBucket: Record<AestheticBucket, number>;
  picks: AestheticDailyRecordPick[];
};

type AestheticWatchReport = {
  summary: Record<string, Stats>;
  cooldownSummary: Record<string, Stats>;
  byBucket: Record<AestheticBucket, Record<string, Stats>>;
  cooldownByBucket: Record<AestheticBucket, Record<string, Stats>>;
  dailyRecords: AestheticDailyRecord[];
  picks: AestheticWatchPick[];
};

type StrongWatchReport = {
  summary: Record<string, Stats>;
  cooldownSummary: Record<string, Stats>;
  byBucket: Record<AestheticBucket, Record<string, Stats>>;
  cooldownByBucket: Record<AestheticBucket, Record<string, Stats>>;
  dailyRecords: StrongWatchDailyRecord[];
  picks: StrongWatchPick[];
};

type StrongWatchDailyRecord = {
  tradeDate: string;
  signals: number;
  cooldownEligibleSignals: number;
  cooldownSkippedSignals: number;
  byBucket: Record<AestheticBucket, number>;
  picks: StrongWatchDailyRecordPick[];
};

type MoneyFlowEnvelope = {
  fetchedAt: string;
  data: MoneyFlow[];
};

type StockIndex = {
  items?: Array<{ code: string; instrument: string; name: string }>;
};

type StockData = {
  stock: StockListItem;
  instrument: string;
  daily: KLine[];
  flows: MoneyFlow[];
};

type ScoredCandidate = {
  item: StockData;
  pick: StockPick;
  tradeIndex: number;
  history: KLine[];
  flows: MoneyFlow[];
  future: KLine[];
  thirtyMinuteSignal?: ThirtyMinuteSignal;
};

type SelectedCandidate = ScoredCandidate & {
  strategyScore: number;
};

type ThirtyMinuteSignal = {
  score: number;
  shrinkRatio: number;
  drawdownFromHigh: number;
  distanceFromLow: number;
  heldRecentLow: boolean;
  closeAboveMa20: boolean;
  closeAboveMa60: boolean;
};

function argValue(name: string) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function numberArg(name: string, fallback: number) {
  const value = Number(argValue(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeNumberArg(name: string, fallback: number) {
  const value = Number(argValue(name));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function boolArg(name: string, fallback: boolean) {
  const raw = argValue(name);
  if (raw === undefined) return hasFlag(name) ? true : fallback;
  if (/^(1|true|yes|y)$/i.test(raw)) return true;
  if (/^(0|false|no|n)$/i.test(raw)) return false;
  return fallback;
}

function csvArg(name: string) {
  return (argValue(name) ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function presetArg(): StrategyPreset {
  const raw = argValue("preset");
  return raw === "swing" ? "swing" : "baseline";
}

function evidenceArg(fallback: EvidenceMode): EvidenceMode {
  const raw = argValue("evidence");
  return raw === "intraday" || raw === "daily" || raw === "both" || raw === "any" ? raw : fallback;
}

function actionStatesArg(fallback: StockActionState[]) {
  const raw = csvArg("states");
  if (raw.includes("all")) return [...ACTION_STATES];
  const allowed = new Set<StockActionState>(ACTION_STATES);
  const parsed = raw.filter((item): item is StockActionState => allowed.has(item as StockActionState));
  return parsed.length ? [...new Set(parsed)] : fallback;
}

function setupStatesArg(fallback: SetupState[]) {
  const raw = csvArg("setups");
  if (raw.includes("all")) return [...SETUP_STATES];
  const allowed = new Set<SetupState>(SETUP_STATES);
  const parsed = raw.filter((item): item is SetupState => allowed.has(item as SetupState));
  return parsed.length ? [...new Set(parsed)] : fallback;
}

function swingFilterConfig(): SwingFilterConfig {
  return {
    minFlowRatio: numberArg("min-flow", 1.5),
    maxFlowRatio: numberArg("max-flow", 12),
    minValuePosition: numberArg("min-value", 62),
    maxValuePosition: numberArg("max-value", 75),
    minScore: numberArg("min-score", 64),
    maxScore: numberArg("max-score", 100),
    minPullbackFromHigh: numberArg("min-pullback", 8),
    maxPullbackFromHigh: numberArg("max-pullback", 24),
    states: actionStatesArg(["pullback", "risk"]),
    setups: setupStatesArg(["缩量回踩"]),
    allowHardRisks: boolArg("allow-hard-risks", false),
    evidence: evidenceArg("any"),
    minIntradayScore: numberArg("min-30m-score", 0),
    minIntradaySupportScore: numberArg("min-30m-support", 0),
    maxIntradayDaysSince: numberArg("max-30m-days", 99),
    maxIntradayPullbackAmountRatio: numberArg("max-30m-pullback-ratio", 99),
    requireIntradayHeldMidpoint: boolArg("require-30m-held-midpoint", false),
    minThirtyMinutePullbackScore: numberArg("min-30m-pullback-score", 80),
    maxThirtyMinuteShrinkRatio: numberArg("max-30m-shrink-ratio", 0.95)
  };
}

function horizonsArg(): Horizon[] {
  const raw = argValue("horizons") ?? argValue("horizon") ?? "5,10";
  const values = raw
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item): item is Horizon => item === 5 || item === 10);
  return values.length ? [...new Set(values)] : [5, 10];
}

function dateKey(value?: string) {
  return String(value ?? "").slice(0, 10);
}

function byDateAsc<T extends { t?: string }>(items: T[]) {
  return [...items].sort((a, b) => String(a.t ?? "").localeCompare(String(b.t ?? "")));
}

function safeCode(code: string) {
  return code.replace(/[^0-9A-Z.]/gi, "_");
}

function apiCacheRoot() {
  return resolve(root, process.env.API_CACHE_DIR ?? ".cache/biying");
}

async function readMoneyFlowCache(code: string) {
  const path = resolve(apiCacheRoot(), "money-flow", `${safeCode(plainCode(code))}.json`);
  if (!existsSync(path)) return [];
  try {
    const envelope = JSON.parse(await readFile(path, "utf8")) as MoneyFlowEnvelope | MoneyFlow[];
    const rows = Array.isArray(envelope) ? envelope : envelope.data;
    return byDateAsc(Array.isArray(rows) ? rows : []);
  } catch (error) {
    console.warn(`[backtest] money-flow cache skipped ${code}: ${(error as Error).message}`);
    return [];
  }
}

async function readStockNameIndex() {
  const path = resolve(root, "public/reports/stocks/index.json");
  if (!existsSync(path)) return new Map<string, string>();
  try {
    const index = JSON.parse(await readFile(path, "utf8")) as StockIndex;
    return new Map((index.items ?? []).map((item) => [item.instrument, item.name]));
  } catch {
    return new Map<string, string>();
  }
}

async function listStocksFromDailyCache() {
  const dir = resolve(klineCacheRoot(), "daily");
  if (!existsSync(dir)) return [];
  const names = await readStockNameIndex();
  const files = (await readdir(dir)).filter((file) => file.endsWith(".json"));
  return files.map((file): StockListItem => {
    const instrument = file.replace(/\.json$/, "");
    const exchange = inferExchange(instrument);
    const code = plainCode(instrument);
    return {
      dm: code,
      jys: exchange,
      mc: names.get(toInstrumentCode(code, exchange)) ?? instrument
    };
  });
}

async function loadBacktestUniverse() {
  const cached = (await readStockListCache()).filter(isMainBoardNonSt);
  if (cached.length) return { stocks: cached, source: "stock-list-cache" };

  const fromDailyCache = (await listStocksFromDailyCache()).filter(isMainBoardNonSt);
  if (fromDailyCache.length) return { stocks: fromDailyCache, source: "daily-cache-files" };

  throw new Error("Missing stock universe cache. Run kline sync once before cache-only backtests.");
}

function quoteFromBar(stock: StockListItem, bars: KLine[], index: number): RealQuote {
  const bar = bars[index];
  const previous = bars[index - 1];
  const recent20 = bars.slice(Math.max(0, index - 20), index);
  const recent60 = bars.slice(Math.max(0, index - 60), index);
  const avgAmount20 = average(recent20.map((item) => item.a));
  const first60 = recent60[0];
  return {
    dm: plainCode(stock.dm),
    o: bar.o,
    h: bar.h,
    l: bar.l,
    p: bar.c,
    yc: previous?.c,
    pc: previous ? pctChange(bar.c, previous.c) : pctChange(bar.c, bar.o),
    cje: bar.a,
    v: bar.v,
    hs: 1,
    tr: 1,
    lb: avgAmount20 > 0 ? bar.a / avgAmount20 : 1,
    zdf60: first60 ? pctChange(bar.c, first60.c) : 0,
    t: dateKey(bar.t)
  };
}

function evaluateThirtyMinuteSignal(bars: KLine[]): ThirtyMinuteSignal | undefined {
  const clean = byDateAsc(bars).filter((bar) => Number.isFinite(bar.c) && bar.c > 0 && Number.isFinite(bar.a) && bar.a > 0);
  if (clean.length < 48) return undefined;

  const recent = clean.slice(-48);
  const last8 = recent.slice(-8);
  const previous32 = recent.slice(8, 40);
  const close = recent[recent.length - 1]?.c ?? 0;
  const high = Math.max(...recent.map((bar) => bar.h));
  const low = Math.min(...recent.map((bar) => bar.l));
  const previousLow = Math.min(...previous32.map((bar) => bar.l));
  const last8Low = Math.min(...last8.map((bar) => bar.l));
  const shrinkRatio = average(last8.map((bar) => bar.a)) / Math.max(1, average(previous32.map((bar) => bar.a)));
  const ma20 = average(clean.slice(-20).map((bar) => bar.c));
  const ma60 = average(clean.slice(-60).map((bar) => bar.c));
  const drawdownFromHigh = high > 0 ? ((high - close) / high) * 100 : 0;
  const distanceFromLow = low > 0 ? ((close - low) / low) * 100 : 0;
  const heldRecentLow = last8Low >= previousLow * 0.985;
  const closeAboveMa20 = close >= ma20;
  const closeAboveMa60 = clean.length >= 60 ? close >= ma60 : close >= ma20 * 0.98;

  const shrinkScore = shrinkRatio <= 0.55 ? 22 : shrinkRatio <= 0.75 ? 16 : shrinkRatio <= 0.95 ? 8 : shrinkRatio <= 1.2 ? 0 : -10;
  const drawdownScore = drawdownFromHigh >= 4 && drawdownFromHigh <= 15 ? 18 : drawdownFromHigh > 15 && drawdownFromHigh <= 24 ? 8 : drawdownFromHigh < 2 ? -8 : 0;
  const lowScore = heldRecentLow ? 18 : -18;
  const maScore = (closeAboveMa20 ? 10 : -6) + (closeAboveMa60 ? 8 : -6);
  const locationScore = distanceFromLow >= 3 && distanceFromLow <= 22 ? 8 : distanceFromLow > 35 ? -5 : 0;

  return {
    score: round(50 + shrinkScore + drawdownScore + lowScore + maScore + locationScore, 1),
    shrinkRatio: round(shrinkRatio, 2),
    drawdownFromHigh: round(drawdownFromHigh, 2),
    distanceFromLow: round(distanceFromLow, 2),
    heldRecentLow,
    closeAboveMa20,
    closeAboveMa60
  };
}

function replayPick(pick: StockPick, futureBars: KLine[], horizon: Horizon, config: BacktestConfig): ReplayResult {
  const window = futureBars.slice(0, horizon);
  const entry = pick.price;
  if (window.length < horizon) {
    return {
      horizon,
      status: "pending",
      entryPrice: entry,
      availableDays: window.length,
      remainingDays: horizon - window.length,
      latestDate: dateKey(window[window.length - 1]?.t) || undefined
    };
  }

  let maxHigh = entry;
  let maxRunupDate: string | undefined;
  let maxRunupDay: number | undefined;
  let minLow = entry;
  let maxDrawdownDate: string | undefined;
  let maxDrawdownDay: number | undefined;
  let firstTargetDate: string | undefined;
  let firstStrongTargetDate: string | undefined;
  let firstStretchTargetDate: string | undefined;

  for (let index = 0; index < window.length; index += 1) {
    const bar = window[index];
    const day = index + 1;
    if (bar.h > maxHigh) {
      maxHigh = bar.h;
      maxRunupDate = dateKey(bar.t);
      maxRunupDay = day;
    }
    if (bar.l < minLow) {
      minLow = bar.l;
      maxDrawdownDate = dateKey(bar.t);
      maxDrawdownDay = day;
    }

    const runup = pctChange(bar.h, entry);
    if (!firstTargetDate && runup >= config.targetPct) firstTargetDate = dateKey(bar.t);
    if (!firstStrongTargetDate && runup >= config.strongTargetPct) firstStrongTargetDate = dateKey(bar.t);
    if (!firstStretchTargetDate && runup >= config.stretchTargetPct) firstStretchTargetDate = dateKey(bar.t);
  }

  const close = window[window.length - 1]?.c ?? entry;
  const maxRunupPct = round(pctChange(maxHigh, entry), 2);
  return {
    horizon,
    status: "complete",
    entryPrice: entry,
    availableDays: horizon,
    remainingDays: 0,
    latestDate: dateKey(window[window.length - 1]?.t) || undefined,
    dueDate: dateKey(window[horizon - 1]?.t) || undefined,
    closeReturnPct: round(pctChange(close, entry), 2),
    maxRunupPct,
    maxRunupDate,
    maxRunupDay,
    maxDrawdownPct: round(pctChange(minLow, entry), 2),
    maxDrawdownDate,
    maxDrawdownDay,
    targetHit: maxRunupPct >= config.targetPct,
    strongTargetHit: maxRunupPct >= config.strongTargetPct,
    stretchTargetHit: maxRunupPct >= config.stretchTargetPct,
    firstTargetDate,
    firstStrongTargetDate,
    firstStretchTargetDate
  };
}

function summarize(results: ReplayResult[]): Stats {
  const completed = results.filter((item) => item.status === "complete");
  const targetHits = completed.filter((item) => item.targetHit).length;
  const strongTargetHits = completed.filter((item) => item.strongTargetHit).length;
  const stretchTargetHits = completed.filter((item) => item.stretchTargetHit).length;
  const positiveClose = completed.filter((item) => (item.closeReturnPct ?? 0) > 0).length;
  return {
    samples: results.length,
    completed: completed.length,
    targetHits,
    strongTargetHits,
    stretchTargetHits,
    winRate: completed.length ? round((targetHits / completed.length) * 100, 1) : undefined,
    positiveCloseRate: completed.length ? round((positiveClose / completed.length) * 100, 1) : undefined,
    strongTargetRate: completed.length ? round((strongTargetHits / completed.length) * 100, 1) : undefined,
    stretchTargetRate: completed.length ? round((stretchTargetHits / completed.length) * 100, 1) : undefined,
    avgCloseReturnPct: completed.length ? round(average(completed.map((item) => item.closeReturnPct)), 2) : undefined,
    avgMaxRunupPct: completed.length ? round(average(completed.map((item) => item.maxRunupPct)), 2) : undefined,
    avgMaxDrawdownPct: completed.length ? round(average(completed.map((item) => item.maxDrawdownPct)), 2) : undefined,
    avgPeakDay: completed.length ? round(average(completed.map((item) => item.maxRunupDay)), 1) : undefined
  };
}

function buildStats(picks: BacktestPick[], horizons: Horizon[]) {
  const byActionState: Record<string, Record<string, Stats>> = {};
  const bySetupState: Record<string, Record<string, Stats>> = {};
  for (const state of ACTION_STATES) {
    const group = picks.filter((pick) => pick.actionState === state);
    byActionState[state] = {};
    for (const horizon of horizons) {
      byActionState[state][`${horizon}d`] = summarize(group.map((pick) => pick.replay[`${horizon}d`]).filter(Boolean));
    }
  }
  for (const state of SETUP_STATES) {
    const group = picks.filter((pick) => pick.setupState === state);
    bySetupState[state] = {};
    for (const horizon of horizons) {
      bySetupState[state][`${horizon}d`] = summarize(group.map((pick) => pick.replay[`${horizon}d`]).filter(Boolean));
    }
  }
  return { summary: summarizeByHorizon(picks, horizons), byActionState, bySetupState };
}

function summarizeByHorizon(picks: BacktestPick[], horizons: Horizon[]) {
  const summary: Record<string, Stats> = {};
  for (const horizon of horizons) {
    summary[`${horizon}d`] = summarize(picks.map((pick) => pick.replay[`${horizon}d`]).filter(Boolean));
  }
  return summary;
}

function signalLayerForAction(actionState: StockActionState): SignalLayer {
  return actionState === "pullback" || actionState === "ready" ? "main" : "watch";
}

function buildLayerStats(picks: BacktestPick[], horizons: Horizon[]) {
  const bySignalLayer = Object.fromEntries(
    SIGNAL_LAYERS.map((layer) => [layer, summarizeByHorizon(picks.filter((pick) => pick.signalLayer === layer), horizons)])
  ) as Record<SignalLayer, Record<string, Stats>>;
  return bySignalLayer;
}

function buildAestheticBucketStats(picks: AestheticWatchPick[], horizons: Horizon[]) {
  return Object.fromEntries(
    AESTHETIC_BUCKETS.map((bucket) => [bucket, summarizeByHorizon(picks.filter((pick) => pick.bucket === bucket), horizons)])
  ) as Record<AestheticBucket, Record<string, Stats>>;
}

function applyCooldown<T extends { tradeDate: string; rank: number; instrument: string; cooldownDuplicate?: boolean }>(picks: T[], tradeDates: string[], cooldownDays: number) {
  const dateIndex = new Map(tradeDates.map((date, index) => [date, index]));
  const lastAcceptedIndex = new Map<string, number>();
  const cooldownPicks: T[] = [];
  const ordered = [...picks].sort((a, b) => a.tradeDate.localeCompare(b.tradeDate) || a.rank - b.rank);

  for (const pick of ordered) {
    const currentIndex = dateIndex.get(pick.tradeDate);
    const previousIndex = lastAcceptedIndex.get(pick.instrument);
    const isDuplicate =
      cooldownDays > 0 &&
      currentIndex !== undefined &&
      previousIndex !== undefined &&
      currentIndex - previousIndex <= cooldownDays;

    pick.cooldownDuplicate = isDuplicate;
    if (isDuplicate) continue;

    cooldownPicks.push(pick);
    if (currentIndex !== undefined) lastAcceptedIndex.set(pick.instrument, currentIndex);
  }

  return cooldownPicks;
}

function toDailyRecordPick(pick: BacktestPick): DailyRecordPick {
  return {
    rank: pick.rank,
    instrument: pick.instrument,
    name: pick.name,
    layer: pick.signalLayer,
    state: pick.actionState,
    setup: pick.setupState,
    price: pick.price,
    score: pick.score,
    strategyScore: pick.strategyScore,
    flowRatio5d: pick.flowRatio5d,
    valuePosition: pick.valuePosition,
    pullbackFromHigh: pick.pullbackFromHigh,
    thirtyMinutePullbackScore: pick.thirtyMinutePullbackScore,
    thirtyMinuteShrinkRatio: pick.thirtyMinuteShrinkRatio,
    cooldownDuplicate: Boolean(pick.cooldownDuplicate),
    replay: pick.replay
  };
}

function buildDailyRecords(picks: BacktestPick[], tradeDates: string[]) {
  const byDate = new Map<string, BacktestPick[]>();
  for (const pick of picks) {
    if (!byDate.has(pick.tradeDate)) byDate.set(pick.tradeDate, []);
    byDate.get(pick.tradeDate)?.push(pick);
  }

  return tradeDates.map((tradeDate): DailyRecord => {
    const dayPicks = (byDate.get(tradeDate) ?? []).sort((a, b) => a.rank - b.rank);
    const cooldownEligible = dayPicks.filter((pick) => !pick.cooldownDuplicate);
    return {
      tradeDate,
      signals: dayPicks.length,
      mainSignals: dayPicks.filter((pick) => pick.signalLayer === "main").length,
      watchSignals: dayPicks.filter((pick) => pick.signalLayer === "watch").length,
      cooldownEligibleSignals: cooldownEligible.length,
      cooldownSkippedSignals: dayPicks.length - cooldownEligible.length,
      picks: dayPicks.map(toDailyRecordPick)
    };
  });
}

function buildAestheticDailyRecords(picks: AestheticWatchPick[], tradeDates: string[]) {
  const byDate = new Map<string, AestheticWatchPick[]>();
  for (const pick of picks) {
    if (!byDate.has(pick.tradeDate)) byDate.set(pick.tradeDate, []);
    byDate.get(pick.tradeDate)?.push(pick);
  }

  return tradeDates.map((tradeDate): AestheticDailyRecord => {
    const dayPicks = (byDate.get(tradeDate) ?? []).sort((a, b) => a.rank - b.rank);
    const cooldownEligible = dayPicks.filter((pick) => !pick.cooldownDuplicate);
    const byBucket = Object.fromEntries(
      AESTHETIC_BUCKETS.map((bucket) => [bucket, dayPicks.filter((pick) => pick.bucket === bucket).length])
    ) as Record<AestheticBucket, number>;

    return {
      tradeDate,
      signals: dayPicks.length,
      cooldownEligibleSignals: cooldownEligible.length,
      cooldownSkippedSignals: dayPicks.length - cooldownEligible.length,
      byBucket,
      picks: dayPicks.map((pick) => ({
        ...toDailyRecordPick(pick),
        bucket: pick.bucket,
        bucketLabel: pick.bucketLabel,
        bucketScore: pick.bucketScore,
        priority: pick.priority,
        watchReason: pick.watchReason,
        matchReasons: pick.matchReasons
      }))
    };
  });
}

function buildStrongWatchDailyRecords(picks: StrongWatchPick[], tradeDates: string[]) {
  const byDate = new Map<string, StrongWatchPick[]>();
  for (const pick of picks) {
    if (!byDate.has(pick.tradeDate)) byDate.set(pick.tradeDate, []);
    byDate.get(pick.tradeDate)?.push(pick);
  }

  return tradeDates.map((tradeDate): StrongWatchDailyRecord => {
    const dayPicks = (byDate.get(tradeDate) ?? []).sort((a, b) => a.rank - b.rank);
    const cooldownEligible = dayPicks.filter((pick) => !pick.cooldownDuplicate);
    const byBucket = Object.fromEntries(
      AESTHETIC_BUCKETS.map((bucket) => [bucket, dayPicks.filter((pick) => pick.bucket === bucket).length])
    ) as Record<AestheticBucket, number>;

    return {
      tradeDate,
      signals: dayPicks.length,
      cooldownEligibleSignals: cooldownEligible.length,
      cooldownSkippedSignals: dayPicks.length - cooldownEligible.length,
      byBucket,
      picks: dayPicks.map((pick) => ({
        ...toDailyRecordPick(pick),
        bucket: pick.bucket,
        bucketLabel: pick.bucketLabel,
        bucketScore: pick.bucketScore,
        priority: pick.priority,
        watchReason: pick.watchReason,
        matchReasons: pick.matchReasons,
        strongWatchScore: pick.strongWatchScore,
        strongWatchTier: pick.strongWatchTier,
        strongWatchReason: pick.strongWatchReason
      }))
    };
  });
}

function hardRiskReason(pick: StockPick) {
  const hardRisk = pick.risks.find((risk) => /跌破|失效|派发|阴柱|放量回落|追高|换手过热|量比异常/.test(risk));
  return hardRisk ? `hard-risk:${hardRisk}` : undefined;
}

function swingRankScore(pick: StockPick, thirtyMinuteSignal?: ThirtyMinuteSignal) {
  const actionState = pick.actionState ?? "track";
  const setupBonus =
    pick.setupState === "缩量回踩"
      ? 10
      : pick.setupState === "承接确认"
        ? 5
        : pick.setupState === "二次突破"
          ? 2
          : pick.setupState === "爆量启动"
            ? -3
            : -8;
  const actionBonus = actionState === "pullback" ? 7 : actionState === "ready" ? 5 : actionState === "track" ? -5 : -14;
  const flowBonus = pick.flowRatio5d >= 3 && pick.flowRatio5d <= 6 ? 10 : pick.flowRatio5d >= 1.5 && pick.flowRatio5d < 3 ? 7 : pick.flowRatio5d > 6 && pick.flowRatio5d <= 8 ? 4 : -8;
  const valueBonus =
    pick.valuePosition >= 62 && pick.valuePosition <= 75
      ? 12
      : pick.valuePosition >= 50 && pick.valuePosition < 62
        ? 6
        : pick.valuePosition > 75 && pick.valuePosition <= 78
          ? 1
          : -8;
  const pullbackBonus =
    pick.pullbackFromHigh >= 8 && pick.pullbackFromHigh <= 24
      ? 6
      : pick.pullbackFromHigh >= 5 && pick.pullbackFromHigh <= 32
        ? 3
        : -6;
  const thirtyMinuteBonus = thirtyMinuteSignal ? Math.max(-8, Math.min(10, (thirtyMinuteSignal.score - 64) * 0.35)) : 0;
  return round(pick.score + setupBonus + actionBonus + flowBonus + valueBonus + pullbackBonus + thirtyMinuteBonus - pick.risks.length * 1.8, 2);
}

function bounded(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function priorityFromScore(bucket: AestheticBucket, score: number): AestheticPriority {
  if (bucket === "low-repair") return score >= 78 ? "medium" : "low";
  if (bucket === "intraday-support") return score >= 100 ? "high" : score >= 90 ? "medium" : "low";
  return score >= 92 ? "high" : score >= 82 ? "medium" : "low";
}

function evaluateAestheticWatch(candidate: ScoredCandidate): Omit<AestheticWatchPick, keyof BacktestPick> | undefined {
  const pick = candidate.pick;
  const actionState = pick.actionState ?? "track";
  const thirty = candidate.thirtyMinuteSignal;
  const burst = pick.intradayBurst;
  const hardRisk = hardRiskReason(pick);
  const choices: Array<Omit<AestheticWatchPick, keyof BacktestPick>> = [];

  if (
    !hardRisk &&
    actionState !== "invalid" &&
    ["缩量回踩", "承接确认", "常规观察"].includes(pick.setupState) &&
    pick.score >= 62 &&
    pick.flowRatio5d >= 1.5 &&
    pick.flowRatio5d <= 12 &&
    pick.valuePosition >= 58 &&
    pick.valuePosition <= 78 &&
    pick.pullbackFromHigh >= 5.5 &&
    pick.pullbackFromHigh <= 24 &&
    thirty &&
    thirty.score >= 88 &&
    thirty.shrinkRatio <= 1.08 &&
    pick.risks.length <= 4
  ) {
    const setupFit = pick.setupState === "缩量回踩" ? 10 : pick.setupState === "承接确认" ? 6 : 3;
    const pullbackFit = pick.pullbackFromHigh >= 8 ? 10 : bounded((pick.pullbackFromHigh - 5) * 3, 0, 9);
    const bucketScore = round(
      pick.score +
        (thirty.score - 80) * 0.45 +
        (1.08 - thirty.shrinkRatio) * 12 +
        setupFit +
        pullbackFit +
        Math.min(8, pick.flowRatio5d * 0.6) -
        pick.risks.length * 1.5,
      1
    );
    const bucket: AestheticBucket = "near-main";
    choices.push({
      bucket,
      bucketLabel: aestheticBucketLabels[bucket],
      bucketScore,
      priority: priorityFromScore(bucket, bucketScore),
      watchReason: "主策略只差少量形态/回撤条件，30m 缩量回踩质量较好",
      matchReasons: [
        `30m回踩分 ${thirty.score}`,
        `30m缩量比 ${thirty.shrinkRatio}`,
        `5日资金 ${round(pick.flowRatio5d, 2)}%`,
        `分位 ${round(pick.valuePosition, 1)}%`
      ]
    });
  }

  if (
    !hardRisk &&
    actionState !== "invalid" &&
    burst &&
    burst.score >= 78 &&
    burst.supportScore >= 82 &&
    burst.daysSince <= 4 &&
    burst.pullbackAmountRatio <= 0.65 &&
    pick.score >= 65 &&
    pick.flowRatio5d >= 1 &&
    pick.flowRatio5d <= 6 &&
    pick.pctChange <= 5.5 &&
    pick.pullbackFromHigh <= 38 &&
    pick.risks.length <= 4
  ) {
    const bucketScore = round(
      pick.score +
        (burst.score - 70) * 0.55 +
        (burst.supportScore - 80) * 0.45 +
        (0.65 - burst.pullbackAmountRatio) * 16 +
        Math.min(7, pick.flowRatio5d * 0.5) +
        (burst.daysSince <= 2 ? 6 : 2) -
        Math.max(0, pick.pctChange - 3) * 2 -
        pick.risks.length * 1.4,
      1
    );
    const bucket: AestheticBucket = "intraday-support";
    choices.push({
      bucket,
      bucketLabel: aestheticBucketLabels[bucket],
      bucketScore,
      priority: priorityFromScore(bucket, bucketScore),
      watchReason: "30m 爆量后承接未坏，回调量能明显收缩",
      matchReasons: [
        `异动分 ${burst.score}`,
        `承接分 ${burst.supportScore}`,
        `异动后 ${burst.daysSince} 天`,
        `回调量比 ${burst.pullbackAmountRatio}`
      ]
    });
  }

  if (
    !hardRisk &&
    actionState !== "invalid" &&
    pick.score >= 40 &&
    pick.flowRatio5d >= 2.5 &&
    pick.flowRatio5d <= 6 &&
    pick.valuePosition >= 25 &&
    pick.valuePosition <= 58 &&
    pick.pullbackFromHigh >= 12 &&
    pick.pullbackFromHigh <= 24 &&
    pick.pctChange <= 2.5 &&
    thirty &&
    thirty.score >= 104 &&
    thirty.shrinkRatio <= 0.75 &&
    pick.risks.length <= 4
  ) {
    const valueFit = 10 - Math.min(10, Math.abs(pick.valuePosition - 42) * 0.28);
    const bucketScore = round(
      pick.score +
        (thirty.score - 80) * 0.7 +
        (0.75 - thirty.shrinkRatio) * 18 +
        Math.min(8, pick.flowRatio5d * 0.8) +
        valueFit -
        pick.risks.length * 1.2,
      1
    );
    const bucket: AestheticBucket = "low-repair";
    choices.push({
      bucket,
      bucketLabel: aestheticBucketLabels[bucket],
      bucketScore,
      priority: priorityFromScore(bucket, bucketScore),
      watchReason: "低位修复型，30m 缩量守低点，但日线强度尚未达到主策略",
      matchReasons: [
        `分位 ${round(pick.valuePosition, 1)}%`,
        `30m回踩分 ${thirty.score}`,
        `30m缩量比 ${thirty.shrinkRatio}`,
        `5日资金 ${round(pick.flowRatio5d, 2)}%`
      ]
    });
  }

  return choices.sort((a, b) => b.bucketScore - a.bucketScore)[0];
}

function evaluateStrategyPick(candidate: ScoredCandidate, config: BacktestConfig): { eligible: boolean; strategyScore: number; rejectReason?: string } {
  const pick = candidate.pick;
  if (config.preset === "baseline") return { eligible: true, strategyScore: pick.score };

  const swing = config.swing;
  const actionState = pick.actionState ?? "track";
  if (!swing.states.includes(actionState)) return { eligible: false, strategyScore: pick.score, rejectReason: `state:${actionState}` };
  if (!swing.setups.includes(pick.setupState)) return { eligible: false, strategyScore: pick.score, rejectReason: `setup:${pick.setupState}` };
  if (pick.flowRatio5d < swing.minFlowRatio) return { eligible: false, strategyScore: pick.score, rejectReason: "flow:low" };
  if (pick.flowRatio5d > swing.maxFlowRatio) return { eligible: false, strategyScore: pick.score, rejectReason: "flow:high" };
  if (pick.valuePosition < swing.minValuePosition) return { eligible: false, strategyScore: pick.score, rejectReason: "value:low" };
  if (pick.valuePosition > swing.maxValuePosition) return { eligible: false, strategyScore: pick.score, rejectReason: "value:high" };
  if (pick.score < swing.minScore) return { eligible: false, strategyScore: pick.score, rejectReason: "score:low" };
  if (pick.score > swing.maxScore) return { eligible: false, strategyScore: pick.score, rejectReason: "score:high" };
  if (pick.pullbackFromHigh < swing.minPullbackFromHigh) return { eligible: false, strategyScore: pick.score, rejectReason: "pullback:low" };
  if (pick.pullbackFromHigh > swing.maxPullbackFromHigh) return { eligible: false, strategyScore: pick.score, rejectReason: "pullback:high" };

  const hasIntradayEvidence = Boolean(pick.intradayBurst);
  const hasDailySurgeEvidence = Boolean(pick.surgePullback);
  if (swing.evidence === "intraday" && !hasIntradayEvidence) return { eligible: false, strategyScore: pick.score, rejectReason: "evidence:no-30m" };
  if (swing.evidence === "daily" && !hasDailySurgeEvidence) return { eligible: false, strategyScore: pick.score, rejectReason: "evidence:no-daily-surge" };
  if (swing.evidence === "both" && (!hasIntradayEvidence || !hasDailySurgeEvidence)) {
    return { eligible: false, strategyScore: pick.score, rejectReason: "evidence:not-both" };
  }
  if (pick.intradayBurst) {
    if (pick.intradayBurst.score < swing.minIntradayScore) return { eligible: false, strategyScore: pick.score, rejectReason: "30m:score-low" };
    if (pick.intradayBurst.supportScore < swing.minIntradaySupportScore) return { eligible: false, strategyScore: pick.score, rejectReason: "30m:support-low" };
    if (pick.intradayBurst.daysSince > swing.maxIntradayDaysSince) return { eligible: false, strategyScore: pick.score, rejectReason: "30m:too-old" };
    if (pick.intradayBurst.pullbackAmountRatio > swing.maxIntradayPullbackAmountRatio) {
      return { eligible: false, strategyScore: pick.score, rejectReason: "30m:pullback-volume-high" };
    }
    if (swing.requireIntradayHeldMidpoint && !pick.intradayBurst.heldBodyMidpoint) {
      return { eligible: false, strategyScore: pick.score, rejectReason: "30m:midpoint-lost" };
    }
  }
  if (swing.minThirtyMinutePullbackScore > 0 && (!candidate.thirtyMinuteSignal || candidate.thirtyMinuteSignal.score < swing.minThirtyMinutePullbackScore)) {
    return { eligible: false, strategyScore: pick.score, rejectReason: "30m-pullback:score-low" };
  }
  if (swing.maxThirtyMinuteShrinkRatio < 99 && (!candidate.thirtyMinuteSignal || candidate.thirtyMinuteSignal.shrinkRatio > swing.maxThirtyMinuteShrinkRatio)) {
    return { eligible: false, strategyScore: pick.score, rejectReason: "30m-pullback:not-shrunk" };
  }

  const hardRisk = hardRiskReason(pick);
  if (hardRisk && !swing.allowHardRisks) return { eligible: false, strategyScore: pick.score, rejectReason: hardRisk };

  return { eligible: true, strategyScore: swingRankScore(pick, candidate.thirtyMinuteSignal) };
}

function selectStrategyCandidates(candidates: ScoredCandidate[], config: BacktestConfig, rejected: Map<string, number>): SelectedCandidate[] {
  const selected: SelectedCandidate[] = [];
  for (const candidate of candidates) {
    const decision = evaluateStrategyPick(candidate, config);
    if (!decision.eligible) {
      const reason = decision.rejectReason ?? "unknown";
      rejected.set(reason, (rejected.get(reason) ?? 0) + 1);
      continue;
    }
    selected.push({ ...candidate, strategyScore: decision.strategyScore });
  }
  return selected.sort((a, b) => b.strategyScore - a.strategyScore || b.pick.score - a.pick.score);
}

function buildBacktestPick(args: { tradeDate: string; rank: number; candidate: ScoredCandidate; strategyScore: number; config: BacktestConfig }): BacktestPick {
  const { tradeDate, rank, candidate, strategyScore, config } = args;
  const pick = candidate.pick;
  const thirtyMinuteSignal = candidate.thirtyMinuteSignal;
  const replay = Object.fromEntries(
    config.horizons.map((horizon) => [`${horizon}d`, replayPick(pick, candidate.future, horizon, config)])
  ) as Record<string, ReplayResult>;

  return {
    tradeDate,
    rank,
    instrument: pick.instrument,
    name: pick.name,
    score: pick.score,
    strategyScore,
    signal: pick.signal,
    signalLayer: signalLayerForAction(pick.actionState ?? "track"),
    actionState: pick.actionState ?? "track",
    actionLabel: pick.actionLabel,
    price: pick.price,
    pctChange: pick.pctChange,
    setupState: pick.setupState,
    flowRatio5d: pick.flowRatio5d,
    valuePosition: pick.valuePosition,
    pullbackFromHigh: pick.pullbackFromHigh,
    amountRatio20: pick.amountRatio20,
    actionReason: pick.actionReason,
    intradayScore: pick.intradayBurst?.score,
    intradaySupportScore: pick.intradayBurst?.supportScore,
    intradayDaysSince: pick.intradayBurst?.daysSince,
    intradayPullbackAmountRatio: pick.intradayBurst?.pullbackAmountRatio,
    intradayHeldMidpoint: pick.intradayBurst?.heldBodyMidpoint,
    surgeScore: pick.surgePullback?.score,
    surgeDaysSince: pick.surgePullback?.daysSince,
    surgePullbackAmountRatio: pick.surgePullback?.pullbackAmountRatio,
    thirtyMinutePullbackScore: thirtyMinuteSignal?.score,
    thirtyMinuteShrinkRatio: thirtyMinuteSignal?.shrinkRatio,
    thirtyMinuteDrawdownFromHigh: thirtyMinuteSignal?.drawdownFromHigh,
    thirtyMinuteDistanceFromLow: thirtyMinuteSignal?.distanceFromLow,
    thirtyMinuteHeldRecentLow: thirtyMinuteSignal?.heldRecentLow,
    thirtyMinuteCloseAboveMa20: thirtyMinuteSignal?.closeAboveMa20,
    thirtyMinuteCloseAboveMa60: thirtyMinuteSignal?.closeAboveMa60,
    reasons: pick.reasons,
    risks: pick.risks,
    replay
  };
}

function selectAestheticWatchCandidates(candidates: ScoredCandidate[], excludedInstruments: Set<string>, config: BacktestConfig, tradeDate: string): AestheticWatchPick[] {
  return candidates
    .filter((candidate) => !excludedInstruments.has(candidate.pick.instrument))
    .map((candidate) => {
      const decision = evaluateAestheticWatch(candidate);
      if (!decision) return undefined;
      const baseScore = decision.bucketScore + (decision.priority === "high" ? 6 : decision.priority === "medium" ? 2 : 0);
      return {
        candidate,
        decision,
        sortScore: baseScore
      };
    })
    .filter((item): item is { candidate: ScoredCandidate; decision: Omit<AestheticWatchPick, keyof BacktestPick>; sortScore: number } => Boolean(item))
    .sort((a, b) => b.sortScore - a.sortScore || b.candidate.pick.score - a.candidate.pick.score)
    .slice(0, config.aestheticTop)
    .map((item, index) => ({
      ...buildBacktestPick({
        tradeDate,
        rank: index + 1,
        candidate: item.candidate,
        strategyScore: item.decision.bucketScore,
        config
      }),
      ...item.decision
    }));
}

function evaluateStrongWatch(pick: AestheticWatchPick): Omit<StrongWatchPick, keyof AestheticWatchPick> | undefined {
  const score30m = pick.thirtyMinutePullbackScore ?? 0;
  const shrink = pick.thirtyMinuteShrinkRatio ?? 99;
  const risks = pick.risks.length;
  const pct = pick.pctChange ?? 0;
  const nearMainFit =
    pick.bucket === "near-main" &&
    pick.bucketScore >= 105 &&
    pick.flowRatio5d >= 1.5 &&
    pick.flowRatio5d <= 12 &&
    pick.valuePosition >= 58 &&
    pick.valuePosition <= 78 &&
    pick.pullbackFromHigh >= 5.5 &&
    pick.pullbackFromHigh <= 24 &&
    score30m >= 88 &&
    shrink <= 1.08 &&
    risks <= 3;
  const intradayFit =
    pick.bucket === "intraday-support" &&
    pick.bucketScore >= 90 &&
    (pick.intradaySupportScore ?? 0) >= 82 &&
    (pick.intradayDaysSince ?? 99) <= 4 &&
    (pick.intradayPullbackAmountRatio ?? 99) <= 0.65 &&
    pick.flowRatio5d >= 1 &&
    pick.flowRatio5d <= 6 &&
    pct <= 5.5 &&
    risks <= 3;
  const lowRepairFit =
    pick.bucket === "low-repair" &&
    pick.bucketScore >= 86 &&
    pick.flowRatio5d >= 2.5 &&
    pick.flowRatio5d <= 6 &&
    pick.pullbackFromHigh >= 12 &&
    pick.pullbackFromHigh <= 24 &&
    score30m >= 104 &&
    shrink <= 0.75 &&
    pct <= 2.5 &&
    risks <= 3;

  if (!nearMainFit && !intradayFit && !lowRepairFit) return undefined;

  const setupBonus = pick.setupState === "缩量回踩" ? 7 : pick.setupState === "承接确认" ? 5 : 1;
  const actionBonus = pick.actionState === "pullback" ? 5 : pick.actionState === "track" ? 2 : pick.actionState === "risk" ? -1 : 0;
  const score30mBonus = Math.min(18, Math.max(0, score30m - 90) * 0.45);
  const shrinkBonus = Math.max(0, (1 - Math.min(shrink, 1.15)) * 16);
  const flowPenalty = pick.flowRatio5d > 10 ? (pick.flowRatio5d - 10) * 1.8 : 0;
  const chasePenalty = pct > 4 ? (pct - 4) * 2 : 0;
  const bucketBonus = pick.bucket === "intraday-support" ? 14 : pick.bucket === "low-repair" ? 10 : 0;
  const strongWatchScore = round(
    pick.bucketScore + setupBonus + actionBonus + score30mBonus + shrinkBonus + bucketBonus - risks * 2 - flowPenalty - chasePenalty,
    1
  );
  const strongWatchTier = strongWatchScore >= 116 || intradayFit || lowRepairFit ? "A" : "B";
  const strongWatchReason =
    pick.bucket === "near-main"
      ? "接近主策略且 30m 缩量回踩质量更高"
      : pick.bucket === "intraday-support"
        ? "30m 异动后承接强，回调量能明显收缩"
        : "低位修复中 30m 守低点，适合作为小仓观察";

  return {
    strongWatchScore,
    strongWatchTier,
    strongWatchReason
  };
}

function selectStrongWatchCandidates(aestheticPicks: AestheticWatchPick[], config: BacktestConfig): StrongWatchPick[] {
  return aestheticPicks
    .map((pick) => {
      const decision = evaluateStrongWatch(pick);
      if (!decision) return undefined;
      return {
        pick,
        decision,
        sortScore: decision.strongWatchScore + (decision.strongWatchTier === "A" ? 8 : 0)
      };
    })
    .filter((item): item is { pick: AestheticWatchPick; decision: Omit<StrongWatchPick, keyof AestheticWatchPick>; sortScore: number } => Boolean(item))
    .sort((a, b) => b.sortScore - a.sortScore || b.pick.bucketScore - a.pick.bucketScore)
    .slice(0, config.strongWatchTop)
    .map((item, index) => ({
      ...item.pick,
      ...item.decision,
      rank: index + 1,
      strategyScore: item.decision.strongWatchScore
    }));
}

function intradayUpToDate(bars: KLine[], tradeDate: string, limit: number) {
  return bars.filter((bar) => dateKey(bar.t) <= tradeDate).slice(-limit);
}

function markdownStatsTable(rows: Record<string, Stats>) {
  return [
    "| Horizon | Signals | Complete | Hit Target | Positive Close | Hit Strong | Hit Stretch | Avg Close | Avg Runup | Avg Drawdown | Avg Peak Day |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...Object.entries(rows).map(([horizon, stats]) =>
      `| ${horizon} | ${stats.samples} | ${stats.completed} | ${stats.winRate ?? "-"}% | ${stats.positiveCloseRate ?? "-"}% | ${stats.strongTargetRate ?? "-"}% | ${stats.stretchTargetRate ?? "-"}% | ${stats.avgCloseReturnPct ?? "-"}% | ${stats.avgMaxRunupPct ?? "-"}% | ${stats.avgMaxDrawdownPct ?? "-"}% | ${stats.avgPeakDay ?? "-"} |`
    )
  ];
}

function formatReplayForLedger(replay: Record<string, ReplayResult>) {
  return Object.entries(replay)
    .map(([horizon, result]) => {
      if (result.status !== "complete") return `${horizon}: pending`;
      return `${horizon}: high ${result.maxRunupPct ?? "-"}%, close ${result.closeReturnPct ?? "-"}%, dd ${result.maxDrawdownPct ?? "-"}%`;
    })
    .join("; ");
}

function formatDailyPick(pick: DailyRecordPick) {
  const cooldown = pick.cooldownDuplicate ? "cooldown" : "new";
  return `${pick.instrument} ${pick.name} [${pick.layer}/${cooldown}] ${formatReplayForLedger(pick.replay)}`;
}

function formatAestheticDailyPick(pick: AestheticDailyRecordPick) {
  const cooldown = pick.cooldownDuplicate ? "cooldown" : "new";
  return `${pick.instrument} ${pick.name} [${pick.bucketLabel}/${pick.priority}/${cooldown}] ${formatReplayForLedger(pick.replay)}`;
}

function formatStrongWatchDailyPick(pick: StrongWatchDailyRecordPick) {
  const cooldown = pick.cooldownDuplicate ? "cooldown" : "new";
  return `${pick.instrument} ${pick.name} [${pick.strongWatchTier}/${pick.bucketLabel}/${cooldown}] ${formatReplayForLedger(pick.replay)}`;
}

function markdownDailyLedger(report: BacktestReport) {
  const aestheticByDate = new Map((report.aestheticWatch?.dailyRecords ?? []).map((day) => [day.tradeDate, day]));
  const strongByDate = new Map((report.strongWatch?.dailyRecords ?? []).map((day) => [day.tradeDate, day]));
  const lines = [
    "# Strategy Daily Ledger",
    "",
    `Generated: ${report.meta.generatedAt}`,
    `Range: ${report.meta.from ?? "-"} to ${report.meta.to ?? "-"}`,
    `Cooldown: ${report.meta.cooldownDays} trade days`,
    "",
    "| Date | Signals | New | Main | Watch | Cooldown Skips | Picks | Strong Watch | Aesthetic Watch |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |"
  ];

  for (const day of report.dailyRecords) {
    const picks = day.picks.length ? day.picks.map(formatDailyPick).join("<br>") : "-";
    const strong = strongByDate.get(day.tradeDate);
    const strongPicks = strong?.picks.length ? strong.picks.map(formatStrongWatchDailyPick).join("<br>") : "-";
    const aesthetic = aestheticByDate.get(day.tradeDate);
    const aestheticPicks = aesthetic?.picks.length ? aesthetic.picks.map(formatAestheticDailyPick).join("<br>") : "-";
    lines.push(
      `| ${day.tradeDate} | ${day.signals} | ${day.cooldownEligibleSignals} | ${day.mainSignals} | ${day.watchSignals} | ${day.cooldownSkippedSignals} | ${picks} | ${strongPicks} | ${aestheticPicks} |`
    );
  }

  return `${lines.join("\n")}\n`;
}

function markdownReport(report: BacktestReport) {
  const lines = [
    "# Strategy Backtest",
    "",
    `Generated: ${report.meta.generatedAt}`,
    `Range: ${report.meta.from ?? "-"} to ${report.meta.to ?? "-"}`,
    `Mode: ${report.meta.mode}`,
    `Preset: ${report.meta.preset}; 30m refine: ${report.meta.useIntraday30m ? `${report.meta.refineCandidates} candidates/date, ${report.meta.intraday30mBars} bars` : "off"}`,
    `Signal replay: close-to-future; hit thresholds: ${report.meta.targetPct}% / ${report.meta.strongTargetPct}% / ${report.meta.stretchTargetPct}%`,
    `Universe: ${report.meta.universe}; evaluated dates: ${report.meta.evaluatedDates}; top per day: ${report.meta.top}; cooldown: ${report.meta.cooldownDays} trade days`,
    "",
    "## Summary",
    "",
    ...markdownStatsTable(report.summary),
    "",
    "## Cooldown Summary",
    "",
    ...markdownStatsTable(report.cooldownSummary),
    "",
    "## By Signal Layer",
    "",
  ];

  for (const [layer, horizons] of Object.entries(report.bySignalLayer)) {
    lines.push(`### ${layer}`, "");
    lines.push(...markdownStatsTable(horizons), "");
  }

  lines.push("## Cooldown By Signal Layer", "");
  for (const [layer, horizons] of Object.entries(report.cooldownBySignalLayer)) {
    lines.push(`### ${layer}`, "");
    lines.push(...markdownStatsTable(horizons), "");
  }

  if (report.aestheticWatch) {
    lines.push("## Aesthetic Watch", "");
    lines.push("审美观察池独立统计，不合并进主策略 summary。", "");
    lines.push("### Summary", "");
    lines.push(...markdownStatsTable(report.aestheticWatch.summary), "");
    lines.push("### Cooldown Summary", "");
    lines.push(...markdownStatsTable(report.aestheticWatch.cooldownSummary), "");
    lines.push("### By Bucket", "");
    for (const bucket of AESTHETIC_BUCKETS) {
      lines.push(`#### ${aestheticBucketLabels[bucket]}`, "");
      lines.push(...markdownStatsTable(report.aestheticWatch.byBucket[bucket]), "");
    }
  }

  if (report.strongWatch) {
    lines.push("## Strong Watch", "");
    lines.push("强观察池从审美观察池中二次筛选，目标是保留更接近波段买点的少量候选。", "");
    lines.push("### Summary", "");
    lines.push(...markdownStatsTable(report.strongWatch.summary), "");
    lines.push("### Cooldown Summary", "");
    lines.push(...markdownStatsTable(report.strongWatch.cooldownSummary), "");
    lines.push("### By Bucket", "");
    for (const bucket of AESTHETIC_BUCKETS) {
      lines.push(`#### ${aestheticBucketLabels[bucket]}`, "");
      lines.push(...markdownStatsTable(report.strongWatch.byBucket[bucket]), "");
    }
  }

  lines.push(
    "## Daily Ledger Preview",
    "",
    "| Date | Signals | New | Main | Watch | Cooldown Skips | Strong | Aesthetic |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
  );
  for (const day of report.dailyRecords) {
    const aesthetic = report.aestheticWatch?.dailyRecords.find((item) => item.tradeDate === day.tradeDate);
    const strong = report.strongWatch?.dailyRecords.find((item) => item.tradeDate === day.tradeDate);
    lines.push(
      `| ${day.tradeDate} | ${day.signals} | ${day.cooldownEligibleSignals} | ${day.mainSignals} | ${day.watchSignals} | ${day.cooldownSkippedSignals} | ${strong?.signals ?? 0} | ${aesthetic?.signals ?? 0} |`
    );
  }

  lines.push(
    "",
    "## By Action State",
    ""
  );

  for (const [state, horizons] of Object.entries(report.byActionState)) {
    lines.push(`### ${state}`, "");
    lines.push("| Horizon | Signals | Complete | Hit Target | Positive Close | Hit Strong | Hit Stretch | Avg Close | Avg Runup | Avg Drawdown | Avg Peak Day |");
    lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
    for (const [horizon, stats] of Object.entries(horizons)) {
      lines.push(
        `| ${horizon} | ${stats.samples} | ${stats.completed} | ${stats.winRate ?? "-"}% | ${stats.positiveCloseRate ?? "-"}% | ${stats.strongTargetRate ?? "-"}% | ${stats.stretchTargetRate ?? "-"}% | ${stats.avgCloseReturnPct ?? "-"}% | ${stats.avgMaxRunupPct ?? "-"}% | ${stats.avgMaxDrawdownPct ?? "-"}% | ${stats.avgPeakDay ?? "-"} |`
      );
    }
    lines.push("");
  }

  lines.push("## By Setup State", "");
  for (const [state, horizons] of Object.entries(report.bySetupState)) {
    const samples = Object.values(horizons).reduce((total, stats) => total + stats.samples, 0);
    if (!samples) continue;
    lines.push(`### ${state}`, "");
    lines.push("| Horizon | Signals | Complete | Hit Target | Positive Close | Hit Strong | Hit Stretch | Avg Close | Avg Runup | Avg Drawdown | Avg Peak Day |");
    lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
    for (const [horizon, stats] of Object.entries(horizons)) {
      lines.push(
        `| ${horizon} | ${stats.samples} | ${stats.completed} | ${stats.winRate ?? "-"}% | ${stats.positiveCloseRate ?? "-"}% | ${stats.strongTargetRate ?? "-"}% | ${stats.stretchTargetRate ?? "-"}% | ${stats.avgCloseReturnPct ?? "-"}% | ${stats.avgMaxRunupPct ?? "-"}% | ${stats.avgMaxDrawdownPct ?? "-"}% | ${stats.avgPeakDay ?? "-"} |`
      );
    }
    lines.push("");
  }

  if (report.meta.preset === "swing" && report.meta.swing) {
    const filters = report.meta.swing;
    lines.push("## Swing Filters", "");
    lines.push(`- States: ${filters.states.join(", ")}`);
    lines.push(`- Setups: ${filters.setups.join(", ")}`);
    lines.push(`- Flow ratio: ${filters.minFlowRatio}% to ${filters.maxFlowRatio}%`);
    lines.push(`- Value position: ${filters.minValuePosition}% to ${filters.maxValuePosition}%`);
    lines.push(`- Score: ${filters.minScore} to ${filters.maxScore}`);
    lines.push(`- Pullback from high: ${filters.minPullbackFromHigh}% to ${filters.maxPullbackFromHigh}%`);
    lines.push(`- Evidence: ${filters.evidence}`);
    if (filters.minIntradayScore > 0) lines.push(`- Min 30m score: ${filters.minIntradayScore}`);
    if (filters.minIntradaySupportScore > 0) lines.push(`- Min 30m support: ${filters.minIntradaySupportScore}`);
    if (filters.maxIntradayDaysSince < 99) lines.push(`- Max 30m days since burst: ${filters.maxIntradayDaysSince}`);
    if (filters.maxIntradayPullbackAmountRatio < 99) lines.push(`- Max 30m pullback amount ratio: ${filters.maxIntradayPullbackAmountRatio}`);
    if (filters.requireIntradayHeldMidpoint) lines.push("- Require 30m body midpoint held");
    if (filters.minThirtyMinutePullbackScore > 0) lines.push(`- Min 30m pullback score: ${filters.minThirtyMinutePullbackScore}`);
    if (filters.maxThirtyMinuteShrinkRatio < 99) lines.push(`- Max 30m shrink ratio: ${filters.maxThirtyMinuteShrinkRatio}`);
    lines.push("");
  }

  if (report.meta.selectDate) {
    lines.push("## Selected Signals", "");
    lines.push("| Rank | Instrument | Name | Price | Score | Strategy | State | Setup | Flow 5d | Value | Pullback | 30m Score | 30m Shrink | 30m Drawdown |");
    lines.push("| ---: | --- | --- | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |");
    for (const pick of report.picks) {
      lines.push(
        `| ${pick.rank} | ${pick.instrument} | ${pick.name} | ${pick.price} | ${pick.score} | ${pick.strategyScore} | ${pick.actionState} | ${pick.setupState} | ${pick.flowRatio5d}% | ${pick.valuePosition}% | ${pick.pullbackFromHigh}% | ${pick.thirtyMinutePullbackScore ?? "-"} | ${pick.thirtyMinuteShrinkRatio ?? "-"} | ${pick.thirtyMinuteDrawdownFromHigh ?? "-"}% |`
      );
    }
    lines.push("");

    if (report.aestheticWatch?.picks.length) {
      lines.push("## Selected Aesthetic Watch", "");
      lines.push("| Rank | Bucket | Priority | Instrument | Name | Price | Score | Watch Score | State | Setup | Flow 5d | Value | Pullback | 30m Score | 30m Shrink | Reason |");
      lines.push("| ---: | --- | --- | --- | --- | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |");
      for (const pick of report.aestheticWatch.picks) {
        lines.push(
          `| ${pick.rank} | ${pick.bucketLabel} | ${pick.priority} | ${pick.instrument} | ${pick.name} | ${pick.price} | ${pick.score} | ${pick.bucketScore} | ${pick.actionState} | ${pick.setupState} | ${pick.flowRatio5d}% | ${pick.valuePosition}% | ${pick.pullbackFromHigh}% | ${pick.thirtyMinutePullbackScore ?? "-"} | ${pick.thirtyMinuteShrinkRatio ?? "-"} | ${pick.watchReason} |`
        );
      }
      lines.push("");
    }

    if (report.strongWatch?.picks.length) {
      lines.push("## Selected Strong Watch", "");
      lines.push("| Rank | Tier | Bucket | Instrument | Name | Price | Score | Strong Score | State | Setup | Flow 5d | Value | Pullback | 30m Score | 30m Shrink | Reason |");
      lines.push("| ---: | --- | --- | --- | --- | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |");
      for (const pick of report.strongWatch.picks) {
        lines.push(
          `| ${pick.rank} | ${pick.strongWatchTier} | ${pick.bucketLabel} | ${pick.instrument} | ${pick.name} | ${pick.price} | ${pick.score} | ${pick.strongWatchScore} | ${pick.actionState} | ${pick.setupState} | ${pick.flowRatio5d}% | ${pick.valuePosition}% | ${pick.pullbackFromHigh}% | ${pick.thirtyMinutePullbackScore ?? "-"} | ${pick.thirtyMinuteShrinkRatio ?? "-"} | ${pick.strongWatchReason} |`
        );
      }
      lines.push("");
    }
  }

  lines.push("## Notes", "");
  for (const note of report.meta.notes) lines.push(`- ${note}`);
  return `${lines.join("\n")}\n`;
}

async function run() {
  const preset = presetArg();
  const top = numberArg("top", 10);
  const useIntraday30m = !hasFlag("no-30m") && boolArg("use-30m", preset === "swing");
  const config: BacktestConfig = {
    from: argValue("from"),
    to: argValue("to"),
    selectDate: argValue("select-date"),
    horizons: horizonsArg(),
    top,
    historyDays: numberArg("history-days", 120),
    flowDays: numberArg("flow-days", 10),
    targetPct: numberArg("target-pct", 5),
    strongTargetPct: numberArg("strong-target-pct", 8),
    stretchTargetPct: numberArg("stretch-target-pct", 10),
    cooldownDays: nonNegativeNumberArg("cooldown-days", 5),
    maxDates: numberArg("max-dates", 80),
    outputDir: resolve(root, argValue("output-dir") ?? "public/reports/backtests"),
    preset,
    aestheticTop: numberArg("aesthetic-top", Math.max(top * 2, 20)),
    strongWatchTop: numberArg("strong-watch-top", 5),
    useIntraday30m,
    intraday30mBars: numberArg("30m-bars", 160),
    refineCandidates: numberArg("refine-candidates", preset === "swing" ? Math.max(top * 40, 400) : Math.max(top * 20, 200)),
    swing: swingFilterConfig()
  };
  const maxHorizon = Math.max(...config.horizons);
  const minHorizon = Math.min(...config.horizons);
  const replayDays = maxHorizon;

  const { stocks, source: universeSource } = await loadBacktestUniverse();

  const stockData: StockData[] = [];
  let skippedNoDaily = 0;
  let stocksWithMoneyFlow = 0;
  for (const stock of stocks) {
    const instrument = toInstrumentCode(plainCode(stock.dm), inferExchange(stock.dm, stock.jys));
    const daily = await readKLineCache("daily", instrument);
    if (daily.length < config.historyDays + (config.selectDate ? 0 : replayDays)) {
      skippedNoDaily += 1;
      continue;
    }
    const flows = await readMoneyFlowCache(stock.dm);
    if (flows.length) stocksWithMoneyFlow += 1;
    stockData.push({ stock: { ...stock, dm: plainCode(stock.dm), jys: inferExchange(stock.dm, stock.jys) }, instrument, daily, flows });
  }

  const intradayCache = new Map<string, KLine[]>();
  const intradayStocksWithBars = new Set<string>();
  let intraday30mRefinedCandidates = 0;
  async function readIntraday30m(instrument: string) {
    if (intradayCache.has(instrument)) return intradayCache.get(instrument) ?? [];
    const bars = await readKLineCache("30m", instrument);
    intradayCache.set(instrument, bars);
    if (bars.length) intradayStocksWithBars.add(instrument);
    return bars;
  }

  const allDates = [...new Set(stockData.flatMap((item) => item.daily.map((bar) => dateKey(bar.t))))].sort();
  const candidateDates = config.selectDate
    ? allDates.filter((date) => date === config.selectDate)
    : allDates.filter((date) => (!config.from || date >= config.from) && (!config.to || date <= config.to)).slice(-config.maxDates);

  if (config.selectDate && candidateDates.length === 0) {
    throw new Error(`No cached trade date found for --select-date ${config.selectDate}`);
  }

  const picks: BacktestPick[] = [];
  const aestheticPicks: AestheticWatchPick[] = [];
  const strongWatchPicks: StrongWatchPick[] = [];
  const rejected = new Map<string, number>();
  for (const tradeDate of candidateDates) {
    const scored: ScoredCandidate[] = [];
    for (const item of stockData) {
      const index = item.daily.findIndex((bar) => dateKey(bar.t) === tradeDate);
      if (index < config.historyDays || index < 0) continue;
      const history = item.daily.slice(Math.max(0, index - config.historyDays + 1), index + 1);
      const future = item.daily.slice(index + 1, index + 1 + replayDays);
      if (!config.selectDate && future.length < minHorizon) continue;
      const flows = item.flows.filter((flow) => dateKey(flow.t) <= tradeDate).slice(-config.flowDays);
      const pick = scoreCandidate({
        stock: item.stock,
        quote: quoteFromBar(item.stock, item.daily, index),
        history,
        flows
      });
      if (pick) scored.push({ item, pick, tradeIndex: index, history, flows, future });
    }

    scored.sort((a, b) => b.pick.score - a.pick.score);
    let pool = scored;
    if (config.useIntraday30m) {
      const refined: ScoredCandidate[] = [];
      for (const candidate of scored.slice(0, config.refineCandidates)) {
        const intraday30m = intradayUpToDate(await readIntraday30m(candidate.item.instrument), tradeDate, config.intraday30mBars);
        if (intraday30m.length) intraday30mRefinedCandidates += 1;
        const thirtyMinuteSignal = evaluateThirtyMinuteSignal(intraday30m);
        const pick = scoreCandidate({
          stock: candidate.item.stock,
          quote: quoteFromBar(candidate.item.stock, candidate.item.daily, candidate.tradeIndex),
          history: candidate.history,
          intraday30m,
          flows: candidate.flows
        });
        if (pick) refined.push({ ...candidate, pick, thirtyMinuteSignal });
      }
      pool = refined.sort((a, b) => b.pick.score - a.pick.score);
    }

    const strategyCandidates = selectStrategyCandidates(pool, config, rejected);
    const strategyEligibleInstruments = new Set(strategyCandidates.map((candidate) => candidate.pick.instrument));
    strategyCandidates
      .slice(0, config.top)
      .forEach((candidate, index) => {
        picks.push(buildBacktestPick({ tradeDate, rank: index + 1, candidate, strategyScore: candidate.strategyScore, config }));
      });

    if (config.preset === "swing") {
      const dayAestheticPicks = selectAestheticWatchCandidates(pool, strategyEligibleInstruments, config, tradeDate);
      aestheticPicks.push(...dayAestheticPicks);
      strongWatchPicks.push(...selectStrongWatchCandidates(dayAestheticPicks, config));
    }

    if (picks.length && picks.length % (config.top * 10) === 0) {
      console.log(`[backtest] ${tradeDate} picks=${picks.length}`);
    }
  }

  const cooldownPicks = applyCooldown(picks, candidateDates, config.cooldownDays);
  const cooldownAestheticPicks = applyCooldown(aestheticPicks, candidateDates, config.cooldownDays);
  const cooldownStrongWatchPicks = applyCooldown(strongWatchPicks, candidateDates, config.cooldownDays);
  const dailyRecords = buildDailyRecords(picks, candidateDates);
  const aestheticDailyRecords = buildAestheticDailyRecords(aestheticPicks, candidateDates);
  const strongWatchDailyRecords = buildStrongWatchDailyRecords(strongWatchPicks, candidateDates);
  const stats = buildStats(picks, config.horizons);
  const aestheticWatch: AestheticWatchReport | undefined =
    config.preset === "swing"
      ? {
          summary: summarizeByHorizon(aestheticPicks, config.horizons),
          cooldownSummary: summarizeByHorizon(cooldownAestheticPicks, config.horizons),
          byBucket: buildAestheticBucketStats(aestheticPicks, config.horizons),
          cooldownByBucket: buildAestheticBucketStats(cooldownAestheticPicks, config.horizons),
          dailyRecords: aestheticDailyRecords,
          picks: aestheticPicks
        }
      : undefined;
  const strongWatch: StrongWatchReport | undefined =
    config.preset === "swing"
      ? {
          summary: summarizeByHorizon(strongWatchPicks, config.horizons),
          cooldownSummary: summarizeByHorizon(cooldownStrongWatchPicks, config.horizons),
          byBucket: buildAestheticBucketStats(strongWatchPicks, config.horizons),
          cooldownByBucket: buildAestheticBucketStats(cooldownStrongWatchPicks, config.horizons),
          dailyRecords: strongWatchDailyRecords,
          picks: strongWatchPicks
        }
      : undefined;
  const report: BacktestReport = {
    meta: {
      generatedAt: new Date().toISOString(),
      mode: "cache-only",
      from: candidateDates[0],
      to: candidateDates[candidateDates.length - 1],
      selectDate: config.selectDate,
      horizons: config.horizons,
      top: config.top,
      historyDays: config.historyDays,
      flowDays: config.flowDays,
      targetPct: config.targetPct,
      strongTargetPct: config.strongTargetPct,
      stretchTargetPct: config.stretchTargetPct,
      cooldownDays: config.cooldownDays,
      preset: config.preset,
      aestheticTop: config.aestheticTop,
      strongWatchTop: config.strongWatchTop,
      useIntraday30m: config.useIntraday30m,
      intraday30mBars: config.intraday30mBars,
      refineCandidates: config.refineCandidates,
      swing: config.preset === "swing" ? config.swing : undefined,
      rejected: Object.fromEntries([...rejected.entries()].sort((a, b) => b[1] - a[1])),
      evaluatedDates: candidateDates.length,
      universe: stockData.length,
      notes: [
        "Backtest is cache-only and does not call Biying API.",
        `Universe source: ${universeSource}.`,
        "Each trade date only uses K-line and money-flow cache rows at or before that date.",
        "Signal replay treats the historical trade-date close as the signal price, then observes later 5/10 day performance without simulating buy/sell execution.",
        config.useIntraday30m
          ? "30m K-line refinement is also sliced at or before each trade date to avoid look-ahead bias."
          : "30m K-line refinement is disabled for this run.",
        "This replay reports future close return, max runup, max drawdown, and the date/day of peak runup; it does not simulate buy/sell execution.",
        "Cooldown summary removes repeated signals for the same instrument within the configured trade-day window, while raw summary keeps every signal.",
        "This lab version approximates quote turnover/volume-ratio from cached daily bars when realtime quote fields are unavailable.",
        "Aesthetic watch is a separate observation pool for near-main, 30m-support, and low-repair patterns; it is not merged into main strategy statistics.",
        "Strong watch is a second-stage filter over aesthetic watch, intended to surface a smaller set of higher-conviction swing candidates."
      ]
    },
    cache: {
      stocksWithDaily: stockData.length,
      stocksWithMoneyFlow,
      stocksWithIntraday30m: intradayStocksWithBars.size,
      intraday30mRefinedCandidates,
      skippedNoDaily
    },
    summary: stats.summary,
    cooldownSummary: summarizeByHorizon(cooldownPicks, config.horizons),
    byActionState: stats.byActionState,
    bySetupState: stats.bySetupState,
    bySignalLayer: buildLayerStats(picks, config.horizons),
    cooldownBySignalLayer: buildLayerStats(cooldownPicks, config.horizons),
    aestheticWatch,
    strongWatch,
    dailyRecords,
    picks
  };

  await mkdir(config.outputDir, { recursive: true });
  await writeFile(resolve(config.outputDir, "latest.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(resolve(config.outputDir, "summary.md"), markdownReport(report), "utf8");
  await writeFile(resolve(config.outputDir, "daily-ledger.md"), markdownDailyLedger(report), "utf8");
  console.log(`[backtest] wrote ${resolve(config.outputDir, "latest.json")}`);
  console.log(`[backtest] wrote ${resolve(config.outputDir, "summary.md")}`);
  console.log(`[backtest] wrote ${resolve(config.outputDir, "daily-ledger.md")}`);
}

await run();
