import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scoreCandidate } from "../src/lib/scoring";
import { average, pctChange, round } from "../src/lib/math";
import type { KLine, MoneyFlow, RealQuote, StockActionState, StockListItem, StockPick } from "../src/lib/types";
import { inferExchange, isMainBoardNonSt, plainCode, toInstrumentCode } from "../src/lib/universe";
import { klineCacheRoot, readKLineCache, readStockListCache } from "./kline-cache";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

dotenv.config({ path: resolve(root, ".env.local"), override: false, quiet: true });
dotenv.config({ path: resolve(root, ".env"), override: false, quiet: true });

type Horizon = 10 | 20;

type BacktestConfig = {
  from?: string;
  to?: string;
  horizons: Horizon[];
  top: number;
  historyDays: number;
  flowDays: number;
  targetPct: number;
  maxDates: number;
  outputDir: string;
};

type ReplayResult = {
  horizon: Horizon;
  status: "target" | "stop" | "expired" | "pending";
  closeReturnPct?: number;
  maxRunupPct?: number;
  maxDrawdownPct?: number;
  firstTriggerDate?: string;
};

type BacktestPick = {
  tradeDate: string;
  rank: number;
  instrument: string;
  name: string;
  score: number;
  signal: StockPick["signal"];
  actionState: StockActionState;
  actionLabel?: string;
  price: number;
  setupState: StockPick["setupState"];
  flowRatio5d: number;
  valuePosition: number;
  replay: Record<string, ReplayResult>;
};

type Stats = {
  samples: number;
  completed: number;
  targetHits: number;
  stopHits: number;
  winRate?: number;
  stopRate?: number;
  avgCloseReturnPct?: number;
  avgMaxRunupPct?: number;
  avgMaxDrawdownPct?: number;
};

type BacktestReport = {
  meta: {
    generatedAt: string;
    mode: "cache-only";
    from?: string;
    to?: string;
    horizons: Horizon[];
    top: number;
    historyDays: number;
    flowDays: number;
    targetPct: number;
    evaluatedDates: number;
    universe: number;
    notes: string[];
  };
  cache: {
    stocksWithDaily: number;
    stocksWithMoneyFlow: number;
    skippedNoDaily: number;
  };
  summary: Record<string, Stats>;
  byActionState: Record<string, Record<string, Stats>>;
  picks: BacktestPick[];
};

type MoneyFlowEnvelope = {
  fetchedAt: string;
  data: MoneyFlow[];
};

type StockIndex = {
  items?: Array<{ code: string; instrument: string; name: string }>;
};

function argValue(name: string) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function numberArg(name: string, fallback: number) {
  const value = Number(argValue(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function horizonsArg(): Horizon[] {
  const raw = argValue("horizons") ?? argValue("horizon") ?? "10,20";
  const values = raw
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item): item is Horizon => item === 10 || item === 20);
  return values.length ? [...new Set(values)] : [10, 20];
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

function replayPick(pick: StockPick, futureBars: KLine[], horizon: Horizon, targetPct: number): ReplayResult {
  const window = futureBars.slice(0, horizon);
  if (window.length < horizon) return { horizon, status: "pending" };

  const entry = pick.price;
  const target = entry * (1 + targetPct / 100);
  const stop = pick.actionPlan?.stopLoss ?? pick.tradePlan?.stopLoss ?? entry * 0.94;
  let maxHigh = entry;
  let minLow = entry;
  let status: ReplayResult["status"] = "expired";
  let firstTriggerDate: string | undefined;

  for (const bar of window) {
    maxHigh = Math.max(maxHigh, bar.h);
    minLow = Math.min(minLow, bar.l);
    if (bar.l <= stop) {
      status = "stop";
      firstTriggerDate = dateKey(bar.t);
      break;
    }
    if (bar.h >= target) {
      status = "target";
      firstTriggerDate = dateKey(bar.t);
      break;
    }
  }

  const close = window[window.length - 1]?.c ?? entry;
  return {
    horizon,
    status,
    closeReturnPct: round(pctChange(close, entry), 2),
    maxRunupPct: round(pctChange(maxHigh, entry), 2),
    maxDrawdownPct: round(pctChange(minLow, entry), 2),
    firstTriggerDate
  };
}

function summarize(results: ReplayResult[]): Stats {
  const completed = results.filter((item) => item.status !== "pending");
  const targetHits = completed.filter((item) => item.status === "target").length;
  const stopHits = completed.filter((item) => item.status === "stop").length;
  return {
    samples: results.length,
    completed: completed.length,
    targetHits,
    stopHits,
    winRate: completed.length ? round((targetHits / completed.length) * 100, 1) : undefined,
    stopRate: completed.length ? round((stopHits / completed.length) * 100, 1) : undefined,
    avgCloseReturnPct: completed.length ? round(average(completed.map((item) => item.closeReturnPct)), 2) : undefined,
    avgMaxRunupPct: completed.length ? round(average(completed.map((item) => item.maxRunupPct)), 2) : undefined,
    avgMaxDrawdownPct: completed.length ? round(average(completed.map((item) => item.maxDrawdownPct)), 2) : undefined
  };
}

function buildStats(picks: BacktestPick[], horizons: Horizon[]) {
  const summary: Record<string, Stats> = {};
  const byActionState: Record<string, Record<string, Stats>> = {};
  for (const horizon of horizons) {
    summary[`${horizon}d`] = summarize(picks.map((pick) => pick.replay[`${horizon}d`]).filter(Boolean));
  }
  for (const state of ["ready", "pullback", "track", "risk", "invalid"] satisfies StockActionState[]) {
    const group = picks.filter((pick) => pick.actionState === state);
    byActionState[state] = {};
    for (const horizon of horizons) {
      byActionState[state][`${horizon}d`] = summarize(group.map((pick) => pick.replay[`${horizon}d`]).filter(Boolean));
    }
  }
  return { summary, byActionState };
}

function markdownReport(report: BacktestReport) {
  const lines = [
    "# Strategy Backtest",
    "",
    `Generated: ${report.meta.generatedAt}`,
    `Range: ${report.meta.from ?? "-"} to ${report.meta.to ?? "-"}`,
    `Mode: ${report.meta.mode}`,
    `Universe: ${report.meta.universe}; evaluated dates: ${report.meta.evaluatedDates}; top per day: ${report.meta.top}`,
    "",
    "## Summary",
    "",
    "| Horizon | Samples | Completed | Win | Stop | Avg Close | Avg Runup | Avg Drawdown |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...Object.entries(report.summary).map(([horizon, stats]) =>
      `| ${horizon} | ${stats.samples} | ${stats.completed} | ${stats.winRate ?? "-"}% | ${stats.stopRate ?? "-"}% | ${stats.avgCloseReturnPct ?? "-"}% | ${stats.avgMaxRunupPct ?? "-"}% | ${stats.avgMaxDrawdownPct ?? "-"}% |`
    ),
    "",
    "## By Action State",
    ""
  ];

  for (const [state, horizons] of Object.entries(report.byActionState)) {
    lines.push(`### ${state}`, "");
    lines.push("| Horizon | Samples | Completed | Win | Stop | Avg Close | Avg Runup | Avg Drawdown |");
    lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
    for (const [horizon, stats] of Object.entries(horizons)) {
      lines.push(
        `| ${horizon} | ${stats.samples} | ${stats.completed} | ${stats.winRate ?? "-"}% | ${stats.stopRate ?? "-"}% | ${stats.avgCloseReturnPct ?? "-"}% | ${stats.avgMaxRunupPct ?? "-"}% | ${stats.avgMaxDrawdownPct ?? "-"}% |`
      );
    }
    lines.push("");
  }

  lines.push("## Notes", "");
  for (const note of report.meta.notes) lines.push(`- ${note}`);
  return `${lines.join("\n")}\n`;
}

async function run() {
  const config: BacktestConfig = {
    from: argValue("from"),
    to: argValue("to"),
    horizons: horizonsArg(),
    top: numberArg("top", 10),
    historyDays: numberArg("history-days", 120),
    flowDays: numberArg("flow-days", 10),
    targetPct: numberArg("target-pct", 5),
    maxDates: numberArg("max-dates", 80),
    outputDir: resolve(root, argValue("output-dir") ?? "public/reports/backtests")
  };
  const maxHorizon = Math.max(...config.horizons);

  const { stocks, source: universeSource } = await loadBacktestUniverse();

  const stockData = [];
  let skippedNoDaily = 0;
  let stocksWithMoneyFlow = 0;
  for (const stock of stocks) {
    const instrument = toInstrumentCode(plainCode(stock.dm), inferExchange(stock.dm, stock.jys));
    const daily = await readKLineCache("daily", instrument);
    if (daily.length < config.historyDays + maxHorizon) {
      skippedNoDaily += 1;
      continue;
    }
    const flows = await readMoneyFlowCache(stock.dm);
    if (flows.length) stocksWithMoneyFlow += 1;
    stockData.push({ stock: { ...stock, dm: plainCode(stock.dm), jys: inferExchange(stock.dm, stock.jys) }, instrument, daily, flows });
  }

  const allDates = [...new Set(stockData.flatMap((item) => item.daily.map((bar) => dateKey(bar.t))))].sort();
  const candidateDates = allDates
    .filter((date) => (!config.from || date >= config.from) && (!config.to || date <= config.to))
    .slice(-config.maxDates);

  const picks: BacktestPick[] = [];
  for (const tradeDate of candidateDates) {
    const scored: Array<{ pick: StockPick; future: KLine[] }> = [];
    for (const item of stockData) {
      const index = item.daily.findIndex((bar) => dateKey(bar.t) === tradeDate);
      if (index < config.historyDays || index < 0) continue;
      const history = item.daily.slice(Math.max(0, index - config.historyDays + 1), index + 1);
      const future = item.daily.slice(index + 1, index + 1 + maxHorizon);
      if (future.length < Math.min(...config.horizons)) continue;
      const flows = item.flows.filter((flow) => dateKey(flow.t) <= tradeDate).slice(-config.flowDays);
      const pick = scoreCandidate({
        stock: item.stock,
        quote: quoteFromBar(item.stock, item.daily, index),
        history,
        flows
      });
      if (pick) scored.push({ pick, future });
    }

    scored.sort((a, b) => b.pick.score - a.pick.score);
    scored.slice(0, config.top).forEach(({ pick, future }, index) => {
      const replay = Object.fromEntries(
        config.horizons.map((horizon) => [`${horizon}d`, replayPick(pick, future, horizon, config.targetPct)])
      ) as Record<string, ReplayResult>;
      picks.push({
        tradeDate,
        rank: index + 1,
        instrument: pick.instrument,
        name: pick.name,
        score: pick.score,
        signal: pick.signal,
        actionState: pick.actionState ?? "track",
        actionLabel: pick.actionLabel,
        price: pick.price,
        setupState: pick.setupState,
        flowRatio5d: pick.flowRatio5d,
        valuePosition: pick.valuePosition,
        replay
      });
    });

    if (picks.length && picks.length % (config.top * 10) === 0) {
      console.log(`[backtest] ${tradeDate} picks=${picks.length}`);
    }
  }

  const stats = buildStats(picks, config.horizons);
  const report: BacktestReport = {
    meta: {
      generatedAt: new Date().toISOString(),
      mode: "cache-only",
      from: candidateDates[0],
      to: candidateDates[candidateDates.length - 1],
      horizons: config.horizons,
      top: config.top,
      historyDays: config.historyDays,
      flowDays: config.flowDays,
      targetPct: config.targetPct,
      evaluatedDates: candidateDates.length,
      universe: stockData.length,
      notes: [
        "Backtest is cache-only and does not call Biying API.",
        `Universe source: ${universeSource}.`,
        "Each trade date only uses K-line and money-flow cache rows at or before that date.",
        "Daily-bar replay is conservative when target and stop are touched in the same bar: stop wins.",
        "This first lab version approximates quote turnover/volume-ratio from cached daily bars when realtime quote fields are unavailable."
      ]
    },
    cache: {
      stocksWithDaily: stockData.length,
      stocksWithMoneyFlow,
      skippedNoDaily
    },
    summary: stats.summary,
    byActionState: stats.byActionState,
    picks
  };

  await mkdir(config.outputDir, { recursive: true });
  await writeFile(resolve(config.outputDir, "latest.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(resolve(config.outputDir, "summary.md"), markdownReport(report), "utf8");
  console.log(`[backtest] wrote ${resolve(config.outputDir, "latest.json")}`);
  console.log(`[backtest] wrote ${resolve(config.outputDir, "summary.md")}`);
}

await run();
