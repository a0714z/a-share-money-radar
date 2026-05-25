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

async function run() {
  const klineCacheDir = resolve(root, process.env.KLINE_CACHE_DIR ?? ".cache/kline");
  const apiCacheDir = resolve(root, process.env.API_CACHE_DIR ?? ".cache/biying");
  const latest = await readJson<any>(resolve(reportsDir, "latest.json")).catch(() => undefined);
  const plan = await readJson<any>(resolve(reportsDir, "plan.json")).catch(() => undefined);
  const review = await readJson<any>(resolve(reportsDir, "performance.json")).catch(() => undefined);
  const strategy = await readJson<any>(resolve(reportsDir, "backtests/latest.json")).catch(() => undefined);
  const klineSummary = await readJson<any>(resolve(reportsDir, "kline-cache.json")).catch(() => undefined);
  const intraday = await readJson<any>(resolve(reportsDir, "intraday.json")).catch(() => undefined);

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
  const strategyTradeDate = strategy?.meta?.selectDate ?? strategy?.meta?.to ?? strategy?.meta?.from;
  const reportOk = Boolean(latest?.meta?.generatedAt && plan?.meta?.generatedAt && review?.meta?.generatedAt);
  const strategyOk = Boolean(strategy?.meta?.generatedAt && latestTradeDate && strategyTradeDate === latestTradeDate);
  const strategyWarn = Boolean(strategy?.meta?.generatedAt);
  const notes = [
    "页面只读取 reports 静态 JSON，不直接调用必盈 API。",
    "普通扫描脚本默认只读本地 API 缓存；只有 API_CACHE_REFRESH=1 时刷新资金流和公司资料。",
    "服务器收盘任务应在交易日 18:00 执行 daily:close。"
  ];

  const report = {
    generatedAt: chinaDateTime(),
    tradeDate: latestTradeDate,
    status: reportOk && strategyOk && dailyOk && minuteOk ? "ok" : reportOk && dailyFiles && minuteFiles ? "warn" : "risk",
    schedule: {
      closeRun: "交易日 18:00",
      mailNotify: "交易日 09:00"
    },
    reports: {
      tone: tone(reportOk, Boolean(latest || plan || review)),
      latestGeneratedAt: latest?.meta?.generatedAt,
      planGeneratedAt: plan?.meta?.generatedAt,
      reviewGeneratedAt: review?.meta?.generatedAt,
      latestPicks: latest?.picks?.length ?? 0,
      latestWatchlist: latest?.watchlist?.length ?? 0,
      planCount: plan?.plans?.length ?? 0,
      reviewSignals: review?.summary?.totalSignals ?? 0
    },
    strategyBacktest: {
      tone: tone(strategyOk, strategyWarn),
      generatedAt: strategy?.meta?.generatedAt,
      tradeDate: strategyTradeDate,
      expectedTradeDate: latestTradeDate,
      mainSignals: strategy?.picks?.length ?? 0,
      aestheticSignals: strategy?.aestheticWatch?.picks?.length ?? 0,
      cooldown10dWinRate: strategy?.cooldownSummary?.["10d"]?.winRate,
      aesthetic10dWinRate: strategy?.aestheticWatch?.cooldownSummary?.["10d"]?.winRate
    },
    klineCache: {
      tone: tone(dailyOk && minuteOk, dailyFiles > 0 && minuteFiles > 0),
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
