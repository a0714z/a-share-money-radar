import dotenv from "dotenv";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readKLineCache } from "./kline-cache";
import { pctChange, round } from "../src/lib/math";
import type { KLine, ReviewHorizon, ReviewRecord, ReviewReport, ScanReport, StockPick, StrategyHealth } from "../src/lib/types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const horizons: Array<{ key: ReviewHorizon; days: number }> = [
  { key: "1d", days: 1 },
  { key: "3d", days: 3 },
  { key: "5d", days: 5 },
  { key: "10d", days: 10 }
];

dotenv.config({ path: resolve(root, ".env.local"), override: false });
dotenv.config({ path: resolve(root, ".env"), override: false });

const reportsDir = resolve(root, process.env.REPORT_DIR ?? "public/reports");
const historyDir = resolve(root, process.env.SCAN_HISTORY_DIR ?? resolve(reportsDir, "history"));
const latestPath = resolve(root, process.env.SCAN_REPORT_PATH ?? resolve(reportsDir, "latest.json"));
const outputPath = resolve(root, process.env.REVIEW_REPORT_PATH ?? resolve(reportsDir, "performance.json"));

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

async function mapLimit<T, R>(items: T[], limit: number, mapper: (item: T, index: number) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function byDateAsc<T extends { t: string }>(items: T[]) {
  return [...items].sort((a, b) => a.t.localeCompare(b.t));
}

async function readJson<T>(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function readReports() {
  const reports: ScanReport[] = [];

  if (existsSync(historyDir)) {
    const files = (await readdir(historyDir)).filter((file) => file.endsWith(".json")).sort();
    for (const file of files) reports.push(await readJson<ScanReport>(resolve(historyDir, file)));
  }

  if (!reports.length && existsSync(latestPath)) {
    reports.push(await readJson<ScanReport>(latestPath));
  }

  return reports.filter((report) => report.picks?.length);
}

function median(values: number[]) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function buildRecord(report: ScanReport, pick: StockPick, history: KLine[]): ReviewRecord {
  const bars = byDateAsc(history).filter((bar) => Number.isFinite(bar.c) && bar.c > 0);
  const signalDate = report.meta.tradeDate;
  const signalIndex = bars.findIndex((bar) => bar.t.slice(0, 10) >= signalDate);
  const signalPrice = pick.price;
  const result: ReviewRecord = {
    signalDate,
    code: pick.code,
    instrument: pick.instrument,
    name: pick.name,
    rank: pick.rank,
    score: pick.score,
    signalPrice,
    flowRatio5d: pick.flowRatio5d,
    valuePosition: pick.valuePosition,
    pullbackFromHigh: pick.pullbackFromHigh,
    horizons: {
      "1d": { days: 1, status: "pending" },
      "3d": { days: 3, status: "pending" },
      "5d": { days: 5, status: "pending" },
      "10d": { days: 10, status: "pending" }
    },
    status: "tracking"
  };

  if (signalIndex < 0) return result;

  for (const horizon of horizons) {
    const target = bars[signalIndex + horizon.days];
    if (!target) continue;
    result.horizons[horizon.key] = {
      days: horizon.days,
      status: "complete",
      date: target.t.slice(0, 10),
      close: round(target.c, 2),
      returnPct: round(pctChange(target.c, signalPrice), 2)
    };
  }

  const next3 = bars.slice(signalIndex + 1, signalIndex + 4);
  const next10 = bars.slice(signalIndex + 1, signalIndex + 11);
  if (next3.length) {
    const minLow = Math.min(...next3.map((bar) => bar.l));
    result.bestEntryDrawdown3d = round(pctChange(minLow, signalPrice), 2);
  }
  if (next10.length) {
    const minLow = Math.min(...next10.map((bar) => bar.l));
    const maxHigh = Math.max(...next10.map((bar) => bar.h));
    result.maxDrawdown10d = round(pctChange(minLow, signalPrice), 2);
    result.maxRunup10d = round(pctChange(maxHigh, signalPrice), 2);
  }
  if (pick.tradePlan && next10.length) {
    const replay: NonNullable<ReviewRecord["planReplay"]> = {
      entryTouched: next10.some((bar) => bar.l <= pick.tradePlan!.entryHigh && bar.h >= pick.tradePlan!.entryLow),
      stopLossTouched: next10.some((bar) => bar.l <= pick.tradePlan!.stopLoss),
      target1Touched: next10.some((bar) => bar.h >= pick.tradePlan!.target1),
      target2Touched: next10.some((bar) => bar.h >= pick.tradePlan!.target2)
    };

    for (const bar of next10) {
      if (bar.l <= pick.tradePlan.stopLoss) {
        replay.firstTrigger = "stopLoss";
      } else if (bar.l <= pick.tradePlan.entryHigh && bar.h >= pick.tradePlan.entryLow) {
        replay.firstTrigger = "entry";
      } else if (bar.h >= pick.tradePlan.target2) {
        replay.firstTrigger = "target2";
      } else if (bar.h >= pick.tradePlan.target1) {
        replay.firstTrigger = "target1";
      }
      if (replay.firstTrigger) {
        replay.firstTriggerDate = bar.t.slice(0, 10);
        break;
      }
    }

    result.planReplay = replay;
  }
  if (result.horizons["10d"].status === "complete") result.status = "complete";

  return result;
}

function summarize(records: ReviewRecord[]): ReviewReport["summary"] {
  const summary: ReviewReport["summary"] = {
    totalSignals: records.length,
    completed10d: records.filter((record) => record.horizons["10d"].status === "complete").length,
    tracking: records.filter((record) => record.horizons["10d"].status !== "complete").length,
    horizons: {
      "1d": { completed: 0 },
      "3d": { completed: 0 },
      "5d": { completed: 0 },
      "10d": { completed: 0 }
    }
  };

  for (const horizon of horizons) {
    const returns = records
      .map((record) => record.horizons[horizon.key].returnPct)
      .filter((value): value is number => Number.isFinite(value));
    summary.horizons[horizon.key] = {
      completed: returns.length,
      winRate: returns.length ? round((returns.filter((value) => value > 0).length / returns.length) * 100, 1) : undefined,
      avgReturn: returns.length ? round(returns.reduce((total, value) => total + value, 0) / returns.length, 2) : undefined,
      medianReturn: returns.length ? round(median(returns) ?? 0, 2) : undefined
    };
  }

  const drawdowns = records.map((record) => record.maxDrawdown10d).filter((value): value is number => Number.isFinite(value));
  const entryDrawdowns = records.map((record) => record.bestEntryDrawdown3d).filter((value): value is number => Number.isFinite(value));
  if (drawdowns.length) summary.avgMaxDrawdown10d = round(drawdowns.reduce((total, value) => total + value, 0) / drawdowns.length, 2);
  if (entryDrawdowns.length) {
    summary.avgBestEntryDrawdown3d = round(entryDrawdowns.reduce((total, value) => total + value, 0) / entryDrawdowns.length, 2);
  }

  const planRecords = records.filter((record) => record.planReplay);
  if (planRecords.length) {
    const entryTouches = planRecords.filter((record) => record.planReplay?.entryTouched).length;
    const stopLossHits = planRecords.filter((record) => record.planReplay?.stopLossTouched).length;
    const target1Hits = planRecords.filter((record) => record.planReplay?.target1Touched).length;
    const target2Hits = planRecords.filter((record) => record.planReplay?.target2Touched).length;
    summary.planReplay = {
      completed: planRecords.length,
      entryTouches,
      stopLossHits,
      target1Hits,
      target2Hits,
      entryTouchRate: round((entryTouches / planRecords.length) * 100, 1),
      stopLossRate: round((stopLossHits / planRecords.length) * 100, 1),
      target1HitRate: round((target1Hits / planRecords.length) * 100, 1),
      target2HitRate: round((target2Hits / planRecords.length) * 100, 1)
    };
  }
  summary.health = buildStrategyHealth(records, summary);

  return summary;
}

function buildStrategyHealth(records: ReviewRecord[], summary: ReviewReport["summary"]): StrategyHealth {
  const sampleWindow = 20;
  const recent = records
    .filter((record) => record.horizons["5d"].status === "complete" || record.planReplay)
    .sort((a, b) => `${b.signalDate}-${b.rank}`.localeCompare(`${a.signalDate}-${a.rank}`))
    .slice(0, sampleWindow);
  const returns5d = recent.map((record) => record.horizons["5d"].returnPct).filter((value): value is number => Number.isFinite(value));
  const drawdowns = recent.map((record) => record.maxDrawdown10d).filter((value): value is number => Number.isFinite(value));
  const planRecords = recent.filter((record) => record.planReplay);
  const target1HitRate = planRecords.length ? round((planRecords.filter((record) => record.planReplay?.target1Touched).length / planRecords.length) * 100, 1) : undefined;
  const stopLossRate = planRecords.length ? round((planRecords.filter((record) => record.planReplay?.stopLossTouched).length / planRecords.length) * 100, 1) : undefined;
  const avgReturn5d = returns5d.length ? round(returns5d.reduce((total, value) => total + value, 0) / returns5d.length, 2) : undefined;
  const winRate5d = returns5d.length ? round((returns5d.filter((value) => value > 0).length / returns5d.length) * 100, 1) : undefined;
  const avgMaxDrawdown10d = drawdowns.length ? round(drawdowns.reduce((total, value) => total + value, 0) / drawdowns.length, 2) : summary.avgMaxDrawdown10d;

  let score = 50;
  if (avgReturn5d !== undefined) score += Math.max(-24, Math.min(24, avgReturn5d * 4));
  if (winRate5d !== undefined) score += (winRate5d - 50) * 0.4;
  if (target1HitRate !== undefined) score += (target1HitRate - 25) * 0.22;
  if (stopLossRate !== undefined) score -= stopLossRate * 0.28;
  if (avgMaxDrawdown10d !== undefined) score += Math.max(-18, Math.min(8, avgMaxDrawdown10d * 2));
  if (returns5d.length < 5) score -= 10;
  score = round(Math.max(0, Math.min(100, score)), 1);

  const status: StrategyHealth["status"] = score >= 66 ? "good" : score >= 45 ? "watch" : "tighten";
  const label = status === "good" ? "良好" : status === "watch" ? "观察" : "收缩";
  const action: StrategyHealth["action"] = status === "good" ? "normal" : status === "watch" ? "light" : "pause";
  const sampleText = returns5d.length ? `近 ${returns5d.length} 个5日完成样本` : "5日完成样本不足";
  const returnText = avgReturn5d !== undefined ? `平均收益 ${avgReturn5d > 0 ? "+" : ""}${avgReturn5d}%` : "平均收益追踪中";
  const drawdownText = avgMaxDrawdown10d !== undefined ? `平均回撤 ${avgMaxDrawdown10d}%` : "回撤追踪中";
  const headline =
    status === "good"
      ? `${sampleText}，${returnText}，系统状态良好，可按计划执行。`
      : status === "watch"
        ? `${sampleText}，${returnText}，${drawdownText}，建议轻仓观察。`
        : `${sampleText}，${returnText}，${drawdownText}，建议收缩仓位并等待复盘改善。`;

  return {
    status,
    label,
    score,
    sampleSize: recent.length,
    sampleWindow,
    action,
    headline,
    metrics: {
      avgReturn5d,
      winRate5d,
      avgMaxDrawdown10d,
      target1HitRate,
      stopLossRate,
      completed5d: returns5d.length,
      completedPlan: planRecords.length
    },
    notes: [
      "健康度基于最近核心强关注信号，不包含观察池。",
      "样本不足时自动降低健康分，避免过度相信短期结果。",
      "目标和止损命中率按交易计划后续10个交易日估算。"
    ]
  };
}

async function writeReview(report: ReviewReport) {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`[review] wrote ${outputPath}`);
}

async function sampleReview() {
  const reports = await readReports();
  const records = reports.flatMap((report) =>
    report.picks.map((pick) => ({
      signalDate: report.meta.tradeDate,
      code: pick.code,
      instrument: pick.instrument,
      name: pick.name,
      rank: pick.rank,
      score: pick.score,
      signalPrice: pick.price,
      flowRatio5d: pick.flowRatio5d,
      valuePosition: pick.valuePosition,
      pullbackFromHigh: pick.pullbackFromHigh,
      horizons: {
        "1d": { days: 1, status: "pending" as const },
        "3d": { days: 3, status: "pending" as const },
        "5d": { days: 5, status: "pending" as const },
        "10d": { days: 10, status: "pending" as const }
      },
      status: "tracking" as const
    }))
  );
  await writeReview({
    meta: {
      generatedAt: chinaDateTime(),
      source: "local reports",
      mode: "sample",
      historyReports: reports.length,
      notes: ["样例复盘只展示追踪结构；真实收益统计需要 BIYING_LICENSE 并运行 npm run review"]
    },
    summary: summarize(records),
    records
  });
}

async function liveReview() {
  const reports = await readReports();
  const targets = reports.flatMap((report) => report.picks.map((pick) => ({ report, pick })));
  const uniqueInstruments = [...new Set(targets.map(({ pick }) => pick.instrument))];
  const histories = new Map<string, KLine[]>();

  console.log(`[review] loading ${uniqueInstruments.length} cached instrument histories for ${targets.length} core signals`);
  await mapLimit(uniqueInstruments, 12, async (instrument) => {
    histories.set(instrument, await readKLineCache("daily", instrument, 260));
  });

  const records = targets.map(({ report, pick }) => buildRecord(report, pick, histories.get(pick.instrument) ?? []));
  const review: ReviewReport = {
    meta: {
      generatedAt: chinaDateTime(),
      source: "Local K-line cache + archived scan reports",
      mode: "live",
      historyReports: reports.length,
      notes: [
        "只统计核心强关注池，不把观察池计入胜率",
        "收益按信号日收盘价到后续第 N 个交易日收盘价计算",
        "3日最佳低吸空间和10日最大回撤用信号价到后续最低价估算"
      ]
    },
    summary: summarize(records),
    records: records.sort((a, b) => `${b.signalDate}-${a.rank}`.localeCompare(`${a.signalDate}-${b.rank}`))
  };

  await writeReview(review);
}

const args = new Set(process.argv.slice(2));
if (args.has("--sample")) {
  await sampleReview();
} else {
  await liveReview();
}
