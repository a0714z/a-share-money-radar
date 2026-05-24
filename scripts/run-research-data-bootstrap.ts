import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BiyingClient } from "./biying-client";
import { biyingRequestStats } from "./biying-request-guard";
import { klineCacheRoot, mergeKLines, stockList, writeKLineCache, readKLineCache } from "./kline-cache";
import { MARKET_INDEXES } from "../src/lib/market-regime";
import { inferExchange, isMainBoardNonSt, plainCode, toInstrumentCode } from "../src/lib/universe";
import type { MoneyFlow } from "../src/lib/types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

dotenv.config({ path: resolve(root, ".env.local"), override: false, quiet: true });
dotenv.config({ path: resolve(root, ".env"), override: false, quiet: true });

type BootstrapSummary = {
  generatedAt: string;
  mode: "research-data-bootstrap";
  cacheDir: string;
  universe: number;
  settings: {
    dailyBars: number;
    intraday30mBars: number;
    moneyFlowRows: number;
    indexCalendarDays: number;
    include30m: boolean;
    includeFlow: boolean;
    force: boolean;
  };
  stockList: { ok: boolean; count: number };
  indexDaily: { requested: number; skipped: number; ok: number; failed: number; bars: number };
  daily: { requested: number; skipped: number; ok: number; failed: number; bars: number };
  intraday30m: { requested: number; skipped: number; ok: number; failed: number; bars: number };
  moneyFlow: { requested: number; skipped: number; ok: number; failed: number; rows: number };
  api: ReturnType<typeof biyingRequestStats>;
  failures: Array<{ instrument: string; frame: "index-daily" | "daily" | "30m" | "money-flow"; message: string }>;
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

function numberEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function boolArg(name: string, fallback: boolean) {
  if (hasFlag(name)) return true;
  const value = argValue(name);
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function chinaDate(date = new Date()) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  })
    .format(date)
    .replace(/\//g, "");
}

function apiCacheRoot() {
  return resolve(root, process.env.API_CACHE_DIR ?? ".cache/biying");
}

function safeCode(code: string) {
  return code.replace(/[^0-9A-Z.]/gi, "_");
}

function isoChinaTime(date = new Date()) {
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

function startDateByCalendarDays(days: number) {
  return chinaDate(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
}

async function cacheHasEnough(frame: "daily" | "30m" | "index-daily", instrument: string, targetBars: number) {
  const existing = await readKLineCache(frame, instrument);
  return existing.length >= targetBars;
}

async function readMoneyFlowCache(code: string) {
  const path = resolve(apiCacheRoot(), "money-flow", `${safeCode(plainCode(code))}.json`);
  if (!existsSync(path)) return [];
  try {
    const envelope = JSON.parse(await readFile(path, "utf8")) as { data?: MoneyFlow[] } | MoneyFlow[];
    const rows = Array.isArray(envelope) ? envelope : envelope.data;
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

async function writeMoneyFlowCache(code: string, rows: MoneyFlow[]) {
  const path = resolve(apiCacheRoot(), "money-flow", `${safeCode(plainCode(code))}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ fetchedAt: new Date().toISOString(), data: rows })}\n`, "utf8");
}

async function writeSummary(summary: BootstrapSummary) {
  summary.api = biyingRequestStats();
  const outputPath = resolve(root, argValue("report") ?? "public/reports/backtests/research-data-bootstrap.json");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(`[research-data] wrote ${outputPath}`);
}

async function run() {
  const license = process.env.BIYING_LICENSE;
  if (!license) throw new Error("Missing BIYING_LICENSE. Set it in .env.local or /etc/a-share-money-radar.env.");

  const dailyBars = numberArg("daily-bars", numberArg("daily", numberEnv("RESEARCH_DAILY_BARS", 620)));
  const intraday30mBars = numberArg("30m-bars", numberArg("intraday", numberEnv("RESEARCH_30M_BARS", 1200)));
  const moneyFlowRows = numberArg("flow-rows", numberArg("money-flow", numberEnv("RESEARCH_FLOW_ROWS", 240)));
  const indexCalendarDays = numberArg("index-calendar-days", numberEnv("RESEARCH_INDEX_CALENDAR_DAYS", 1100));
  const flowOnly = hasFlag("flow-only");
  const includeKLine = !flowOnly;
  const include30m = includeKLine && !hasFlag("daily-only") && boolArg("include-30m", true);
  const includeFlow = !hasFlag("kline-only") && boolArg("include-flow", true);
  const force = hasFlag("force");
  const client = new BiyingClient(license);

  console.log("[research-data] starting one-shot research data bootstrap");
  console.log(`[research-data] dailyBars=${dailyBars} 30mBars=${intraday30mBars} flowRows=${moneyFlowRows} include30m=${include30m} includeFlow=${includeFlow} force=${force}`);
  console.log("[research-data] all Biying API requests are serial through BiyingClient guard");

  const rawStocks = await stockList(client);
  const universe = rawStocks
    .filter(isMainBoardNonSt)
    .map((stock) => {
      const code = plainCode(stock.dm);
      const exchange = inferExchange(stock.dm, stock.jys);
      return { stock: { ...stock, dm: code, jys: exchange }, instrument: toInstrumentCode(code, exchange) };
    });

  const summary: BootstrapSummary = {
    generatedAt: isoChinaTime(),
    mode: "research-data-bootstrap",
    cacheDir: klineCacheRoot(),
    universe: universe.length,
    settings: { dailyBars, intraday30mBars, moneyFlowRows, indexCalendarDays, include30m, includeFlow, force },
    stockList: { ok: rawStocks.length > 0, count: rawStocks.length },
    indexDaily: { requested: includeKLine ? MARKET_INDEXES.length : 0, skipped: 0, ok: 0, failed: 0, bars: 0 },
    daily: { requested: includeKLine ? universe.length : 0, skipped: 0, ok: 0, failed: 0, bars: 0 },
    intraday30m: { requested: include30m ? universe.length : 0, skipped: 0, ok: 0, failed: 0, bars: 0 },
    moneyFlow: { requested: includeFlow ? universe.length : 0, skipped: 0, ok: 0, failed: 0, rows: 0 },
    api: biyingRequestStats(),
    failures: []
  };

  if (includeKLine) {
    const indexStart = startDateByCalendarDays(indexCalendarDays);
    const indexEnd = chinaDate();
    for (const index of MARKET_INDEXES) {
      if (!force && (await cacheHasEnough("index-daily", index.code, 260))) {
        summary.indexDaily.skipped += 1;
        continue;
      }
      try {
        const bars = await client.indexHistory(index.code, indexStart, indexEnd);
        const merged = await writeKLineCache("index-daily", index.code, bars, Math.max(260, dailyBars));
        summary.indexDaily.ok += 1;
        summary.indexDaily.bars += merged.length;
      } catch (error) {
        summary.indexDaily.failed += 1;
        if (summary.failures.length < 80) summary.failures.push({ instrument: index.code, frame: "index-daily", message: (error as Error).message });
      }
    }
  }

  for (const { stock, instrument } of universe) {
    if (includeKLine && !force && (await cacheHasEnough("daily", instrument, dailyBars))) {
      summary.daily.skipped += 1;
    } else if (includeKLine) {
      try {
        const bars = await client.history(instrument, dailyBars);
        const merged = await writeKLineCache("daily", instrument, bars, dailyBars);
        summary.daily.ok += 1;
        summary.daily.bars += merged.length;
      } catch (error) {
        summary.daily.failed += 1;
        if (summary.failures.length < 80) summary.failures.push({ instrument, frame: "daily", message: (error as Error).message });
      }
    }

    if (include30m) {
      if (!force && (await cacheHasEnough("30m", instrument, intraday30mBars))) {
        summary.intraday30m.skipped += 1;
      } else {
        try {
          const history30m = await client.history30m(instrument, intraday30mBars).catch(() => []);
          const latest30m = await client.latest30m(instrument, Math.min(intraday30mBars, 96)).catch(() => []);
          const merged = await writeKLineCache("30m", instrument, mergeKLines(history30m, latest30m), intraday30mBars);
          summary.intraday30m.ok += 1;
          summary.intraday30m.bars += merged.length;
        } catch (error) {
          summary.intraday30m.failed += 1;
          if (summary.failures.length < 80) summary.failures.push({ instrument, frame: "30m", message: (error as Error).message });
        }
      }
    }

    if (includeFlow) {
      const existing = await readMoneyFlowCache(stock.dm);
      if (!force && existing.length >= moneyFlowRows) {
        summary.moneyFlow.skipped += 1;
        summary.moneyFlow.rows += existing.length;
      } else {
        try {
          const rows = await client.moneyFlow(stock.dm, moneyFlowRows);
          await writeMoneyFlowCache(stock.dm, rows);
          summary.moneyFlow.ok += 1;
          summary.moneyFlow.rows += rows.length;
        } catch (error) {
          summary.moneyFlow.failed += 1;
          if (summary.failures.length < 80) summary.failures.push({ instrument, frame: "money-flow", message: (error as Error).message });
        }
      }
    }

    const done = includeKLine
      ? summary.daily.ok + summary.daily.skipped + summary.daily.failed
      : summary.moneyFlow.ok + summary.moneyFlow.skipped + summary.moneyFlow.failed;
    if (done % 100 === 0) {
      await writeSummary(summary);
      console.log(
        `[research-data] ${done}/${universe.length} daily ok=${summary.daily.ok} skip=${summary.daily.skipped} failed=${summary.daily.failed} 30m ok=${summary.intraday30m.ok} skip=${summary.intraday30m.skipped} failed=${summary.intraday30m.failed} flow ok=${summary.moneyFlow.ok} skip=${summary.moneyFlow.skipped} failed=${summary.moneyFlow.failed}`
      );
    }
  }

  await writeSummary(summary);
  console.log(
    `[research-data] done daily=${summary.daily.ok}/${summary.daily.requested} 30m=${summary.intraday30m.ok}/${summary.intraday30m.requested} flow=${summary.moneyFlow.ok}/${summary.moneyFlow.requested} index=${summary.indexDaily.ok}/${summary.indexDaily.requested} apiRequests=${summary.api.requests}`
  );
}

await run();
