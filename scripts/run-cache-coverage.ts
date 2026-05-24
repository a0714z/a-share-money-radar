import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { KLine, MoneyFlow, StockListItem } from "../src/lib/types";
import { MARKET_INDEXES } from "../src/lib/market-regime";
import { inferExchange, isMainBoardNonSt, plainCode, toInstrumentCode } from "../src/lib/universe";
import { klineCacheRoot, readKLineCache, readStockListCache } from "./kline-cache";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

dotenv.config({ path: resolve(root, ".env.local"), override: false, quiet: true });
dotenv.config({ path: resolve(root, ".env"), override: false, quiet: true });

type RequestKind = "stock-list" | "index-daily" | "daily" | "30m-history" | "30m-latest" | "money-flow";

type PlannedRequest = {
  kind: RequestKind;
  instrument: string;
  estimatedRequests: number;
  reason: string;
};

type CoverageRow = {
  code: string;
  instrument: string;
  name: string;
  dailyBars: number;
  dailyFirst?: string;
  dailyLast?: string;
  intraday30mBars: number;
  intraday30mFirst?: string;
  intraday30mLast?: string;
  moneyFlowRows: number;
  moneyFlowFirst?: string;
  moneyFlowLast?: string;
  missing: RequestKind[];
};

type CachePlanReport = {
  meta: {
    generatedAt: string;
    mode: "plan-only";
    universeSource: string;
    universe: number;
    from?: string;
    to?: string;
    targetDailyBars: number;
    target30mBars: number;
    targetMoneyFlowRows: number;
    maxRequests: number;
    include30m: boolean;
    includeMoneyFlow: boolean;
    notes: string[];
  };
  summary: {
    estimatedRequests: number;
    batches: number;
    overBudget: boolean;
    missingStockList: boolean;
    missingIndexDaily: number;
    missingDaily: number;
    missing30m: number;
    missingMoneyFlow: number;
  };
  batches: Array<{
    index: number;
    estimatedRequests: number;
    requests: PlannedRequest[];
  }>;
  coverage: CoverageRow[];
};

type StockIndex = {
  items?: Array<{ code: string; instrument: string; name: string }>;
};

type MoneyFlowEnvelope = {
  fetchedAt: string;
  data: MoneyFlow[];
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

function boolArg(name: string, fallback: boolean) {
  if (hasFlag(name)) return true;
  const value = argValue(name);
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function dateKey(value?: string) {
  return String(value ?? "").slice(0, 10);
}

function byDateAsc<T extends { t?: string }>(items: T[]) {
  return [...items].sort((a, b) => String(a.t ?? "").localeCompare(String(b.t ?? "")));
}

function firstDate(items: Array<{ t?: string }>) {
  return items.length ? dateKey(items[0].t) : undefined;
}

function lastDate(items: Array<{ t?: string }>) {
  return items.length ? dateKey(items[items.length - 1].t) : undefined;
}

function safeCode(code: string) {
  return code.replace(/[^0-9A-Z.]/gi, "_");
}

function apiCacheRoot() {
  return resolve(root, process.env.API_CACHE_DIR ?? ".cache/biying");
}

async function readStockIndex() {
  const path = resolve(root, "public/reports/stocks/index.json");
  if (!existsSync(path)) return [];
  try {
    const index = JSON.parse(await readFile(path, "utf8")) as StockIndex;
    return (index.items ?? []).map((item): StockListItem => {
      const exchange = inferExchange(item.instrument);
      return {
        dm: plainCode(item.code || item.instrument),
        jys: exchange,
        mc: item.name
      };
    });
  } catch (error) {
    console.warn(`[cache-plan] stock index fallback skipped: ${(error as Error).message}`);
    return [];
  }
}

async function listStocksFromDailyCache() {
  const dir = resolve(klineCacheRoot(), "daily");
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir)).filter((file) => file.endsWith(".json"));
  return files.map((file): StockListItem => {
    const instrument = file.replace(/\.json$/, "");
    const exchange = inferExchange(instrument);
    return {
      dm: plainCode(instrument),
      jys: exchange,
      mc: instrument
    };
  });
}

async function loadUniverse(mode: string) {
  const stockList = (await readStockListCache()).filter(isMainBoardNonSt);
  if (mode === "all" && stockList.length) return { stocks: stockList, source: "stock-list-cache", missingStockList: false };

  const dailyCache = (await listStocksFromDailyCache()).filter(isMainBoardNonSt);
  if ((mode === "cached" || mode === "all") && dailyCache.length) {
    return { stocks: dailyCache, source: "daily-cache-files", missingStockList: stockList.length === 0 };
  }

  const signalIndex = (await readStockIndex()).filter(isMainBoardNonSt);
  if ((mode === "signals" || mode === "cached" || mode === "all") && signalIndex.length) {
    return { stocks: signalIndex, source: "reports/stocks/index.json", missingStockList: stockList.length === 0 };
  }

  return { stocks: stockList, source: stockList.length ? "stock-list-cache" : "none", missingStockList: stockList.length === 0 };
}

async function readMoneyFlowCache(code: string) {
  const path = resolve(apiCacheRoot(), "money-flow", `${safeCode(plainCode(code))}.json`);
  if (!existsSync(path)) return [];
  try {
    const envelope = JSON.parse(await readFile(path, "utf8")) as MoneyFlowEnvelope | MoneyFlow[];
    const rows = Array.isArray(envelope) ? envelope : envelope.data;
    return byDateAsc(Array.isArray(rows) ? rows : []);
  } catch (error) {
    console.warn(`[cache-plan] money-flow cache skipped ${code}: ${(error as Error).message}`);
    return [];
  }
}

function needsBars(bars: KLine[], targetBars: number, to?: string) {
  if (bars.length < targetBars) return true;
  if (to && lastDate(bars) && String(lastDate(bars)) < to) return true;
  return false;
}

function needsRows(rows: MoneyFlow[], targetRows: number, to?: string) {
  if (rows.length < targetRows) return true;
  if (to && lastDate(rows) && String(lastDate(rows)) < to) return true;
  return false;
}

function addRequest(requests: PlannedRequest[], kind: RequestKind, instrument: string, reason: string, estimatedRequests = 1) {
  requests.push({ kind, instrument, reason, estimatedRequests });
}

function batchRequests(requests: PlannedRequest[], maxRequests: number) {
  const batches: CachePlanReport["batches"] = [];
  let current: PlannedRequest[] = [];
  let currentCount = 0;

  for (const request of requests) {
    const cost = request.estimatedRequests;
    if (current.length && currentCount + cost > maxRequests) {
      batches.push({ index: batches.length + 1, estimatedRequests: currentCount, requests: current });
      current = [];
      currentCount = 0;
    }
    current.push(request);
    currentCount += cost;
  }

  if (current.length) batches.push({ index: batches.length + 1, estimatedRequests: currentCount, requests: current });
  return batches;
}

function markdown(report: CachePlanReport) {
  const lines = [
    "# Cache Coverage Plan",
    "",
    `Generated: ${report.meta.generatedAt}`,
    `Universe: ${report.meta.universe} (${report.meta.universeSource})`,
    `Estimated requests: ${report.summary.estimatedRequests}`,
    `Budget per batch: ${report.meta.maxRequests}`,
    `Batches: ${report.summary.batches}`,
    "",
    "## Missing",
    "",
    `- Stock list: ${report.summary.missingStockList ? "missing" : "ok"}`,
    `- Index daily: ${report.summary.missingIndexDaily}`,
    `- Stock daily: ${report.summary.missingDaily}`,
    `- 30m: ${report.summary.missing30m}`,
    `- Money flow: ${report.summary.missingMoneyFlow}`,
    "",
    "## Batches",
    ""
  ];

  for (const batch of report.batches) {
    const counts = batch.requests.reduce<Record<string, number>>((acc, request) => {
      acc[request.kind] = (acc[request.kind] ?? 0) + request.estimatedRequests;
      return acc;
    }, {});
    lines.push(`### Batch ${batch.index} (${batch.estimatedRequests} requests)`, "");
    for (const [kind, count] of Object.entries(counts)) lines.push(`- ${kind}: ${count}`);
    lines.push("");
  }

  lines.push("## Notes", "");
  for (const note of report.meta.notes) lines.push(`- ${note}`);
  return `${lines.join("\n")}\n`;
}

async function run() {
  const outputDir = resolve(root, argValue("output-dir") ?? "public/reports/backtests");
  const universeMode = argValue("universe") ?? "signals";
  const from = argValue("from");
  const to = argValue("to");
  const targetDailyBars = numberArg("daily-bars", 180);
  const target30mBars = numberArg("30m-bars", 320);
  const targetMoneyFlowRows = numberArg("flow-rows", 120);
  const maxRequests = numberArg("max-requests", Number(process.env.BIYING_MAX_REQUESTS) || 5500);
  const include30m = boolArg("include-30m", true);
  const includeMoneyFlow = boolArg("include-flow", true);
  const { stocks, source, missingStockList } = await loadUniverse(universeMode);

  const requests: PlannedRequest[] = [];
  const coverage: CoverageRow[] = [];

  if (missingStockList) {
    addRequest(requests, "stock-list", "ALL", "No stock-list cache found; full-universe planning needs one fresh stockList request.");
  }

  let missingIndexDaily = 0;
  for (const index of MARKET_INDEXES) {
    const bars = await readKLineCache("index-daily", index.code);
    if (needsBars(bars, targetDailyBars, to)) {
      missingIndexDaily += 1;
      addRequest(requests, "index-daily", index.code, `index daily coverage ${bars.length}/${targetDailyBars}, last=${lastDate(bars) ?? "-"}`);
    }
  }

  let missingDaily = 0;
  let missing30m = 0;
  let missingMoneyFlow = 0;
  for (const stock of stocks) {
    const code = plainCode(stock.dm);
    const exchange = inferExchange(stock.dm, stock.jys);
    const instrument = toInstrumentCode(code, exchange);
    const daily = await readKLineCache("daily", instrument);
    const intraday30m = include30m ? await readKLineCache("30m", instrument) : [];
    const moneyFlow = includeMoneyFlow ? await readMoneyFlowCache(code) : [];
    const missing: RequestKind[] = [];

    if (needsBars(daily, targetDailyBars, to)) {
      missingDaily += 1;
      missing.push("daily");
      addRequest(requests, "daily", instrument, `daily coverage ${daily.length}/${targetDailyBars}, last=${lastDate(daily) ?? "-"}`);
    }

    if (include30m && needsBars(intraday30m, target30mBars, to)) {
      missing30m += 1;
      missing.push("30m-history");
      missing.push("30m-latest");
      addRequest(requests, "30m-history", instrument, `30m history coverage ${intraday30m.length}/${target30mBars}, last=${lastDate(intraday30m) ?? "-"}`);
      addRequest(requests, "30m-latest", instrument, "refresh latest 30m bars after history sync");
    }

    if (includeMoneyFlow && needsRows(moneyFlow, targetMoneyFlowRows, to)) {
      missingMoneyFlow += 1;
      missing.push("money-flow");
      addRequest(requests, "money-flow", instrument, `money-flow coverage ${moneyFlow.length}/${targetMoneyFlowRows}, last=${lastDate(moneyFlow) ?? "-"}`);
    }

    coverage.push({
      code,
      instrument,
      name: stock.mc,
      dailyBars: daily.length,
      dailyFirst: firstDate(daily),
      dailyLast: lastDate(daily),
      intraday30mBars: intraday30m.length,
      intraday30mFirst: firstDate(intraday30m),
      intraday30mLast: lastDate(intraday30m),
      moneyFlowRows: moneyFlow.length,
      moneyFlowFirst: firstDate(moneyFlow),
      moneyFlowLast: lastDate(moneyFlow),
      missing
    });
  }

  const batches = batchRequests(requests, maxRequests);
  const estimatedRequests = requests.reduce((total, request) => total + request.estimatedRequests, 0);
  const report: CachePlanReport = {
    meta: {
      generatedAt: new Date().toISOString(),
      mode: "plan-only",
      universeSource: source,
      universe: stocks.length,
      from,
      to,
      targetDailyBars,
      target30mBars,
      targetMoneyFlowRows,
      maxRequests,
      include30m,
      includeMoneyFlow,
      notes: [
        "This script never calls Biying API; it only scans local cache and writes a request plan.",
        "Every listed request must be executed serially through BiyingClient/request guard.",
        "30m coverage costs two planned requests per instrument: history30m then latest30m.",
        "Use --universe all after stock-list cache exists; without it the planner falls back to recent signal index."
      ]
    },
    summary: {
      estimatedRequests,
      batches: batches.length,
      overBudget: estimatedRequests > maxRequests,
      missingStockList,
      missingIndexDaily,
      missingDaily,
      missing30m,
      missingMoneyFlow
    },
    batches,
    coverage
  };

  await mkdir(outputDir, { recursive: true });
  await writeFile(resolve(outputDir, "cache-plan.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(resolve(outputDir, "cache-plan.md"), markdown(report), "utf8");
  console.log(`[cache-plan] universe=${stocks.length} source=${source}`);
  console.log(`[cache-plan] estimatedRequests=${estimatedRequests} batches=${batches.length} budget=${maxRequests}`);
  console.log(`[cache-plan] wrote ${resolve(outputDir, "cache-plan.json")}`);
  console.log(`[cache-plan] wrote ${resolve(outputDir, "cache-plan.md")}`);
}

await run();
