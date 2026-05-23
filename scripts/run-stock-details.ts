import dotenv from "dotenv";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PlanReport, ReviewRecord, ReviewReport, ScanReport, StockPick } from "../src/lib/types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

dotenv.config({ path: resolve(root, ".env.local"), override: false, quiet: true });
dotenv.config({ path: resolve(root, ".env"), override: false, quiet: true });

const reportsDir = resolve(root, process.env.REPORT_DIR ?? "public/reports");
const outputDir = resolve(root, process.env.STOCK_DETAILS_DIR ?? resolve(reportsDir, "stocks"));

type StockDetailIndexItem = {
  code: string;
  instrument: string;
  name: string;
  sector?: string;
  latestRank?: number;
  latestSignal?: string;
  latestScore?: number;
  latestTradeDate?: string;
  planRank?: number;
  reviewSignals: number;
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

function allReportPicks(report?: ScanReport) {
  return report ? [...report.picks, ...report.watchlist, ...report.avoided] : [];
}

function allPlanPicks(plan?: PlanReport) {
  return plan ? [...plan.plans, ...plan.watchlist, ...plan.avoided] : [];
}

function pickKey(pick: Pick<StockPick, "instrument">) {
  return pick.instrument.toUpperCase();
}

function fileName(instrument: string) {
  return `${instrument.replace(/[^0-9A-Z.]/gi, "_")}.json`;
}

async function run() {
  const latest = existsSync(resolve(reportsDir, "latest.json")) ? await readJson<ScanReport>(resolve(reportsDir, "latest.json")) : undefined;
  const plan = existsSync(resolve(reportsDir, "plan.json")) ? await readJson<PlanReport>(resolve(reportsDir, "plan.json")) : undefined;
  const review = existsSync(resolve(reportsDir, "performance.json")) ? await readJson<ReviewReport>(resolve(reportsDir, "performance.json")) : undefined;

  const latestByInstrument = new Map(allReportPicks(latest).map((pick) => [pickKey(pick), pick]));
  const planByInstrument = new Map(allPlanPicks(plan).map((pick) => [pickKey(pick), pick]));
  const recordsByInstrument = new Map<string, ReviewRecord[]>();
  for (const record of review?.records ?? []) {
    const key = record.instrument.toUpperCase();
    recordsByInstrument.set(key, [...(recordsByInstrument.get(key) ?? []), record]);
  }

  const instruments = new Set<string>([
    ...latestByInstrument.keys(),
    ...planByInstrument.keys(),
    ...[...recordsByInstrument.keys()].slice(0, 200)
  ]);
  const generatedAt = chinaDateTime();
  const index: StockDetailIndexItem[] = [];

  await mkdir(outputDir, { recursive: true });
  for (const instrument of instruments) {
    const latestPick = latestByInstrument.get(instrument);
    const planPick = planByInstrument.get(instrument);
    const records = (recordsByInstrument.get(instrument) ?? []).sort((a, b) => b.signalDate.localeCompare(a.signalDate)).slice(0, 20);
    const source = latestPick ?? planPick;
    if (!source && !records.length) continue;

    const detail = {
      meta: {
        generatedAt,
        tradeDate: latest?.meta.tradeDate ?? plan?.meta.tradeDate,
        source: "local-json",
        notes: ["详情数据来自每日收盘 JSON，不在页面访问时调用必盈 API。"]
      },
      code: source?.code ?? records[0]?.code,
      instrument,
      name: source?.name ?? records[0]?.name,
      sector: source?.sector,
      latestPick,
      planPick,
      reviewRecords: records
    };

    await writeFile(resolve(outputDir, fileName(instrument)), `${JSON.stringify(detail, null, 2)}\n`, "utf8");
    index.push({
      code: detail.code ?? instrument.slice(0, 6),
      instrument,
      name: detail.name ?? instrument,
      sector: detail.sector,
      latestRank: latestPick?.rank,
      latestSignal: latestPick?.signal,
      latestScore: latestPick?.score,
      latestTradeDate: latest?.meta.tradeDate,
      planRank: planPick?.rank,
      reviewSignals: records.length
    });
  }

  index.sort((a, b) => {
    const left = a.latestRank ?? a.planRank ?? 9999;
    const right = b.latestRank ?? b.planRank ?? 9999;
    return left - right || b.reviewSignals - a.reviewSignals || a.instrument.localeCompare(b.instrument);
  });
  await writeFile(resolve(outputDir, "index.json"), `${JSON.stringify({ generatedAt, total: index.length, items: index }, null, 2)}\n`, "utf8");
  console.log(`[stock-details] wrote ${index.length} stock detail files to ${outputDir}`);
}

await run();

