import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { average, pctChange, round } from "../src/lib/math";
import type { KLine, SetupState, StockActionState } from "../src/lib/types";
import { readKLineCache } from "./kline-cache";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

dotenv.config({ path: resolve(root, ".env.local"), override: false, quiet: true });
dotenv.config({ path: resolve(root, ".env"), override: false, quiet: true });

type Horizon = 5 | 10;
type ReplayStatus = "complete" | "pending";
type ArchiveReplayStatus = "pending" | "5d-complete" | "10d-complete";
type SignalLayer = "main" | "watch";
type AestheticBucket = "near-main" | "intraday-support" | "low-repair";

const ACTION_STATES = ["ready", "pullback", "track", "risk", "invalid"] as const satisfies readonly StockActionState[];
const SETUP_STATES = ["二次突破", "承接确认", "缩量回踩", "爆量启动", "承接转弱", "放量派发风险", "跌破失效", "常规观察"] as const satisfies readonly SetupState[];
const SIGNAL_LAYERS = ["main", "watch"] as const satisfies readonly SignalLayer[];
const AESTHETIC_BUCKETS = ["near-main", "intraday-support", "low-repair"] as const satisfies readonly AestheticBucket[];

type ReplayResult = {
  horizon: Horizon;
  status: ReplayStatus;
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

type StrategyPick = {
  tradeDate: string;
  rank: number;
  instrument: string;
  name: string;
  price: number;
  score?: number;
  strategyScore?: number;
  bucketScore?: number;
  strongWatchScore?: number;
  bucketLabel?: string;
  strongWatchTier?: "A" | "B";
  flowRatio5d?: number;
  valuePosition?: number;
  pullbackFromHigh?: number;
  thirtyMinutePullbackScore?: number;
  thirtyMinuteShrinkRatio?: number;
  actionState?: StockActionState;
  state?: StockActionState;
  setupState?: SetupState;
  setup?: SetupState;
  signalLayer?: SignalLayer;
  layer?: SignalLayer;
  bucket?: AestheticBucket;
  cooldownDuplicate?: boolean;
  replay: Record<string, ReplayResult>;
};

type StrategyPool<T extends StrategyPick = StrategyPick> = {
  summary?: Record<string, Stats>;
  cooldownSummary?: Record<string, Stats>;
  byBucket?: Record<string, Record<string, Stats>>;
  cooldownByBucket?: Record<string, Record<string, Stats>>;
  dailyRecords?: Array<{ tradeDate: string; picks: T[] }>;
  picks: T[];
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

type ReplayTracking = {
  refreshedAt: string;
  latestCachedDate?: string;
  status: ArchiveReplayStatus;
  candidates: number;
  availableDays: number;
  remainingDays: number;
  horizons: Record<string, {
    completed: number;
    samples: number;
    targetHits: number;
    strongTargetHits: number;
    stretchTargetHits: number;
    winRate?: number;
    strongTargetRate?: number;
    stretchTargetRate?: number;
  }>;
  strongWatch?: ReplayTracking["horizons"];
  aestheticWatch?: ReplayTracking["horizons"];
};

type StrategyReport = {
  meta: {
    generatedAt?: string;
    from?: string;
    to?: string;
    selectDate?: string;
    horizons?: Horizon[];
    targetPct?: number;
    strongTargetPct?: number;
    stretchTargetPct?: number;
    replayTracking?: ReplayTracking;
    [key: string]: unknown;
  };
  summary?: Record<string, Stats>;
  cooldownSummary?: Record<string, Stats>;
  byActionState?: Record<string, Record<string, Stats>>;
  bySetupState?: Record<string, Record<string, Stats>>;
  bySignalLayer?: Record<string, Record<string, Stats>>;
  cooldownBySignalLayer?: Record<string, Record<string, Stats>>;
  aestheticWatch?: StrategyPool;
  strongWatch?: StrategyPool;
  dailyRecords?: Array<{ tradeDate: string; picks: StrategyPick[] }>;
  picks: StrategyPick[];
  benchmark?: StrategyReport;
};

type StrategyArchiveIndexItem = {
  tradeDate: string;
  path: string;
  generatedAt?: string;
  mainSignals: number;
  strongWatchSignals?: number;
  aestheticSignals: number;
  replayStatus?: ArchiveReplayStatus;
  replayAvailableDays?: number;
  replayRemainingDays?: number;
  replayUpdatedAt?: string;
  replay5dCompleted?: number;
  replay10dCompleted?: number;
  replay5dWinRate?: number;
  replay10dWinRate?: number;
  strongWatchReplay5dWinRate?: number;
  strongWatchReplay10dWinRate?: number;
  aestheticReplay5dWinRate?: number;
  aestheticReplay10dWinRate?: number;
  [key: string]: unknown;
};

type StrategyArchiveIndex = {
  generatedAt: string;
  latestTradeDate?: string;
  items: StrategyArchiveIndexItem[];
};

type ReplayReviewEntry = {
  tradeDate: string;
  pool: "main" | "strongWatch" | "aestheticWatch";
  poolLabel: string;
  rank: number;
  instrument: string;
  name: string;
  price: number;
  score?: number;
  actionState?: StockActionState;
  setupState?: SetupState;
  bucketLabel?: string;
  flowRatio5d?: number;
  valuePosition?: number;
  pullbackFromHigh?: number;
  thirtyMinutePullbackScore?: number;
  thirtyMinuteShrinkRatio?: number;
  replay5d?: ReplayResult;
  replay10d?: ReplayResult;
  status: ArchiveReplayStatus;
};

type ReplayReviewGroup = {
  pool: string;
  label: string;
  samples: number;
  completed5d: number;
  completed10d: number;
  hit5: number;
  hit8: number;
  hit10: number;
  drawdownRisk: number;
  tracking: number;
  hit5Rate?: number;
  hit8Rate?: number;
  hit10Rate?: number;
  drawdownRiskRate?: number;
  avgMaxRunupPct?: number;
  avgCloseReturnPct?: number;
  avgMaxDrawdownPct?: number;
};

type ReplayFactorRow = ReplayReviewGroup & {
  factor: string;
  bucket: string;
};

type ReplayReviewReport = {
  meta: {
    generatedAt: string;
    source: "strategy-archive";
    historyDates: number;
    latestTradeDate?: string;
    notes: string[];
  };
  summary: ReplayReviewGroup;
  byPool: ReplayReviewGroup[];
  leaderboards: {
    hit5: ReplayReviewEntry[];
    hit8: ReplayReviewEntry[];
    hit10: ReplayReviewEntry[];
    drawdownRisk: ReplayReviewEntry[];
    tracking: ReplayReviewEntry[];
    nearTarget: ReplayReviewEntry[];
  };
  factors: ReplayFactorRow[];
};

function argValue(name: string) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function dateKey(value?: string) {
  return String(value ?? "").slice(0, 10);
}

function replayDate(report: StrategyReport) {
  return report.meta.selectDate ?? report.meta.to ?? report.meta.from;
}

function replayHorizons(report: StrategyReport): Horizon[] {
  const parsed = (report.meta.horizons ?? [5, 10]).filter((item): item is Horizon => item === 5 || item === 10);
  return parsed.length ? parsed : [5, 10];
}

function targetConfig(report: StrategyReport) {
  return {
    targetPct: Number(report.meta.targetPct ?? 5),
    strongTargetPct: Number(report.meta.strongTargetPct ?? 8),
    stretchTargetPct: Number(report.meta.stretchTargetPct ?? 10)
  };
}

function latestCachedDate(bars: KLine[]) {
  const last = bars[bars.length - 1];
  return dateKey(last?.t);
}

function replayFromDaily(args: {
  pick: Pick<StrategyPick, "price" | "tradeDate" | "instrument">;
  bars: KLine[];
  horizon: Horizon;
  targetPct: number;
  strongTargetPct: number;
  stretchTargetPct: number;
}): ReplayResult {
  const { pick, bars, horizon, targetPct, strongTargetPct, stretchTargetPct } = args;
  const entry = pick.price;
  const tradeIndex = bars.findIndex((bar) => dateKey(bar.t) === pick.tradeDate);
  const future = tradeIndex >= 0 ? bars.slice(tradeIndex + 1, tradeIndex + 1 + horizon) : [];
  const latestDate = latestCachedDate(bars) || undefined;

  if (tradeIndex < 0 || future.length < horizon) {
    return {
      horizon,
      status: "pending",
      entryPrice: entry,
      availableDays: future.length,
      remainingDays: Math.max(0, horizon - future.length),
      latestDate
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

  for (let index = 0; index < future.length; index += 1) {
    const bar = future[index];
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
    if (!firstTargetDate && runup >= targetPct) firstTargetDate = dateKey(bar.t);
    if (!firstStrongTargetDate && runup >= strongTargetPct) firstStrongTargetDate = dateKey(bar.t);
    if (!firstStretchTargetDate && runup >= stretchTargetPct) firstStretchTargetDate = dateKey(bar.t);
  }

  const close = future[future.length - 1]?.c ?? entry;
  const maxRunupPct = round(pctChange(maxHigh, entry), 2);
  return {
    horizon,
    status: "complete",
    entryPrice: entry,
    availableDays: horizon,
    remainingDays: 0,
    latestDate,
    dueDate: dateKey(future[horizon - 1]?.t),
    closeReturnPct: round(pctChange(close, entry), 2),
    maxRunupPct,
    maxRunupDate,
    maxRunupDay,
    maxDrawdownPct: round(pctChange(minLow, entry), 2),
    maxDrawdownDate,
    maxDrawdownDay,
    targetHit: maxRunupPct >= targetPct,
    strongTargetHit: maxRunupPct >= strongTargetPct,
    stretchTargetHit: maxRunupPct >= stretchTargetPct,
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
  const avg = (values: Array<number | undefined>) => {
    const finite = values.filter((value): value is number => Number.isFinite(value));
    return finite.length ? round(average(finite), 2) : undefined;
  };

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
    avgCloseReturnPct: avg(completed.map((item) => item.closeReturnPct)),
    avgMaxRunupPct: avg(completed.map((item) => item.maxRunupPct)),
    avgMaxDrawdownPct: avg(completed.map((item) => item.maxDrawdownPct)),
    avgPeakDay: avg(completed.map((item) => item.maxRunupDay))
  };
}

function summarizeByHorizon(picks: StrategyPick[], horizons: Horizon[]) {
  return Object.fromEntries(
    horizons.map((horizon) => [`${horizon}d`, summarize(picks.map((pick) => pick.replay?.[`${horizon}d`]).filter(Boolean))])
  ) as Record<string, Stats>;
}

function groupStats<T extends StrategyPick>(picks: T[], horizons: Horizon[], groups: readonly string[], key: (pick: T) => string | undefined) {
  return Object.fromEntries(
    groups.map((group) => [group, summarizeByHorizon(picks.filter((pick) => key(pick) === group), horizons)])
  ) as Record<string, Record<string, Stats>>;
}

function allPickLists(report: StrategyReport) {
  return [
    report.picks ?? [],
    report.strongWatch?.picks ?? [],
    report.aestheticWatch?.picks ?? [],
    ...(report.dailyRecords ?? []).map((day) => day.picks ?? []),
    ...(report.strongWatch?.dailyRecords ?? []).map((day) => day.picks ?? []),
    ...(report.aestheticWatch?.dailyRecords ?? []).map((day) => day.picks ?? [])
  ];
}

function candidatePriority(pick: StrategyPick) {
  if (pick.signalLayer === "main") return 0;
  if ("strongWatchScore" in pick) return 1;
  if ("bucketScore" in pick) return 2;
  return 3;
}

function uniqueCandidates(report: StrategyReport) {
  const candidates = [...(report.picks ?? []), ...(report.strongWatch?.picks ?? []), ...(report.aestheticWatch?.picks ?? [])].sort(
    (a, b) => candidatePriority(a) - candidatePriority(b) || a.rank - b.rank
  );
  const seen = new Set<string>();
  return candidates.filter((pick) => {
    if (seen.has(pick.instrument)) return false;
    seen.add(pick.instrument);
    return true;
  });
}

function replayHorizonTracking(picks: StrategyPick[], horizon: Horizon) {
  const results = picks.map((pick) => pick.replay?.[`${horizon}d`]).filter(Boolean);
  const stats = summarize(results);
  return {
    completed: stats.completed,
    samples: stats.samples,
    targetHits: stats.targetHits,
    strongTargetHits: stats.strongTargetHits,
    stretchTargetHits: stats.stretchTargetHits,
    winRate: stats.winRate,
    strongTargetRate: stats.strongTargetRate,
    stretchTargetRate: stats.stretchTargetRate
  };
}

function buildTracking(report: StrategyReport, horizons: Horizon[], refreshedAt: string): ReplayTracking {
  const candidates = uniqueCandidates(report);
  const maxHorizon = Math.max(...horizons) as Horizon;
  const maxReplay = candidates.map((pick) => pick.replay?.[`${maxHorizon}d`]).filter(Boolean);
  const availableDays = maxReplay.length ? Math.max(...maxReplay.map((item) => item.availableDays ?? (item.status === "complete" ? maxHorizon : 0))) : 0;
  const remainingDays = maxReplay.length ? Math.max(...maxReplay.map((item) => item.remainingDays ?? 0)) : maxHorizon;
  const fiveComplete = candidates.length > 0 && candidates.every((pick) => pick.replay?.["5d"]?.status === "complete");
  const tenComplete = candidates.length > 0 && candidates.every((pick) => pick.replay?.["10d"]?.status === "complete");
  const status: ArchiveReplayStatus = tenComplete ? "10d-complete" : fiveComplete ? "5d-complete" : "pending";
  const latestDates = maxReplay.map((item) => item.latestDate).filter(Boolean) as string[];

  return {
    refreshedAt,
    latestCachedDate: latestDates.sort().at(-1),
    status,
    candidates: candidates.length,
    availableDays,
    remainingDays,
    horizons: Object.fromEntries(horizons.map((horizon) => [`${horizon}d`, replayHorizonTracking(candidates, horizon)])),
    strongWatch: Object.fromEntries(horizons.map((horizon) => [`${horizon}d`, replayHorizonTracking(report.strongWatch?.picks ?? [], horizon)])),
    aestheticWatch: Object.fromEntries(horizons.map((horizon) => [`${horizon}d`, replayHorizonTracking(report.aestheticWatch?.picks ?? [], horizon)]))
  };
}

async function refreshReport(report: StrategyReport) {
  const horizons = replayHorizons(report);
  const maxHorizon = Math.max(...horizons);
  const targets = targetConfig(report);
  const dailyCache = new Map<string, KLine[]>();

  async function barsFor(instrument: string) {
    if (!dailyCache.has(instrument)) dailyCache.set(instrument, await readKLineCache("daily", instrument));
    return dailyCache.get(instrument) ?? [];
  }

  for (const pickList of allPickLists(report)) {
    for (const pick of pickList) {
      const bars = await barsFor(pick.instrument);
      pick.replay = Object.fromEntries(
        horizons.map((horizon) => [
          `${horizon}d`,
          replayFromDaily({ pick, bars, horizon, ...targets })
        ])
      );
    }
  }

  const mainPicks = report.picks ?? [];
  const cooldownMain = mainPicks.filter((pick) => !pick.cooldownDuplicate);
  report.summary = summarizeByHorizon(mainPicks, horizons);
  report.cooldownSummary = summarizeByHorizon(cooldownMain, horizons);
  report.byActionState = groupStats(mainPicks, horizons, ACTION_STATES, (pick) => pick.actionState ?? pick.state);
  report.bySetupState = groupStats(mainPicks, horizons, SETUP_STATES, (pick) => pick.setupState ?? pick.setup);
  report.bySignalLayer = groupStats(mainPicks, horizons, SIGNAL_LAYERS, (pick) => pick.signalLayer ?? pick.layer);
  report.cooldownBySignalLayer = groupStats(cooldownMain, horizons, SIGNAL_LAYERS, (pick) => pick.signalLayer ?? pick.layer);

  for (const pool of [report.aestheticWatch, report.strongWatch]) {
    if (!pool) continue;
    const poolPicks = pool.picks ?? [];
    const cooldownPicks = poolPicks.filter((pick) => !pick.cooldownDuplicate);
    pool.summary = summarizeByHorizon(poolPicks, horizons);
    pool.cooldownSummary = summarizeByHorizon(cooldownPicks, horizons);
    pool.byBucket = groupStats(poolPicks, horizons, AESTHETIC_BUCKETS, (pick) => pick.bucket);
    pool.cooldownByBucket = groupStats(cooldownPicks, horizons, AESTHETIC_BUCKETS, (pick) => pick.bucket);
  }

  const refreshedAt = new Date().toISOString();
  report.meta.replayTracking = buildTracking(report, horizons, refreshedAt);
  return report.meta.replayTracking;
}

async function readJson<T>(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeJson(path: string, data: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function updateIndexItem(item: StrategyArchiveIndexItem, report: StrategyReport) {
  const tracking = report.meta.replayTracking;
  if (!tracking) return item;
  const five = tracking.horizons["5d"];
  const ten = tracking.horizons["10d"];
  return {
    ...item,
    generatedAt: report.meta.generatedAt,
    mainSignals: report.picks?.length ?? item.mainSignals,
    strongWatchSignals: report.strongWatch?.picks?.length ?? item.strongWatchSignals ?? 0,
    aestheticSignals: report.aestheticWatch?.picks?.length ?? item.aestheticSignals,
    replayStatus: tracking.status,
    replayAvailableDays: tracking.availableDays,
    replayRemainingDays: tracking.remainingDays,
    replayUpdatedAt: tracking.refreshedAt,
    replay5dCompleted: five?.completed,
    replay10dCompleted: ten?.completed,
    replay5dWinRate: five?.winRate,
    replay10dWinRate: ten?.winRate,
    strongWatchReplay5dWinRate: tracking.strongWatch?.["5d"]?.winRate,
    strongWatchReplay10dWinRate: tracking.strongWatch?.["10d"]?.winRate,
    aestheticReplay5dWinRate: tracking.aestheticWatch?.["5d"]?.winRate,
    aestheticReplay10dWinRate: tracking.aestheticWatch?.["10d"]?.winRate
  };
}

function pickScore(pick: StrategyPick) {
  return pick.strongWatchScore ?? pick.bucketScore ?? pick.strategyScore ?? pick.score;
}

function poolLabel(pool: ReplayReviewEntry["pool"]) {
  if (pool === "main") return "主策略";
  if (pool === "strongWatch") return "强观察";
  return "审美观察";
}

function reviewStatus(pick: StrategyPick): ArchiveReplayStatus {
  if (pick.replay?.["10d"]?.status === "complete") return "10d-complete";
  if (pick.replay?.["5d"]?.status === "complete") return "5d-complete";
  return "pending";
}

function toReviewEntry(pick: StrategyPick, pool: ReplayReviewEntry["pool"]): ReplayReviewEntry {
  return {
    tradeDate: pick.tradeDate,
    pool,
    poolLabel: poolLabel(pool),
    rank: pick.rank,
    instrument: pick.instrument,
    name: pick.name,
    price: pick.price,
    score: pickScore(pick),
    actionState: pick.actionState ?? pick.state,
    setupState: pick.setupState ?? pick.setup,
    bucketLabel: pick.bucketLabel,
    flowRatio5d: pick.flowRatio5d,
    valuePosition: pick.valuePosition,
    pullbackFromHigh: pick.pullbackFromHigh,
    thirtyMinutePullbackScore: pick.thirtyMinutePullbackScore,
    thirtyMinuteShrinkRatio: pick.thirtyMinuteShrinkRatio,
    replay5d: pick.replay?.["5d"],
    replay10d: pick.replay?.["10d"],
    status: reviewStatus(pick)
  };
}

function uniqueReviewEntries(report: StrategyReport) {
  const entries = [
    ...(report.picks ?? []).map((pick) => toReviewEntry(pick, "main" as const)),
    ...(report.strongWatch?.picks ?? []).map((pick) => toReviewEntry(pick, "strongWatch" as const)),
    ...(report.aestheticWatch?.picks ?? []).map((pick) => toReviewEntry(pick, "aestheticWatch" as const))
  ];
  const priority: Record<ReplayReviewEntry["pool"], number> = { main: 0, strongWatch: 1, aestheticWatch: 2 };
  const seen = new Set<string>();
  return entries
    .sort((a, b) => priority[a.pool] - priority[b.pool] || a.rank - b.rank)
    .filter((entry) => {
      const key = `${entry.tradeDate}-${entry.instrument}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function percent(count: number, total: number) {
  return total > 0 ? round((count / total) * 100, 1) : undefined;
}

function avgDefined(values: Array<number | undefined>) {
  const finite = values.filter((value): value is number => Number.isFinite(value));
  return finite.length ? round(average(finite), 2) : undefined;
}

function reviewGroup(pool: string, label: string, entries: ReplayReviewEntry[]): ReplayReviewGroup {
  const replay10 = entries.map((entry) => entry.replay10d).filter((replay): replay is ReplayResult => Boolean(replay));
  const completed10 = replay10.filter((replay) => replay.status === "complete");
  const completed5 = entries.map((entry) => entry.replay5d).filter((replay): replay is ReplayResult => Boolean(replay && replay.status === "complete"));
  const hit5 = completed10.filter((replay) => replay.targetHit).length;
  const hit8 = completed10.filter((replay) => replay.strongTargetHit).length;
  const hit10 = completed10.filter((replay) => replay.stretchTargetHit).length;
  const drawdownRisk = completed10.filter((replay) => (replay.maxDrawdownPct ?? 0) <= -5).length;

  return {
    pool,
    label,
    samples: entries.length,
    completed5d: completed5.length,
    completed10d: completed10.length,
    hit5,
    hit8,
    hit10,
    drawdownRisk,
    tracking: entries.filter((entry) => entry.status !== "10d-complete").length,
    hit5Rate: percent(hit5, completed10.length),
    hit8Rate: percent(hit8, completed10.length),
    hit10Rate: percent(hit10, completed10.length),
    drawdownRiskRate: percent(drawdownRisk, completed10.length),
    avgMaxRunupPct: avgDefined(completed10.map((replay) => replay.maxRunupPct)),
    avgCloseReturnPct: avgDefined(completed10.map((replay) => replay.closeReturnPct)),
    avgMaxDrawdownPct: avgDefined(completed10.map((replay) => replay.maxDrawdownPct))
  };
}

function bucketLabel(value: number | undefined, buckets: Array<{ label: string; min: number; max: number }>) {
  if (!Number.isFinite(value)) return "缺失";
  return buckets.find((bucket) => value! >= bucket.min && value! < bucket.max)?.label ?? "其他";
}

function factorRows(entries: ReplayReviewEntry[]): ReplayFactorRow[] {
  const factors = [
    {
      factor: "30m缩量比",
      value: (entry: ReplayReviewEntry) => entry.thirtyMinuteShrinkRatio,
      buckets: [
        { label: "<=0.70", min: -Infinity, max: 0.7 },
        { label: "0.70-0.95", min: 0.7, max: 0.95 },
        { label: "0.95-1.10", min: 0.95, max: 1.1 },
        { label: ">1.10", min: 1.1, max: Infinity }
      ]
    },
    {
      factor: "回撤",
      value: (entry: ReplayReviewEntry) => entry.pullbackFromHigh,
      buckets: [
        { label: "<8%", min: -Infinity, max: 8 },
        { label: "8%-12%", min: 8, max: 12 },
        { label: "12%-18%", min: 12, max: 18 },
        { label: "18%-24%", min: 18, max: 24 },
        { label: ">24%", min: 24, max: Infinity }
      ]
    },
    {
      factor: "5日资金",
      value: (entry: ReplayReviewEntry) => entry.flowRatio5d,
      buckets: [
        { label: "<1.5%", min: -Infinity, max: 1.5 },
        { label: "1.5%-3%", min: 1.5, max: 3 },
        { label: "3%-6%", min: 3, max: 6 },
        { label: "6%-12%", min: 6, max: 12 },
        { label: ">12%", min: 12, max: Infinity }
      ]
    }
  ];

  return factors.flatMap((factor) => {
    const groups = new Map<string, ReplayReviewEntry[]>();
    for (const entry of entries) {
      const label = bucketLabel(factor.value(entry), factor.buckets);
      groups.set(label, [...(groups.get(label) ?? []), entry]);
    }
    return [...groups.entries()]
      .map(([bucket, grouped]) => ({ ...reviewGroup("factor", bucket, grouped), factor: factor.factor, bucket }))
      .filter((row) => row.samples > 0);
  });
}

function buildReviewReport(reports: StrategyReport[], items: StrategyArchiveIndexItem[]): ReplayReviewReport {
  const allEntries = reports.flatMap(uniqueReviewEntries).sort((a, b) => b.tradeDate.localeCompare(a.tradeDate) || a.rank - b.rank);
  const completed = allEntries.filter((entry) => entry.replay10d?.status === "complete");
  const byPool = (["main", "strongWatch", "aestheticWatch"] as const).map((pool) =>
    reviewGroup(pool, poolLabel(pool), allEntries.filter((entry) => entry.pool === pool))
  );
  const top = (entries: ReplayReviewEntry[], sorter: (a: ReplayReviewEntry, b: ReplayReviewEntry) => number) => [...entries].sort(sorter).slice(0, 12);

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      source: "strategy-archive",
      historyDates: reports.length,
      latestTradeDate: items[0]?.tradeDate,
      notes: [
        "Replay review is generated from strategy archive reports after replay refresh.",
        "Leaderboards use one highest-priority entry per stock per trade date: main, then strong watch, then aesthetic watch.",
        "Hit leaderboards use the 10d replay window when complete; tracking list shows pending candidates first."
      ]
    },
    summary: reviewGroup("all", "全部候选", allEntries),
    byPool,
    leaderboards: {
      hit5: top(completed.filter((entry) => entry.replay10d?.targetHit), (a, b) => (b.replay10d?.maxRunupPct ?? -Infinity) - (a.replay10d?.maxRunupPct ?? -Infinity)),
      hit8: top(completed.filter((entry) => entry.replay10d?.strongTargetHit), (a, b) => (b.replay10d?.maxRunupPct ?? -Infinity) - (a.replay10d?.maxRunupPct ?? -Infinity)),
      hit10: top(completed.filter((entry) => entry.replay10d?.stretchTargetHit), (a, b) => (b.replay10d?.maxRunupPct ?? -Infinity) - (a.replay10d?.maxRunupPct ?? -Infinity)),
      drawdownRisk: top(completed.filter((entry) => (entry.replay10d?.maxDrawdownPct ?? 0) <= -5), (a, b) => (a.replay10d?.maxDrawdownPct ?? 0) - (b.replay10d?.maxDrawdownPct ?? 0)),
      tracking: top(allEntries.filter((entry) => entry.status !== "10d-complete"), (a, b) => b.tradeDate.localeCompare(a.tradeDate) || (b.score ?? 0) - (a.score ?? 0)),
      nearTarget: top(allEntries.filter((entry) => (entry.replay10d?.maxRunupPct ?? entry.replay5d?.maxRunupPct ?? 0) >= 3), (a, b) => (b.replay10d?.maxRunupPct ?? b.replay5d?.maxRunupPct ?? 0) - (a.replay10d?.maxRunupPct ?? a.replay5d?.maxRunupPct ?? 0))
    },
    factors: factorRows(allEntries)
  };
}

async function run() {
  const reportsDir = resolve(root, process.env.REPORT_DIR ?? "public/reports");
  const outputDir = resolve(root, process.env.STRATEGY_BACKTEST_DIR ?? resolve(reportsDir, "backtests"));
  const historyDir = resolve(outputDir, "history");
  const onlyDate = argValue("date");
  if (!existsSync(historyDir)) {
    console.log(`[strategy:refresh-replay] skip missing history dir ${historyDir}`);
    return;
  }

  const indexPath = resolve(historyDir, "index.json");
  const index = existsSync(indexPath) ? await readJson<StrategyArchiveIndex>(indexPath) : { generatedAt: new Date().toISOString(), items: [] };
  const files = (await readdir(historyDir))
    .filter((file) => file.endsWith(".json") && file !== "index.json" && !file.startsWith("."))
    .filter((file) => !onlyDate || file === `${onlyDate}.json`)
    .sort();

  const byDate = new Map(index.items.map((item) => [item.tradeDate, item]));
  let updated = 0;
  for (const file of files) {
    const path = resolve(historyDir, file);
    const report = await readJson<StrategyReport>(path);
    const tradeDate = replayDate(report) ?? file.replace(/\.json$/, "");
    const tracking = await refreshReport(report);
    await writeJson(path, report);

    const existing = byDate.get(tradeDate) ?? {
      tradeDate,
      path: `reports/backtests/history/${tradeDate}.json`,
      mainSignals: report.picks?.length ?? 0,
      aestheticSignals: report.aestheticWatch?.picks?.length ?? 0
    };
    byDate.set(tradeDate, updateIndexItem(existing, report));
    updated += 1;
    console.log(
      `[strategy:refresh-replay] ${tradeDate} status=${tracking.status} candidates=${tracking.candidates} available=${tracking.availableDays} remaining=${tracking.remainingDays}`
    );
  }

  const items = [...byDate.values()].sort((a, b) => b.tradeDate.localeCompare(a.tradeDate)).slice(0, 120);
  await writeJson(indexPath, {
    generatedAt: new Date().toISOString(),
    latestTradeDate: items[0]?.tradeDate,
    items
  } satisfies StrategyArchiveIndex);

  const reviewReports = await Promise.all(
    (await readdir(historyDir))
      .filter((file) => file.endsWith(".json") && file !== "index.json" && !file.startsWith("."))
      .sort()
      .map((file) => readJson<StrategyReport>(resolve(historyDir, file)))
  );
  await writeJson(resolve(outputDir, "replay-review.json"), buildReviewReport(reviewReports, items));
  console.log(`[strategy:refresh-replay] refreshed ${updated} archive reports`);
}

await run();
