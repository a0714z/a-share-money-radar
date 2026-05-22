import dotenv from "dotenv";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BiyingClient } from "./biying-client";
import { dailyKLines, stockList, thirtyMinuteKLines } from "./kline-cache";
import { average, clamp, last, movingAverage, pctChange, round } from "../src/lib/math";
import { scoreCandidate } from "../src/lib/scoring";
import type { KLine, PlanReport, RealQuote, StockListItem, StockPick } from "../src/lib/types";
import { inferExchange, isMainBoardNonSt, plainCode, toInstrumentCode } from "../src/lib/universe";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const outputPath = resolve(root, process.env.PLAN_REPORT_PATH ?? "public/reports/plan.json");

dotenv.config({ path: resolve(root, ".env.local"), override: false });
dotenv.config({ path: resolve(root, ".env"), override: false });

type PlanConfig = {
  historyDays: number;
  setupWindowDays: number;
  intraday30mBars: number;
  dailyCandidateLimit: number;
  topN: number;
  minAmount: number;
};

type DailySetup = {
  stock: StockListItem;
  instrument: string;
  history: KLine[];
  score: number;
  tradeDate: string;
  surgeDate: string;
  daysSinceSurge: number;
  surgePct: number;
  surgeAmountRatio: number;
  pullbackFromSurgeHigh: number;
  pullbackAmountRatio: number;
  heldBodyMidpoint: boolean;
  brokeSurgeLow: boolean;
  bearishVolumeDays: number;
  nearMa20: boolean;
  ma20?: number;
  ma60?: number;
  reasons: string[];
  risks: string[];
};

function intEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function configFromEnv(): PlanConfig {
  return {
    historyDays: intEnv("PLAN_HISTORY_DAYS", 80),
    setupWindowDays: intEnv("PLAN_SETUP_WINDOW_DAYS", 20),
    intraday30mBars: intEnv("PLAN_30M_BARS", 160),
    dailyCandidateLimit: intEnv("PLAN_DAILY_CANDIDATE_LIMIT", 260),
    topN: intEnv("PLAN_TOP_N", 40),
    minAmount: intEnv("PLAN_MIN_AMOUNT", 30_000_000)
  };
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

function normalizeDate(value?: string) {
  return String(value ?? "").slice(0, 10);
}

function byDateAsc<T extends { t?: string }>(items: T[]) {
  return [...items].sort((a, b) => String(a.t ?? "").localeCompare(String(b.t ?? "")));
}

function safeDivide(value: number, base: number, fallback = 0) {
  return Number.isFinite(value) && Number.isFinite(base) && base > 0 ? value / base : fallback;
}

function closeLocation(bar: KLine) {
  return clamp((bar.c - bar.l) / Math.max(0.01, bar.h - bar.l), 0, 1);
}

function mapLimit<T, R>(items: T[], limit: number, mapper: (item: T, index: number) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  }

  return Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker)).then(() => results);
}

function mergeKLines(...groups: KLine[][]) {
  const byTime = new Map<string, KLine>();
  for (const group of groups) {
    for (const bar of group) {
      if (bar?.t) byTime.set(String(bar.t), bar);
    }
  }
  return [...byTime.values()].sort((a, b) => String(a.t).localeCompare(String(b.t)));
}

async function writeReport(report: PlanReport) {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`[plan] wrote ${outputPath}`);
}

function evaluateDailySetup(stock: StockListItem, history: KLine[], minAmount: number, setupWindowDays: number): DailySetup | undefined {
  const bars = byDateAsc(history).filter((bar) => Number.isFinite(bar.c) && bar.c > 0 && bar.sf !== 1);
  if (bars.length < 40) return undefined;

  const latestIndex = bars.length - 1;
  const latest = bars[latestIndex];
  const previous = bars[latestIndex - 1];
  if (!latest || !previous || latest.a < minAmount) return undefined;

  const closes = bars.map((bar) => bar.c);
  const ma20 = last(movingAverage(closes, 20));
  const ma60 = last(movingAverage(closes, 60));
  let best: DailySetup | undefined;
  const start = Math.max(20, bars.length - setupWindowDays);

  for (let index = start; index <= latestIndex; index += 1) {
    const surge = bars[index];
    const before = bars[index - 1];
    if (!surge || !before) continue;

    const surgePct = pctChange(surge.c, before.c);
    const avgAmount20 = average(bars.slice(Math.max(0, index - 20), index).map((bar) => bar.a));
    const surgeAmountRatio = safeDivide(surge.a, avgAmount20, 0);
    const daysSinceSurge = latestIndex - index;
    if (surgePct < 7 || surgeAmountRatio < 2 || surge.c <= surge.o || closeLocation(surge) < 0.58 || daysSinceSurge > setupWindowDays) continue;

    const after = bars.slice(index + 1);
    const bodyMidpoint = (surge.o + surge.c) / 2;
    const pullbackFromSurgeHigh = clamp(((surge.h - latest.c) / surge.h) * 100, 0, 100);
    const recentPullbackBars = after.slice(-4);
    const pullbackAmountRatio = after.length ? safeDivide(average((recentPullbackBars.length ? recentPullbackBars : after).map((bar) => bar.a)), surge.a, 1) : 0;
    const brokeSurgeLow = Math.min(...(after.length ? after.map((bar) => bar.l) : [latest.l])) < surge.l * 0.995;
    const heldBodyMidpoint = latest.c >= bodyMidpoint * 0.99;
    const bearishVolumeDays = after.filter((bar) => bar.c < bar.o && bar.a >= surge.a * 0.65).length;
    const nearMa20 = ma20 ? Math.abs(pctChange(latest.c, ma20)) <= 7 : false;
    const aboveMa60 = ma60 ? latest.c >= ma60 * 0.97 : true;
    const shrinkScore = pullbackAmountRatio === 0 ? 8 : pullbackAmountRatio <= 0.55 ? 22 : pullbackAmountRatio <= 0.75 ? 15 : pullbackAmountRatio <= 0.95 ? 4 : -14;
    const pullbackScore =
      daysSinceSurge === 0
        ? 10
        : pullbackFromSurgeHigh >= 5 && pullbackFromSurgeHigh <= 18
          ? 22
          : pullbackFromSurgeHigh > 0 && pullbackFromSurgeHigh <= 24
            ? 10
            : -10;
    const supportScore = (heldBodyMidpoint ? 16 : -18) + (brokeSurgeLow ? -28 : 12) + (nearMa20 ? 8 : 0) + (aboveMa60 ? 6 : -10);
    const score = clamp(
      42 +
        Math.min(16, (surgePct - 7) * 1.6) +
        Math.min(16, (surgeAmountRatio - 2) * 4) +
        pullbackScore +
        shrinkScore +
        supportScore -
        bearishVolumeDays * 9 -
        Math.max(0, daysSinceSurge - 12) * 2
    );

    const reasons = [
      `${normalizeDate(surge.t)} 日K放量阳线 ${round(surgePct, 1)}% / ${round(surgeAmountRatio, 2)}x`,
      pullbackAmountRatio > 0 ? `启动后回调量能 ${round(pullbackAmountRatio, 2)}x` : "启动当日，等待盘中承接",
      heldBodyMidpoint ? "仍守住启动实体中位" : "接近启动实体中位",
      nearMa20 ? "靠近20日成本区" : "偏离20日成本区"
    ];
    const risks: string[] = [];
    if (brokeSurgeLow) risks.push("跌破启动日低点");
    if (!heldBodyMidpoint) risks.push("未守住启动实体中位");
    if (bearishVolumeDays) risks.push(`启动后出现 ${bearishVolumeDays} 根放量阴线`);
    if (!aboveMa60) risks.push("低于60日成本区");
    if (pullbackFromSurgeHigh > 24) risks.push("回撤偏深");

    const setup: DailySetup = {
      stock,
      instrument: toInstrumentCode(plainCode(stock.dm), inferExchange(stock.dm, stock.jys)),
      history: bars,
      score,
      tradeDate: normalizeDate(latest.t),
      surgeDate: normalizeDate(surge.t),
      daysSinceSurge,
      surgePct: round(surgePct, 1),
      surgeAmountRatio: round(surgeAmountRatio, 2),
      pullbackFromSurgeHigh: round(pullbackFromSurgeHigh, 1),
      pullbackAmountRatio: round(pullbackAmountRatio, 2),
      heldBodyMidpoint,
      brokeSurgeLow,
      bearishVolumeDays,
      nearMa20,
      ma20: ma20 ? round(ma20, 2) : undefined,
      ma60: ma60 ? round(ma60, 2) : undefined,
      reasons,
      risks
    };

    if (!best || setup.score > best.score) best = setup;
  }

  return best && best.score >= 58 ? best : undefined;
}

function quoteFromHistory(setup: DailySetup): RealQuote {
  const latest = last(setup.history)!;
  const previous = setup.history[setup.history.length - 2];
  return {
    dm: setup.stock.dm,
    o: latest.o,
    h: latest.h,
    l: latest.l,
    p: latest.c,
    yc: previous?.c,
    pc: previous ? pctChange(latest.c, previous.c) : 0,
    cje: latest.a,
    v: latest.v,
    lb: safeDivide(latest.a, average(setup.history.slice(-21, -1).map((bar) => bar.a)), 1),
    t: `${normalizeDate(latest.t)} 15:00:00`
  };
}

function planRank(pick: StockPick, setup: DailySetup) {
  return round(pick.score * 0.54 + setup.score * 0.34 + (pick.intradayBurst ? pick.intradayBurst.score * 0.12 : 0), 1);
}

function enrichPlanPick(pick: StockPick, setup: DailySetup): StockPick {
  const score = planRank(pick, setup);
  const risks = [...new Set([...setup.risks, ...pick.risks])];
  const reasons = [...new Set([...setup.reasons, ...pick.reasons])].slice(0, 7);
  const signal = score >= 76 && risks.length <= 3 ? "strong" : score >= 64 ? "watch" : "wait";
  return {
    ...pick,
    score,
    signal,
    rating: signal === "strong" ? "预案重点" : signal === "watch" ? "预案观察" : "风险跟踪",
    reasons,
    risks
  };
}

async function runPlan() {
  const license = process.env.BIYING_LICENSE;
  if (!license) throw new Error("Missing BIYING_LICENSE. Set it in .env.local or /etc/a-share-money-radar.env.");

  const config = configFromEnv();
  const client = new BiyingClient(license);
  console.log("[plan] fetching stock list");
  const listed = await stockList(client);
  const universe = listed.filter(isMainBoardNonSt).map((stock) => ({ ...stock, dm: plainCode(stock.dm), jys: inferExchange(stock.dm, stock.jys) }));

  console.log(`[plan] daily prefilter ${universe.length} stocks`);
  const dailySetups = await mapLimit(universe, 16, async (stock, index) => {
    try {
      const history = await dailyKLines(client, toInstrumentCode(stock.dm, inferExchange(stock.dm, stock.jys)), config.historyDays);
      if ((index + 1) % 200 === 0) console.log(`[plan] daily ${index + 1}/${universe.length}`);
      return evaluateDailySetup(stock, history, config.minAmount, config.setupWindowDays);
    } catch (error) {
      console.warn(`[plan] daily skip ${stock.dm} ${stock.mc}: ${(error as Error).message}`);
      return undefined;
    }
  });

  const dailyCandidates = dailySetups
    .filter((item): item is DailySetup => Boolean(item))
    .sort((a, b) => b.score - a.score)
    .slice(0, config.dailyCandidateLimit);

  console.log(`[plan] 30m + flow refine ${dailyCandidates.length} stocks`);
  const refined = await mapLimit(dailyCandidates, 18, async (setup, index) => {
    try {
      const code = plainCode(setup.stock.dm);
      const [intraday30m, flows] = await Promise.all([
        thirtyMinuteKLines(client, setup.instrument, config.intraday30mBars).catch(() => []),
        client.moneyFlow(code, 10)
      ]);
      const pick = scoreCandidate({ stock: setup.stock, quote: quoteFromHistory(setup), history: setup.history, intraday30m, flows });
      if ((index + 1) % 30 === 0) console.log(`[plan] refined ${index + 1}/${dailyCandidates.length}`);
      return pick ? enrichPlanPick(pick, setup) : undefined;
    } catch (error) {
      console.warn(`[plan] refine skip ${setup.instrument} ${setup.stock.mc}: ${(error as Error).message}`);
      return undefined;
    }
  });

  const ranked = refined
    .filter((item): item is StockPick => Boolean(item))
    .sort((a, b) => b.score - a.score)
    .map((pick, index) => ({ ...pick, rank: index + 1 }));
  const plans = ranked.filter((pick) => pick.signal === "strong").slice(0, config.topN);
  const watchlist = ranked.filter((pick) => pick.signal === "watch").slice(0, Math.max(config.topN, 30));
  const avoided = ranked.filter((pick) => pick.signal === "wait").slice(0, 30);
  const tradeDate = ranked[0]?.updatedAt?.slice(0, 10) ?? dailyCandidates[0]?.tradeDate ?? new Date().toISOString().slice(0, 10);

  await writeReport({
    meta: {
      generatedAt: chinaDateTime(),
      tradeDate,
      source: "Biying API",
      mode: "live",
      lookbackDays: config.historyDays,
      setupWindowDays: config.setupWindowDays,
      intraday30mBars: config.intraday30mBars,
      notes: [
        `预案只在最近 ${config.setupWindowDays} 个交易日内寻找爆量阳线后的缩量回调、承接和成本区，再用30m K线确认承接、二次突破和放量阴线风险。`,
        "预案用于盘前准备；盘中分钟扫描只负责验证触发、失效和风险升级。"
      ]
    },
    summary: {
      universe: universe.length,
      dailyScored: universe.length,
      dailyCandidates: dailyCandidates.length,
      intradayScored: ranked.length,
      plans: plans.length,
      watch: watchlist.length,
      risk: avoided.length
    },
    plans,
    watchlist,
    avoided
  });
}

await runPlan();
