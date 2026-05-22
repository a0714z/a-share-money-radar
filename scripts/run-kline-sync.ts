import dotenv from "dotenv";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BiyingClient } from "./biying-client";
import { klineCacheRoot, mergeKLines, writeKLineCache } from "./kline-cache";
import { isMainBoardNonSt, inferExchange, plainCode, toInstrumentCode } from "../src/lib/universe";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

dotenv.config({ path: resolve(root, ".env.local"), override: false, quiet: true });
dotenv.config({ path: resolve(root, ".env"), override: false, quiet: true });

type SyncSummary = {
  generatedAt: string;
  cacheDir: string;
  universe: number;
  daily: { requested: number; ok: number; failed: number; bars: number };
  intraday30m: { requested: number; ok: number; failed: number; bars: number };
  failures: Array<{ instrument: string; frame: "daily" | "30m"; message: string }>;
};

function intEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

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

async function mapLimit<T>(items: T[], limit: number, mapper: (item: T, index: number) => Promise<void>) {
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function writeSummary(summary: SyncSummary) {
  const outputPath = resolve(root, process.env.KLINE_SYNC_REPORT_PATH ?? "public/reports/kline-cache.json");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(`[kline-sync] wrote ${outputPath}`);
}

async function run() {
  const license = process.env.BIYING_LICENSE;
  if (!license) throw new Error("Missing BIYING_LICENSE. Set it in .env.local or /etc/a-share-money-radar.env.");

  const args = new Set(process.argv.slice(2));
  const dailyOnly = args.has("--daily-only");
  const intradayOnly = args.has("--30m-only");
  const dailyDays = intEnv("KLINE_SYNC_DAILY_DAYS", intEnv("PLAN_HISTORY_DAYS", 80));
  const intradayBars = intEnv("KLINE_SYNC_30M_BARS", intEnv("PLAN_30M_BARS", 160));
  const concurrency = intEnv("KLINE_SYNC_CONCURRENCY", 10);
  const client = new BiyingClient(license);

  console.log("[kline-sync] fetching stock list");
  const listed = await client.stockList();
  const universe = listed
    .filter(isMainBoardNonSt)
    .map((stock) => {
      const code = plainCode(stock.dm);
      const exchange = inferExchange(stock.dm, stock.jys);
      return { stock: { ...stock, dm: code, jys: exchange }, instrument: toInstrumentCode(code, exchange) };
    });

  const summary: SyncSummary = {
    generatedAt: chinaDateTime(),
    cacheDir: klineCacheRoot(),
    universe: universe.length,
    daily: { requested: dailyOnly || !intradayOnly ? universe.length : 0, ok: 0, failed: 0, bars: 0 },
    intraday30m: { requested: intradayOnly || !dailyOnly ? universe.length : 0, ok: 0, failed: 0, bars: 0 },
    failures: []
  };

  await mapLimit(universe, concurrency, async ({ instrument }, index) => {
    if (!intradayOnly) {
      try {
        const bars = await client.history(instrument, dailyDays);
        const merged = await writeKLineCache("daily", instrument, bars, Math.max(dailyDays, intEnv("KLINE_DAILY_MAX_BARS", 120)));
        summary.daily.ok += 1;
        summary.daily.bars += merged.length;
      } catch (error) {
        summary.daily.failed += 1;
        if (summary.failures.length < 30) summary.failures.push({ instrument, frame: "daily", message: (error as Error).message });
      }
    }

    if (!dailyOnly) {
      try {
        const [history30m, latest30m] = await Promise.all([
          client.history30m(instrument, intradayBars).catch(() => []),
          client.latest30m(instrument, Math.min(intradayBars, 96)).catch(() => [])
        ]);
        const merged = await writeKLineCache("30m", instrument, mergeKLines(history30m, latest30m), Math.max(intradayBars, intEnv("KLINE_30M_MAX_BARS", 320)));
        summary.intraday30m.ok += 1;
        summary.intraday30m.bars += merged.length;
      } catch (error) {
        summary.intraday30m.failed += 1;
        if (summary.failures.length < 30) summary.failures.push({ instrument, frame: "30m", message: (error as Error).message });
      }
    }

    if ((index + 1) % 100 === 0) console.log(`[kline-sync] ${index + 1}/${universe.length}`);
  });

  await writeSummary(summary);
  console.log(
    `[kline-sync] done daily=${summary.daily.ok}/${summary.daily.requested} 30m=${summary.intraday30m.ok}/${summary.intraday30m.requested}`
  );
}

await run();

