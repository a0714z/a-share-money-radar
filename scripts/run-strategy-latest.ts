import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
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
  };
};

type CachedBar = {
  t?: string;
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

async function readExistingBacktestDate(outputDir: string) {
  try {
    const report = JSON.parse(await readFile(resolve(outputDir, "latest.json"), "utf8")) as ScanReportMeta;
    return report.meta?.tradeDate ?? (report.meta as { selectDate?: string } | undefined)?.selectDate;
  } catch {
    return undefined;
  }
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
  const top = process.env.STRATEGY_BACKTEST_TOP ?? "10";
  const aestheticTop = process.env.STRATEGY_BACKTEST_AESTHETIC_TOP;
  const requestedTradeDate = process.env.STRATEGY_BACKTEST_SELECT_DATE ?? (await readLatestTradeDate(reportsDir));
  const existingDate = await readExistingBacktestDate(outputDir);
  if (existingDate === requestedTradeDate && process.env.STRATEGY_BACKTEST_FORCE !== "1") {
    console.log(`[strategy:latest] keeping existing report for ${requestedTradeDate} in ${outputDir}`);
    return;
  }
  const cachedTradeDate = await resolveCachedTradeDate(requestedTradeDate);
  if (!cachedTradeDate) throw new Error(`No cached daily K-line date found at or before ${requestedTradeDate}`);
  if (!cachedTradeDate.exact) {
    if (existingDate === requestedTradeDate) {
      console.warn(`[strategy:latest] requested ${requestedTradeDate} is missing from daily K-line cache; keeping existing exact report in ${outputDir}`);
      return;
    }
  }
  const tradeDate = cachedTradeDate.date;
  if (!cachedTradeDate.exact) {
    console.warn(`[strategy:latest] requested ${requestedTradeDate} is not in daily K-line cache; using latest cached date ${tradeDate}`);
  }

  const args = [
    "run",
    "backtest:strategy",
    "--",
    "--preset=swing",
    `--select-date=${tradeDate}`,
    `--top=${top}`,
    `--output-dir=${outputDir}`
  ];
  if (aestheticTop) args.push(`--aesthetic-top=${aestheticTop}`);

  console.log(`[strategy:latest] tradeDate=${tradeDate} outputDir=${outputDir}`);
  await runCommand("npm", args);
}

await run();
