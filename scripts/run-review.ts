import dotenv from "dotenv";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BiyingClient } from "./biying-client";
import { pctChange, round } from "../src/lib/math";
import type { KLine, ReviewHorizon, ReviewRecord, ReviewReport, ScanReport, StockPick } from "../src/lib/types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const historyDir = resolve(root, "public/reports/history");
const latestPath = resolve(root, "public/reports/latest.json");
const outputPath = resolve(root, "public/reports/performance.json");
const horizons: Array<{ key: ReviewHorizon; days: number }> = [
  { key: "1d", days: 1 },
  { key: "3d", days: 3 },
  { key: "5d", days: 5 },
  { key: "10d", days: 10 }
];

dotenv.config({ path: resolve(root, ".env.local"), override: false });
dotenv.config({ path: resolve(root, ".env"), override: false });

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

  return summary;
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
  const license = process.env.BIYING_LICENSE;
  if (!license) throw new Error("Missing BIYING_LICENSE. Run npm run review:sample for a local placeholder report.");

  const reports = await readReports();
  const client = new BiyingClient(license);
  const targets = reports.flatMap((report) => report.picks.map((pick) => ({ report, pick })));
  const uniqueInstruments = [...new Set(targets.map(({ pick }) => pick.instrument))];
  const histories = new Map<string, KLine[]>();

  console.log(`[review] loading ${uniqueInstruments.length} instrument histories for ${targets.length} core signals`);
  await mapLimit(uniqueInstruments, 12, async (instrument) => {
    histories.set(instrument, await client.history(instrument, 260));
  });

  const records = targets.map(({ report, pick }) => buildRecord(report, pick, histories.get(pick.instrument) ?? []));
  const review: ReviewReport = {
    meta: {
      generatedAt: chinaDateTime(),
      source: "Biying API + archived scan reports",
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
