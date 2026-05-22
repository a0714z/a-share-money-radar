import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { KLine, StockListItem } from "../src/lib/types";
import type { BiyingClient } from "./biying-client";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

export type KLineFrame = "daily" | "30m";

function intEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function klineCacheRoot() {
  return resolve(root, process.env.KLINE_CACHE_DIR ?? ".cache/kline");
}

function frameDir(frame: KLineFrame) {
  return resolve(klineCacheRoot(), frame);
}

function stockListCachePath() {
  return resolve(klineCacheRoot(), "stock-list.json");
}

function cachePath(frame: KLineFrame, instrument: string) {
  return resolve(frameDir(frame), `${instrument.replace(/[^0-9A-Z.]/gi, "_")}.json`);
}

export function mergeKLines(...groups: KLine[][]) {
  const byTime = new Map<string, KLine>();
  for (const group of groups) {
    for (const bar of group) {
      if (bar?.t) byTime.set(String(bar.t), bar);
    }
  }
  return [...byTime.values()].sort((a, b) => String(a.t).localeCompare(String(b.t)));
}

export async function readKLineCache(frame: KLineFrame, instrument: string, limit?: number) {
  const path = cachePath(frame, instrument);
  if (!existsSync(path)) return [];
  try {
    const bars = JSON.parse(await readFile(path, "utf8")) as KLine[];
    const sorted = mergeKLines(bars);
    return limit ? sorted.slice(-limit) : sorted;
  } catch (error) {
    console.warn(`[kline-cache] read ${frame} ${instrument} skipped: ${(error as Error).message}`);
    return [];
  }
}

export async function writeKLineCache(frame: KLineFrame, instrument: string, bars: KLine[], maxBars?: number) {
  const path = cachePath(frame, instrument);
  const existing = await readKLineCache(frame, instrument);
  const keep = maxBars ?? intEnv(frame === "daily" ? "KLINE_DAILY_MAX_BARS" : "KLINE_30M_MAX_BARS", frame === "daily" ? 120 : 320);
  const merged = mergeKLines(existing, bars).slice(-keep);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(merged)}\n`, "utf8");
  return merged;
}

export async function readStockListCache() {
  const path = stockListCachePath();
  if (!existsSync(path)) return [];
  try {
    const stocks = JSON.parse(await readFile(path, "utf8")) as StockListItem[];
    return Array.isArray(stocks) ? stocks : [];
  } catch (error) {
    console.warn(`[kline-cache] stock list cache skipped: ${(error as Error).message}`);
    return [];
  }
}

export async function writeStockListCache(stocks: StockListItem[]) {
  await mkdir(dirname(stockListCachePath()), { recursive: true });
  await writeFile(stockListCachePath(), `${JSON.stringify(stocks)}\n`, "utf8");
}

export async function stockList(client: BiyingClient) {
  try {
    const stocks = await client.stockList();
    await writeStockListCache(stocks);
    return stocks;
  } catch (error) {
    const cached = await readStockListCache();
    if (cached.length) {
      console.warn(`[kline-cache] using cached stock list after API failure: ${(error as Error).message}`);
      return cached;
    }
    throw error;
  }
}

export async function dailyKLines(client: BiyingClient, instrument: string, limit: number) {
  const cached = await readKLineCache("daily", instrument, limit);
  if (cached.length >= Math.min(limit, 40)) return cached;
  const fetched = await client.history(instrument, limit);
  return (await writeKLineCache("daily", instrument, fetched, Math.max(limit, intEnv("KLINE_DAILY_MAX_BARS", 120)))).slice(-limit);
}

export async function thirtyMinuteKLines(client: BiyingClient, instrument: string, limit: number) {
  const cached = await readKLineCache("30m", instrument, limit);
  if (cached.length >= Math.min(limit, 48)) return cached;
  const [history30m, latest30m] = await Promise.all([
    client.history30m(instrument, limit).catch(() => []),
    client.latest30m(instrument, Math.min(limit, 96)).catch(() => [])
  ]);
  return (await writeKLineCache("30m", instrument, mergeKLines(history30m, latest30m), Math.max(limit, intEnv("KLINE_30M_MAX_BARS", 320)))).slice(-limit);
}
