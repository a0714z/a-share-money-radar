import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { klineCacheRoot } from "./kline-cache";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

dotenv.config({ path: resolve(root, ".env.local"), override: false, quiet: true });
dotenv.config({ path: resolve(root, ".env"), override: false, quiet: true });

type ScanReportMeta = {
  meta?: {
    tradeDate?: string;
    selectDate?: string;
  };
};

type CachedBar = {
  t?: string;
};

type StrategyLatestReport = {
  meta?: {
    generatedAt?: string;
    tradeDate?: string;
    selectDate?: string;
    from?: string;
    to?: string;
    evaluatedDates?: number;
  };
  picks?: unknown[];
  aestheticWatch?: {
    picks?: unknown[];
    cooldownSummary?: Record<string, { winRate?: number }>;
  };
  cooldownSummary?: Record<string, { winRate?: number }>;
  benchmark?: StrategyLatestReport;
};

type StrategyArchiveIndexItem = {
  tradeDate: string;
  path: string;
  generatedAt?: string;
  mainSignals: number;
  aestheticSignals: number;
  benchmarkFrom?: string;
  benchmarkTo?: string;
  benchmarkDates?: number;
  main10dWinRate?: number;
  aesthetic10dWinRate?: number;
};

type StrategyArchiveIndex = {
  generatedAt: string;
  latestTradeDate?: string;
  items: StrategyArchiveIndexItem[];
};

function dateKey(value?: string) {
  return String(value ?? "").slice(0, 10);
}

async function readLatestTradeDate(reportsDir: string) {
  const latestPath = resolve(reportsDir, "latest.json");
  const latest = JSON.parse(await readFile(latestPath, "utf8")) as ScanReportMeta;
  const tradeDate = latest.meta?.tradeDate;
  if (!tradeDate) throw new Error(`Missing meta.tradeDate in ${latestPath}`);
  return tradeDate;
}

async function readExistingBacktest(outputDir: string) {
  try {
    const report = await readStrategyReport(resolve(outputDir, "latest.json"));
    return {
      date: strategyTradeDate(report),
      hasBenchmark: Number(report.benchmark?.meta?.evaluatedDates ?? 0) > 0,
      benchmark: report.benchmark,
      report
    };
  } catch {
    return undefined;
  }
}

function benchmarkDates(benchmark?: StrategyLatestReport["benchmark"]) {
  return Number(benchmark?.meta?.evaluatedDates ?? 0);
}

function strategyTradeDate(report?: StrategyLatestReport) {
  return report?.meta?.tradeDate ?? report?.meta?.selectDate ?? report?.meta?.to ?? report?.meta?.from;
}

async function readStrategyReport(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as StrategyLatestReport;
}

async function readArchiveIndex(historyDir: string): Promise<StrategyArchiveIndex> {
  try {
    return JSON.parse(await readFile(resolve(historyDir, "index.json"), "utf8")) as StrategyArchiveIndex;
  } catch {
    return {
      generatedAt: new Date().toISOString(),
      items: []
    };
  }
}

async function writeStrategyArchive(outputDir: string, report: StrategyLatestReport) {
  const tradeDate = strategyTradeDate(report);
  if (!tradeDate) {
    console.warn("[strategy:latest] skip archive because report has no trade date");
    return;
  }

  const historyDir = resolve(outputDir, "history");
  await mkdir(historyDir, { recursive: true });
  await writeFile(resolve(historyDir, `${tradeDate}.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const benchmark = report.benchmark ?? report;
  const item: StrategyArchiveIndexItem = {
    tradeDate,
    path: `reports/backtests/history/${tradeDate}.json`,
    generatedAt: report.meta?.generatedAt,
    mainSignals: report.picks?.length ?? 0,
    aestheticSignals: report.aestheticWatch?.picks?.length ?? 0,
    benchmarkFrom: benchmark.meta?.from,
    benchmarkTo: benchmark.meta?.to,
    benchmarkDates: benchmark.meta?.evaluatedDates,
    main10dWinRate: benchmark.cooldownSummary?.["10d"]?.winRate,
    aesthetic10dWinRate: benchmark.aestheticWatch?.cooldownSummary?.["10d"]?.winRate
  };

  const index = await readArchiveIndex(historyDir);
  const byDate = new Map(index.items.map((entry) => [entry.tradeDate, entry]));
  byDate.set(tradeDate, item);
  const items = [...byDate.values()].sort((a, b) => b.tradeDate.localeCompare(a.tradeDate)).slice(0, 120);
  const nextIndex: StrategyArchiveIndex = {
    generatedAt: new Date().toISOString(),
    latestTradeDate: items[0]?.tradeDate,
    items
  };
  await writeFile(resolve(historyDir, "index.json"), `${JSON.stringify(nextIndex, null, 2)}\n`, "utf8");
  console.log(`[strategy:latest] archived ${tradeDate} to ${historyDir}`);
}

async function resolveCachedTradeDate(requestedDate: string) {
  const dailyDir = resolve(klineCacheRoot(), "daily");
  if (!existsSync(dailyDir)) return undefined;

  let latestBeforeOrEqual: string | undefined;
  const files = (await readdir(dailyDir)).filter((file) => file.endsWith(".json"));
  for (const file of files) {
    try {
      const bars = JSON.parse(await readFile(resolve(dailyDir, file), "utf8")) as CachedBar[];
      for (let index = bars.length - 1; index >= 0; index -= 1) {
        const date = dateKey(bars[index]?.t);
        if (!date || date > requestedDate) continue;
        if (date === requestedDate) return { date, exact: true };
        if (!latestBeforeOrEqual || date > latestBeforeOrEqual) latestBeforeOrEqual = date;
        break;
      }
    } catch {
      // Ignore corrupt cache files; the backtest reader applies the same policy.
    }
  }

  return latestBeforeOrEqual ? { date: latestBeforeOrEqual, exact: false } : undefined;
}

function runCommand(command: string, args: string[]) {
  return new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: process.env,
      stdio: "inherit"
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}`));
      }
    });
  });
}

async function run() {
  const reportsDir = resolve(root, process.env.REPORT_DIR ?? "public/reports");
  const outputDir = resolve(root, process.env.STRATEGY_BACKTEST_DIR ?? resolve(reportsDir, "backtests"));
  const benchmarkDir = resolve(outputDir, "benchmark-latest");
  const top = process.env.STRATEGY_BACKTEST_TOP ?? "10";
  const aestheticTop = process.env.STRATEGY_BACKTEST_AESTHETIC_TOP;
  const benchmarkMaxDates = process.env.STRATEGY_BACKTEST_BENCHMARK_MAX_DATES ?? "80";
  const requestedTradeDate = process.env.STRATEGY_BACKTEST_SELECT_DATE ?? (await readLatestTradeDate(reportsDir));
  const existing = await readExistingBacktest(outputDir);
  if (existing?.date === requestedTradeDate && existing.hasBenchmark && process.env.STRATEGY_BACKTEST_FORCE !== "1") {
    console.log(`[strategy:latest] keeping existing report for ${requestedTradeDate} in ${outputDir}`);
    await writeStrategyArchive(outputDir, existing.report);
    return;
  }
  const cachedTradeDate = await resolveCachedTradeDate(requestedTradeDate);
  if (!cachedTradeDate) throw new Error(`No cached daily K-line date found at or before ${requestedTradeDate}`);
  const keepExistingSignal = !cachedTradeDate.exact && existing?.date === requestedTradeDate;
  const tradeDate = keepExistingSignal ? requestedTradeDate : cachedTradeDate.date;
  if (!cachedTradeDate.exact) {
    if (keepExistingSignal) {
      console.warn(`[strategy:latest] requested ${requestedTradeDate} is missing from daily K-line cache; keeping existing exact signal and attaching benchmark to ${cachedTradeDate.date}`);
    } else {
      console.warn(`[strategy:latest] requested ${requestedTradeDate} is not in daily K-line cache; using latest cached date ${tradeDate}`);
    }
  }

  const signalArgs = [
    "run",
    "backtest:strategy",
    "--",
    "--preset=swing",
    `--select-date=${tradeDate}`,
    `--top=${top}`,
    `--output-dir=${outputDir}`
  ];
  if (aestheticTop) signalArgs.push(`--aesthetic-top=${aestheticTop}`);

  if (keepExistingSignal) {
    console.log(`[strategy:latest] keeping existing signal report for ${requestedTradeDate} in ${outputDir}`);
  } else {
    console.log(`[strategy:latest] tradeDate=${tradeDate} outputDir=${outputDir}`);
    try {
      await runCommand("npm", signalArgs);
    } catch (error) {
      if (existing?.date === requestedTradeDate || existing?.date === tradeDate) {
        console.warn(`[strategy:latest] signal recompute failed; keeping existing signal report for ${existing.date}`);
        console.warn(error instanceof Error ? error.message : String(error));
      } else {
        throw error;
      }
    }
  }

  const benchmarkArgs = [
    "run",
    "backtest:strategy",
    "--",
    "--preset=swing",
    `--to=${cachedTradeDate.date}`,
    `--top=${top}`,
    `--max-dates=${benchmarkMaxDates}`,
    `--output-dir=${benchmarkDir}`
  ];
  if (aestheticTop) benchmarkArgs.push(`--aesthetic-top=${aestheticTop}`);

  console.log(`[strategy:latest] benchmark to=${cachedTradeDate.date} maxDates=${benchmarkMaxDates} outputDir=${benchmarkDir}`);
  await runCommand("npm", benchmarkArgs);

  const signalPath = resolve(outputDir, "latest.json");
  const benchmarkPath = resolve(benchmarkDir, "latest.json");
  const signal = await readStrategyReport(signalPath);
  const benchmark = await readStrategyReport(benchmarkPath);
  if (benchmarkDates(benchmark) > 0) {
    signal.benchmark = benchmark;
  } else if (benchmarkDates(existing?.benchmark) > 0) {
    signal.benchmark = existing?.benchmark;
    console.warn(`[strategy:latest] generated benchmark is empty; keeping existing benchmark ${existing?.benchmark?.meta?.from ?? "-"}..${existing?.benchmark?.meta?.to ?? "-"}`);
  } else {
    console.warn("[strategy:latest] generated benchmark is empty and no existing benchmark is available");
    delete signal.benchmark;
  }
  await writeFile(signalPath, `${JSON.stringify(signal, null, 2)}\n`, "utf8");
  console.log(`[strategy:latest] attached benchmark ${signal.benchmark?.meta?.from ?? "-"}..${signal.benchmark?.meta?.to ?? "-"} to ${signalPath}`);
  await writeStrategyArchive(outputDir, signal);
}

await run();
