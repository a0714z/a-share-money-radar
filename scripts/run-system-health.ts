import dotenv from "dotenv";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

dotenv.config({ path: resolve(root, ".env.local"), override: false, quiet: true });
dotenv.config({ path: resolve(root, ".env"), override: false, quiet: true });

const reportsDir = resolve(root, process.env.REPORT_DIR ?? "public/reports");
const outputPath = resolve(root, process.env.SYSTEM_HEALTH_REPORT_PATH ?? resolve(reportsDir, "system-health.json"));

type HealthTone = "ok" | "warn" | "risk";

type StrategyArchiveIndexItem = {
  tradeDate: string;
  path: string;
  generatedAt?: string;
  mainSignals?: number;
  strongWatchSignals?: number;
  aestheticSignals?: number;
  replayStatus?: "pending" | "5d-complete" | "10d-complete";
  replayAvailableDays?: number;
  replayRemainingDays?: number;
  replayUpdatedAt?: string;
};

type StrategyArchiveIndex = {
  generatedAt?: string;
  latestTradeDate?: string;
  items?: StrategyArchiveIndexItem[];
};

type StrategyReplayTracking = {
  refreshedAt?: string;
  status?: StrategyArchiveIndexItem["replayStatus"];
  candidates?: number;
  availableDays?: number;
  remainingDays?: number;
};

type StrategyReport = {
  meta?: {
    generatedAt?: string;
    tradeDate?: string;
    selectDate?: string;
    from?: string;
    to?: string;
    evaluatedDates?: number;
    replayTracking?: StrategyReplayTracking;
  };
  picks?: unknown[];
  strongWatch?: { picks?: unknown[]; cooldownSummary?: Record<string, { winRate?: number }> };
  aestheticWatch?: { picks?: unknown[]; cooldownSummary?: Record<string, { winRate?: number }> };
  cooldownSummary?: Record<string, { winRate?: number }>;
  benchmark?: StrategyReport;
};

type ReplayReviewReport = {
  meta?: {
    generatedAt?: string;
    historyDates?: number;
    latestTradeDate?: string;
  };
  summary?: {
    samples?: number;
    tracking?: number;
    completed5d?: number;
    completed10d?: number;
  };
};

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

async function readJson<T>(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function countJsonFiles(path: string) {
  if (!existsSync(path)) return 0;
  const files = await readdir(path);
  return files.filter((file) => file.endsWith(".json")).length;
}

function tone(ok: boolean, warn: boolean) {
  if (ok) return "ok";
  if (warn) return "warn";
  return "risk";
}

function worstTone(...tones: Array<HealthTone | undefined>): HealthTone {
  if (tones.includes("risk")) return "risk";
  if (tones.includes("warn")) return "warn";
  return "ok";
}

function count(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function listCount(value: unknown) {
  return Array.isArray(value) ? value.length : 0;
}

function resolveArchivePath(path?: string, tradeDate?: string) {
  if (path) {
    if (path.startsWith("/")) return path;
    if (path.startsWith("reports/")) return resolve(reportsDir, path.replace(/^reports\//, ""));
    if (path.startsWith("backtests/")) return resolve(reportsDir, path);
    return resolve(root, path);
  }
  if (tradeDate) return resolve(reportsDir, "backtests", "history", `${tradeDate}.json`);
  return undefined;
}

function pipelineNotes(args: {
  latestTradeDate?: string;
  planTradeDate?: string;
  strategyTradeDate?: string;
  archiveLatestDate?: string;
  replayReviewLatestDate?: string;
}) {
  const notes: string[] = [];
  if (!args.latestTradeDate) notes.push("缺少 latest 交易日");
  if (!args.planTradeDate) notes.push("缺少 plan 交易日");
  if (args.latestTradeDate && args.planTradeDate && args.planTradeDate !== args.latestTradeDate) {
    notes.push(`plan 停留在 ${args.planTradeDate}`);
  }
  if (!args.strategyTradeDate) notes.push("缺少策略实验交易日");
  if (args.latestTradeDate && args.strategyTradeDate && args.strategyTradeDate !== args.latestTradeDate) {
    notes.push(`策略实验停留在 ${args.strategyTradeDate}`);
  }
  if (!args.archiveLatestDate) notes.push("缺少策略归档索引");
  if (args.strategyTradeDate && args.archiveLatestDate && args.archiveLatestDate !== args.strategyTradeDate) {
    notes.push(`策略归档停留在 ${args.archiveLatestDate}`);
  }
  if (!args.replayReviewLatestDate) notes.push("缺少策略复盘榜单");
  if (args.archiveLatestDate && args.replayReviewLatestDate && args.replayReviewLatestDate !== args.archiveLatestDate) {
    notes.push(`复盘榜单停留在 ${args.replayReviewLatestDate}`);
  }
  return notes;
}

async function run() {
  const klineCacheDir = resolve(root, process.env.KLINE_CACHE_DIR ?? ".cache/kline");
  const apiCacheDir = resolve(root, process.env.API_CACHE_DIR ?? ".cache/biying");
  const latest = await readJson<any>(resolve(reportsDir, "latest.json")).catch(() => undefined);
  const plan = await readJson<any>(resolve(reportsDir, "plan.json")).catch(() => undefined);
  const review = await readJson<any>(resolve(reportsDir, "performance.json")).catch(() => undefined);
  const strategy = await readJson<StrategyReport>(resolve(reportsDir, "backtests/latest.json")).catch(() => undefined);
  const archiveIndex = await readJson<StrategyArchiveIndex>(resolve(reportsDir, "backtests/history/index.json")).catch(() => undefined);
  const replayReview = await readJson<ReplayReviewReport>(resolve(reportsDir, "backtests/replay-review.json")).catch(() => undefined);
  const klineSummary = await readJson<any>(resolve(reportsDir, "kline-cache.json")).catch(() => undefined);
  const intraday = await readJson<any>(resolve(reportsDir, "intraday.json")).catch(() => undefined);

  const archiveItems = archiveIndex?.items ?? [];
  const latestArchiveItem = archiveItems[0];
  const archiveLatestDate = archiveIndex?.latestTradeDate ?? latestArchiveItem?.tradeDate;
  const latestArchivePath = resolveArchivePath(latestArchiveItem?.path, archiveLatestDate);
  const latestArchive = latestArchivePath ? await readJson<StrategyReport>(latestArchivePath).catch(() => undefined) : undefined;

  const dailyFiles = await countJsonFiles(resolve(klineCacheDir, "daily"));
  const minuteFiles = await countJsonFiles(resolve(klineCacheDir, "30m"));
  const indexFiles = await countJsonFiles(resolve(klineCacheDir, "index-daily"));
  const flowFiles = await countJsonFiles(resolve(apiCacheDir, "money-flow"));
  const profileFiles = await countJsonFiles(resolve(apiCacheDir, "profile"));
  const universe = Number(klineSummary?.universe ?? latest?.universe?.mainBoardNonSt ?? 0);
  const dailyOk = dailyFiles >= Math.max(1, Math.floor(universe * 0.95));
  const minuteOk = minuteFiles >= Math.max(1, Math.floor(universe * 0.95));
  const flowWarn = flowFiles >= Math.min(200, Math.max(1, Math.floor(universe * 0.05)));
  const latestTradeDate = latest?.meta?.tradeDate ?? plan?.meta?.tradeDate;
  const planTradeDate = plan?.meta?.tradeDate;
  const strategyTradeDate = strategy?.meta?.tradeDate ?? strategy?.meta?.selectDate ?? strategy?.meta?.to ?? strategy?.meta?.from;
  const strategyBenchmark = strategy?.benchmark ?? strategy;
  const reportOk = Boolean(latest?.meta?.generatedAt && plan?.meta?.generatedAt && review?.meta?.generatedAt);
  const strategyOk = Boolean(strategy?.meta?.generatedAt && latestTradeDate && strategyTradeDate === latestTradeDate);
  const strategyWarn = Boolean(strategy?.meta?.generatedAt);
  const mainSignals = listCount(strategy?.picks);
  const strongWatchSignals = listCount(strategy?.strongWatch?.picks);
  const aestheticSignals = listCount(strategy?.aestheticWatch?.picks);
  const archiveSynced = Boolean(archiveLatestDate && strategyTradeDate && archiveLatestDate === strategyTradeDate);
  const latestArchiveHasTracking = Boolean(latestArchive?.meta?.replayTracking);
  const replayReviewLatestDate = replayReview?.meta?.latestTradeDate;
  const latestTracking = latestArchive?.meta?.replayTracking;
  const replayReviewSamples = count(replayReview?.summary?.samples);
  const replayTracking = count(replayReview?.summary?.tracking);
  const replayCandidateBaseline = count(latestTracking?.candidates ?? replayReview?.summary?.samples);
  const replayReviewOk = Boolean(
    replayReview?.meta?.generatedAt &&
      (!archiveLatestDate || replayReviewLatestDate === archiveLatestDate) &&
      (replayCandidateBaseline === 0 || replayReviewSamples >= replayCandidateBaseline)
  );
  const strategySignalWarn = Boolean(strategy?.meta?.generatedAt && strongWatchSignals + aestheticSignals === 0);
  const strategyDataNotes: string[] = [];
  if (!archiveIndex) strategyDataNotes.push("缺少 backtests/history/index.json");
  if (archiveIndex && !latestArchive) strategyDataNotes.push("最新策略归档文件不可读");
  if (!archiveSynced) strategyDataNotes.push(`归档日期未同步：${archiveLatestDate ?? "缺失"} / 策略 ${strategyTradeDate ?? "缺失"}`);
  if (!latestArchiveHasTracking) strategyDataNotes.push("最新归档缺少 replayTracking 后验追踪");
  if (!replayReview) strategyDataNotes.push("缺少 replay-review.json");
  if (replayReview && !replayReviewOk) strategyDataNotes.push(`复盘榜单未同步：${replayReviewLatestDate ?? "缺失"} / 归档 ${archiveLatestDate ?? "缺失"}`);
  if (strategySignalWarn) strategyDataNotes.push("强观察和审美池同为 0，需确认策略是否过窄");
  if (!strategyDataNotes.length) strategyDataNotes.push("策略归档、后验追踪和复盘榜单已同步");
  const strategyDataTone = strategyOk && archiveSynced && latestArchiveHasTracking && replayReviewOk && !strategySignalWarn
    ? "ok"
    : !archiveIndex || !latestArchive || !replayReview
      ? "risk"
      : "warn";
  const dailyPipelineNotes = pipelineNotes({
    latestTradeDate,
    planTradeDate,
    strategyTradeDate,
    archiveLatestDate,
    replayReviewLatestDate
  });
  const dailyPipelineTone = dailyPipelineNotes.length ? (latestTradeDate && strategyTradeDate ? "warn" : "risk") : "ok";
  const reportsTone = tone(reportOk, Boolean(latest || plan || review));
  const strategyTone = tone(strategyOk, strategyWarn);
  const klineTone = tone(dailyOk && minuteOk, dailyFiles > 0 && minuteFiles > 0);
  const notes = [
    "页面只读取 reports 静态 JSON，不直接调用必盈 API。",
    "普通扫描脚本默认只读本地 API 缓存；只有 API_CACHE_REFRESH=1 时刷新资金流和公司资料。",
    "服务器收盘任务应在交易日 18:00 执行 daily:close。",
    "策略健康会同时检查 latest、策略归档、后验追踪和 replay-review 是否同步。"
  ];

  const report = {
    generatedAt: chinaDateTime(),
    tradeDate: latestTradeDate,
    status: worstTone(reportsTone, strategyTone, klineTone, strategyDataTone, dailyPipelineTone),
    schedule: {
      closeRun: "交易日 18:00",
      mailNotify: "交易日 09:00"
    },
    reports: {
      tone: reportsTone,
      latestGeneratedAt: latest?.meta?.generatedAt,
      planGeneratedAt: plan?.meta?.generatedAt,
      reviewGeneratedAt: review?.meta?.generatedAt,
      latestPicks: latest?.picks?.length ?? 0,
      latestWatchlist: latest?.watchlist?.length ?? 0,
      planCount: plan?.plans?.length ?? 0,
      reviewSignals: review?.summary?.totalSignals ?? 0
    },
    strategyBacktest: {
      tone: strategyTone,
      generatedAt: strategy?.meta?.generatedAt,
      tradeDate: strategyTradeDate,
      expectedTradeDate: latestTradeDate,
      mainSignals,
      strongWatchSignals,
      aestheticSignals,
      cooldown10dWinRate: strategyBenchmark?.cooldownSummary?.["10d"]?.winRate,
      strongWatch10dWinRate: strategyBenchmark?.strongWatch?.cooldownSummary?.["10d"]?.winRate,
      aesthetic10dWinRate: strategyBenchmark?.aestheticWatch?.cooldownSummary?.["10d"]?.winRate,
      benchmarkFrom: strategyBenchmark?.meta?.from,
      benchmarkTo: strategyBenchmark?.meta?.to,
      benchmarkDates: strategyBenchmark?.meta?.evaluatedDates
    },
    strategyDataQuality: {
      tone: strategyDataTone,
      archiveLatestDate,
      archiveItems: archiveItems.length,
      archiveSynced,
      replayReviewGeneratedAt: replayReview?.meta?.generatedAt,
      replayReviewLatestDate,
      replayReviewHistoryDates: count(replayReview?.meta?.historyDates),
      replayReviewSamples,
      replayTracking,
      latestReplayStatus: latestTracking?.status ?? latestArchiveItem?.replayStatus,
      latestReplayAvailableDays: count(latestTracking?.availableDays ?? latestArchiveItem?.replayAvailableDays),
      latestReplayRemainingDays: count(latestTracking?.remainingDays ?? latestArchiveItem?.replayRemainingDays),
      latestReplayUpdatedAt: latestTracking?.refreshedAt ?? latestArchiveItem?.replayUpdatedAt,
      latestArchiveHasTracking,
      notes: strategyDataNotes
    },
    dailyPipeline: {
      tone: dailyPipelineTone,
      latestTradeDate,
      planTradeDate,
      strategyTradeDate,
      archiveLatestDate,
      replayReviewLatestDate,
      notes: dailyPipelineNotes.length ? dailyPipelineNotes : ["daily:close 产物日期已同步"]
    },
    klineCache: {
      tone: klineTone,
      generatedAt: klineSummary?.generatedAt,
      universe,
      dailyFiles,
      minute30Files: minuteFiles,
      indexFiles,
      dailyBars: klineSummary?.daily?.bars ?? 0,
      minute30Bars: klineSummary?.intraday30m?.bars ?? 0
    },
    apiCache: {
      tone: tone(flowWarn && profileFiles > 0, flowFiles > 0 || profileFiles > 0),
      moneyFlowFiles: flowFiles,
      profileFiles,
      refreshEnabledOnlyWhen: "API_CACHE_REFRESH=1"
    },
    intraday: {
      status: intraday?.meta?.status,
      generatedAt: intraday?.meta?.generatedAt,
      hot: intraday?.hot?.length ?? 0,
      watch: intraday?.watch?.length ?? 0,
      risk: intraday?.risk?.length ?? 0
    },
    notes
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`[health] wrote ${outputPath}`);
}

await run();
