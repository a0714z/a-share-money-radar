import dotenv from "dotenv";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BiyingClient } from "./biying-client";
import { sampleReport } from "../src/data/sample-report";
import { evaluateMarketRegime, MARKET_INDEXES } from "../src/lib/market-regime";
import { round } from "../src/lib/math";
import { scoreCandidate } from "../src/lib/scoring";
import { attachSector, buildConcentrationReport, downgradeForConcentration } from "../src/lib/sector";
import type {
  DataQuality,
  DailyChangeItem,
  KLine,
  MarketRegime,
  RealQuote,
  ScanReport,
  SectorChange,
  SectorConcentrationReport,
  Signal,
  StockListItem,
  StockPick
} from "../src/lib/types";
import { isMainBoardNonSt, toInstrumentCode, inferExchange, plainCode } from "../src/lib/universe";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const outputPath = resolve(root, "public/reports/latest.json");
const historyDir = resolve(root, "public/reports/history");

dotenv.config({ path: resolve(root, ".env.local"), override: false });
dotenv.config({ path: resolve(root, ".env"), override: false });

type ScanConfig = {
  topN: number;
  historyDays: number;
  intraday30mDays: number;
  flowDays: number;
  flowCandidateLimit: number;
  minAmount: number;
  maxPerSector: number;
};

type RoughCandidate = {
  stock: StockListItem;
  quote: RealQuote;
  rough: number;
};

function intEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function configFromEnv(): ScanConfig {
  return {
    topN: intEnv("SCAN_TOP_N", 8),
    historyDays: intEnv("SCAN_HISTORY_DAYS", 120),
    intraday30mDays: intEnv("SCAN_30M_BARS", 96),
    flowDays: intEnv("SCAN_FLOW_DAYS", 10),
    flowCandidateLimit: intEnv("SCAN_FLOW_CANDIDATE_LIMIT", 420),
    minAmount: intEnv("SCAN_MIN_AMOUNT", 30_000_000),
    maxPerSector: intEnv("SCAN_MAX_PER_SECTOR", 2)
  };
}

async function writeReport(report: ScanReport) {
  const archivePath = resolve(historyDir, `${report.meta.tradeDate}.json`);
  await mkdir(dirname(outputPath), { recursive: true });
  await mkdir(historyDir, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(archivePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`[scan] wrote ${outputPath}`);
  console.log(`[scan] archived ${archivePath}`);
}

async function mapLimit<T, R>(items: T[], limit: number, mapper: (item: T, index: number) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function roughSetupScore(stock: StockListItem, quote: RealQuote, minAmount: number) {
  const code = plainCode(stock.dm);
  const amount = Number(quote.cje ?? 0);
  if (amount < minAmount || !quote.p || quote.p <= 0) return -Infinity;

  const pct = Number(quote.pc ?? 0);
  const zdf60 = Number(quote.zdf60 ?? 0);
  const turnover = Number(quote.hs ?? quote.tr ?? 0);
  const volumeRatio = Number(quote.lb ?? 0);
  const marketCap = Number(quote.lt ?? quote.sz ?? 0);
  const high = Number(quote.h ?? quote.p);
  const low = Number(quote.l ?? quote.p);
  const closeLocation = Math.max(0, Math.min(1, (Number(quote.p) - low) / Math.max(0.01, high - low)));
  const boardBonus = code.startsWith("6") || code.startsWith("000") ? 4 : 0;
  const burstProxy = pct >= 2.5 && volumeRatio >= 2.5 ? 20 : 0;
  const notChasing = pct < 6.5 ? 18 : volumeRatio >= 2.5 && closeLocation >= 0.55 ? 4 : -18;
  const mediumTermValue = zdf60 < 35 && zdf60 > -35 ? 18 - Math.abs(zdf60) * 0.2 : -10;
  const liquidity = Math.min(24, Math.log10(Math.max(amount, 1)) * 3);
  const turnoverScore = turnover >= 0.6 && turnover <= 7 ? 18 : turnover > 10 ? -12 : 6;
  const volumeScore = volumeRatio >= 0.8 && volumeRatio <= 2.3 ? 14 : volumeRatio > 3.5 ? -10 : volumeRatio < 0.45 ? -5 : 4;
  const closeStrength = closeLocation >= 0.58 ? 10 : closeLocation >= 0.38 ? 4 : -8;
  const badVolumePrice = (pct < -2.5 && volumeRatio > 1.4 ? -16 : 0) + (pct > 5.2 && volumeRatio > 2.8 && closeLocation < 0.55 ? -10 : 0);
  const healthyVolumePrice = pct > -1.5 && pct < 4.8 && volumeRatio >= 0.75 && volumeRatio <= 2.4 ? 8 : 0;
  const pullbackProxy = pct > -4.5 && pct < 3.5 && volumeRatio >= 0.45 && volumeRatio <= 1.45 ? 8 : 0;
  const capScore = marketCap >= 2_000_000_000 ? 6 : -8;
  return boardBonus + notChasing + mediumTermValue + liquidity + turnoverScore + volumeScore + closeStrength + healthyVolumePrice + burstProxy + pullbackProxy + badVolumePrice + capScore;
}

function attachRanks(items: StockPick[]) {
  return items.map((item, index) => ({ ...item, rank: index + 1 }));
}

async function readJson<T>(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function readHistoryReports() {
  if (!existsSync(historyDir)) return [];
  const files = (await readdir(historyDir)).filter((file) => file.endsWith(".json")).sort();
  const reports: ScanReport[] = [];
  for (const file of files) {
    try {
      reports.push(await readJson<ScanReport>(resolve(historyDir, file)));
    } catch (error) {
      console.warn(`[scan] history ${file} skipped: ${(error as Error).message}`);
    }
  }
  return reports.sort((a, b) => a.meta.tradeDate.localeCompare(b.meta.tradeDate));
}

function allReportPicks(report: ScanReport) {
  return [...report.picks, ...report.watchlist, ...report.avoided];
}

function pickSignal(report: ScanReport, instrument: string): Signal | undefined {
  return allReportPicks(report).find((pick) => pick.instrument === instrument)?.signal;
}

function changeItem(pick: StockPick, previous?: StockPick, consecutiveStrongDays?: number): DailyChangeItem {
  return {
    code: pick.code,
    instrument: pick.instrument,
    name: pick.name,
    sector: pick.sector,
    currentRank: pick.rank,
    previousRank: previous?.rank,
    currentSignal: pick.signal,
    previousSignal: previous?.signal,
    currentSetupState: pick.setupState,
    previousSetupState: previous?.setupState,
    setupAgeDays: pick.setupAgeDays,
    score: pick.score,
    flowRatio5d: pick.flowRatio5d,
    consecutiveStrongDays
  };
}

function sectorCounts(picks: StockPick[]) {
  const counts = new Map<string, number>();
  for (const pick of picks) {
    const sector = pick.sector ?? "其他";
    counts.set(sector, (counts.get(sector) ?? 0) + 1);
  }
  return counts;
}

function buildSectorChanges(current: ScanReport, previous?: ScanReport): SectorChange[] {
  const currentCounts = sectorCounts(current.picks);
  const previousCounts = sectorCounts(previous?.picks ?? []);
  const sectors = new Set([...currentCounts.keys(), ...previousCounts.keys()]);

  return [...sectors]
    .map((sector) => {
      const currentStrong = currentCounts.get(sector) ?? 0;
      const previousStrong = previousCounts.get(sector) ?? 0;
      return { sector, currentStrong, previousStrong, delta: currentStrong - previousStrong };
    })
    .filter((item) => item.currentStrong || item.previousStrong)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || b.currentStrong - a.currentStrong)
    .slice(0, 8);
}

function consecutiveStrongDays(instrument: string, current: ScanReport, history: ScanReport[]) {
  let days = current.picks.some((pick) => pick.instrument === instrument) ? 1 : 0;
  if (!days) return 0;

  for (const report of [...history].filter((item) => item.meta.tradeDate < current.meta.tradeDate).sort((a, b) => b.meta.tradeDate.localeCompare(a.meta.tradeDate))) {
    if (!report.picks.some((pick) => pick.instrument === instrument)) break;
    days += 1;
  }
  return days;
}

function isActiveSetup(pick?: StockPick) {
  return Boolean(pick?.setupState && pick.setupState !== "常规观察");
}

function setupRankOf(pick?: StockPick) {
  if (!isActiveSetup(pick)) return 0;
  return pick?.setupStateRank ?? 0;
}

function isWeakSetupState(state?: StockPick["setupState"]) {
  return state === "承接转弱" || state === "放量派发风险";
}

function isInvalidSetupState(state?: StockPick["setupState"]) {
  return state === "跌破失效";
}

function isPositiveNonBreakoutSetup(pick?: StockPick) {
  return isActiveSetup(pick) && pick?.setupState !== "二次突破" && !isWeakSetupState(pick?.setupState) && !isInvalidSetupState(pick?.setupState);
}

function sortChangeItems(items: DailyChangeItem[]) {
  return items.sort((a, b) => (a.currentRank ?? 999) - (b.currentRank ?? 999) || (b.score ?? 0) - (a.score ?? 0));
}

function annotateSetupTracking(picks: StockPick[], history: ScanReport[], currentTradeDate: string) {
  const reports = [...history]
    .filter((report) => report.meta.tradeDate < currentTradeDate)
    .sort((a, b) => b.meta.tradeDate.localeCompare(a.meta.tradeDate));

  return picks.map((pick) => {
    if (!isActiveSetup(pick)) return { ...pick, setupAgeDays: 0 };

    let setupAgeDays = 1;
    let setupPreviousState: StockPick["setupState"] | undefined;

    for (const report of reports) {
      const previous = allReportPicks(report).find((item) => item.instrument === pick.instrument);
      if (!setupPreviousState && previous?.setupState) setupPreviousState = previous.setupState;
      if (!isActiveSetup(previous)) break;
      setupAgeDays += 1;
    }

    return {
      ...pick,
      setupAgeDays,
      setupPreviousState,
      setupStateChanged: Boolean(setupPreviousState && setupPreviousState !== pick.setupState)
    };
  });
}

function buildChangeSummary(current: ScanReport, history: ScanReport[]): ScanReport["changes"] {
  const previous = [...history]
    .filter((report) => report.meta.tradeDate < current.meta.tradeDate)
    .sort((a, b) => b.meta.tradeDate.localeCompare(a.meta.tradeDate))[0];

  if (!previous) {
    const firstSetupChanges = allReportPicks(current).map((pick) => ({ pick, previous: undefined }));
    const newSetups = sortChangeItems(firstSetupChanges.filter(({ pick }) => isPositiveNonBreakoutSetup(pick)).map(({ pick }) => changeItem(pick))).slice(0, 20);
    const breakoutSetups = sortChangeItems(firstSetupChanges.filter(({ pick }) => pick.setupState === "二次突破").map(({ pick }) => changeItem(pick))).slice(0, 20);
    const weakenedSetups = sortChangeItems(firstSetupChanges.filter(({ pick }) => isWeakSetupState(pick.setupState)).map(({ pick }) => changeItem(pick))).slice(0, 20);
    const invalidatedSetups = sortChangeItems(firstSetupChanges.filter(({ pick }) => isInvalidSetupState(pick.setupState)).map(({ pick }) => changeItem(pick))).slice(0, 20);

    return {
      strongCountChange: current.picks.length,
      headline: `今日强关注 ${current.picks.length} 只，暂无上一交易日报告可对比。`,
      newStrong: current.picks.map((pick) => changeItem(pick)),
      upgradedToStrong: [],
      consecutiveStrong: [],
      downgradedFromStrong: [],
      exitedStrong: [],
      newSetups,
      strengthenedSetups: [],
      breakoutSetups,
      weakenedSetups,
      invalidatedSetups,
      sectorChanges: buildSectorChanges(current),
      notes: ["首次生成变化摘要，后续交易日会显示新晋、降级和连续入选。"]
    };
  }

  const previousByInstrument = new Map(allReportPicks(previous).map((pick) => [pick.instrument, pick]));
  const currentByInstrument = new Map(allReportPicks(current).map((pick) => [pick.instrument, pick]));
  const previousStrong = new Set(previous.picks.map((pick) => pick.instrument));
  const currentStrong = new Set(current.picks.map((pick) => pick.instrument));
  const newStrong = current.picks.filter((pick) => !previousByInstrument.has(pick.instrument)).map((pick) => changeItem(pick));
  const upgradedToStrong = current.picks
    .filter((pick) => previousByInstrument.has(pick.instrument) && pickSignal(previous, pick.instrument) !== "strong")
    .map((pick) => changeItem(pick, previousByInstrument.get(pick.instrument)));
  const consecutiveStrong = current.picks
    .filter((pick) => previousStrong.has(pick.instrument))
    .map((pick) => changeItem(pick, previousByInstrument.get(pick.instrument), consecutiveStrongDays(pick.instrument, current, history)))
    .sort((a, b) => (b.consecutiveStrongDays ?? 0) - (a.consecutiveStrongDays ?? 0) || (a.currentRank ?? 0) - (b.currentRank ?? 0));
  const downgradedFromStrong = previous.picks
    .filter((pick) => currentByInstrument.has(pick.instrument) && !currentStrong.has(pick.instrument))
    .map((pick) => changeItem(currentByInstrument.get(pick.instrument)!, pick));
  const exitedStrong = previous.picks
    .filter((pick) => !currentByInstrument.has(pick.instrument))
    .map((pick) => ({
      ...changeItem(pick, pick),
      currentSignal: undefined,
      previousSignal: "strong" as const
    }));
  const setupChanges = allReportPicks(current).map((pick) => ({
    pick,
    previous: previousByInstrument.get(pick.instrument)
  }));
  const newSetups = sortChangeItems(
    setupChanges.filter(({ pick, previous }) => isPositiveNonBreakoutSetup(pick) && !isActiveSetup(previous)).map(({ pick, previous }) => changeItem(pick, previous))
  ).slice(0, 20);
  const strengthenedSetups = sortChangeItems(
    setupChanges
      .filter(
        ({ pick, previous }) =>
          isPositiveNonBreakoutSetup(pick) &&
          isActiveSetup(previous) &&
          setupRankOf(pick) > setupRankOf(previous)
      )
      .map(({ pick, previous }) => changeItem(pick, previous))
  ).slice(0, 20);
  const breakoutSetups = sortChangeItems(
    setupChanges
      .filter(({ pick, previous }) => pick.setupState === "二次突破" && previous?.setupState !== "二次突破")
      .map(({ pick, previous }) => changeItem(pick, previous))
  ).slice(0, 20);
  const weakenedSetups = sortChangeItems(
    setupChanges
      .filter(({ pick, previous }) => isWeakSetupState(pick.setupState) && previous?.setupState !== pick.setupState)
      .map(({ pick, previous }) => changeItem(pick, previous))
  ).slice(0, 20);
  const invalidatedSetups = sortChangeItems(
    setupChanges
      .filter(({ pick, previous }) => isInvalidSetupState(pick.setupState) && previous?.setupState !== "跌破失效")
      .map(({ pick, previous }) => changeItem(pick, previous))
  ).slice(0, 20);
  const strongCountChange = current.picks.length - previous.picks.length;
  const sectorChanges = buildSectorChanges(current, previous);
  const topSector = sectorChanges.find((item) => item.currentStrong > 0);
  const deltaText = strongCountChange > 0 ? `增加 ${strongCountChange}` : strongCountChange < 0 ? `减少 ${Math.abs(strongCountChange)}` : "持平";
  const positiveSetupChanges = newSetups.length + strengthenedSetups.length + breakoutSetups.length;
  const negativeSetupChanges = weakenedSetups.length + invalidatedSetups.length;
  const headline = [
    `今日强关注 ${current.picks.length} 只，较 ${previous.meta.tradeDate} ${deltaText}`,
    `新晋 ${newStrong.length + upgradedToStrong.length} 只`,
    `连续入选 ${consecutiveStrong.length} 只`,
    `降级/退出 ${downgradedFromStrong.length + exitedStrong.length} 只`,
    `阶段转强 ${positiveSetupChanges} 只`,
    negativeSetupChanges ? `转弱/失效 ${negativeSetupChanges} 只` : "",
    topSector ? `${topSector.sector} 当前 ${topSector.currentStrong} 只` : ""
  ]
    .filter(Boolean)
    .join("；");

  return {
    previousTradeDate: previous.meta.tradeDate,
    strongCountChange,
    headline,
    newStrong,
    upgradedToStrong,
    consecutiveStrong,
    downgradedFromStrong,
    exitedStrong,
    newSetups,
    strengthenedSetups,
    breakoutSetups,
    weakenedSetups,
    invalidatedSetups,
    sectorChanges,
    notes: [
      "新晋包含上一交易日未进入候选池、今日进入强关注的标的。",
      "连续入选只统计核心强关注池。",
      "阶段变化按上一交易日候选池对比，突出新异动、承接转强、二次突破、承接转弱与跌破失效。"
    ]
  };
}

function tradeDateFromPicks(picks: StockPick[]) {
  const updated = picks.find((pick) => pick.updatedAt)?.updatedAt;
  return updated ? updated.slice(0, 10) : new Date().toISOString().slice(0, 10);
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

function chinaTradeDate(date = new Date()) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  })
    .format(date)
    .replace(/\//g, "-");
}

function keepPreviousReport(reason: string) {
  if (!existsSync(outputPath)) return false;
  console.warn(`[scan] ${reason}`);
  console.warn(`[scan] keeping existing report at ${outputPath}`);
  return true;
}

function quoteDate(value?: string) {
  return String(value ?? "").slice(0, 10);
}

function hasPositive(value?: number) {
  return Number.isFinite(value) && Number(value) > 0;
}

function buildDataQuality(args: { quotes: RealQuote[]; universe: StockListItem[]; quoteByCode: Map<string, RealQuote> }): DataQuality {
  const universeQuotes = args.universe.map((stock) => args.quoteByCode.get(plainCode(stock.dm))).filter((quote): quote is RealQuote => Boolean(quote));
  const latestQuote = [...universeQuotes]
    .filter((quote) => quote.t)
    .sort((a, b) => String(b.t).localeCompare(String(a.t)))[0];
  const latestQuoteTime = latestQuote?.t;
  const latestQuoteDate = quoteDate(latestQuoteTime);
  const today = chinaTradeDate();
  const validQuotes = universeQuotes.filter((quote) => hasPositive(quote.p) && hasPositive(quote.cje)).length;
  const denominator = Math.max(1, universeQuotes.length);
  const missingAmount = universeQuotes.filter((quote) => !hasPositive(quote.cje)).length;
  const missingTurnover = universeQuotes.filter((quote) => !hasPositive(quote.hs) && !hasPositive(quote.tr)).length;
  const missingVolume = universeQuotes.filter((quote) => !hasPositive(quote.lb)).length;
  const validQuoteRatio = validQuotes / denominator;
  const missingAmountRatio = missingAmount / denominator;
  const missingTurnoverRatio = missingTurnover / denominator;
  const missingVolumeRatio = missingVolume / denominator;
  const notes: string[] = [];

  if (latestQuoteDate && latestQuoteDate < today) notes.push(`最新行情日期 ${latestQuoteDate} 早于当前日期 ${today}`);
  if (validQuoteRatio < 0.15) notes.push("有效成交报价比例极低，可能处于盘前或接口未完成刷新");
  if (missingAmountRatio > 0.5) notes.push("多数主板标的缺少成交额");
  if (missingTurnoverRatio > 0.5) notes.push("多数主板标的缺少换手率");
  if (missingVolumeRatio > 0.5) notes.push("多数主板标的缺少量比，页面会优先参考成交额倍数");

  const status: DataQuality["status"] =
    validQuoteRatio < 0.15
      ? "pre_open"
      : latestQuoteDate && latestQuoteDate < today
        ? "stale"
        : missingAmountRatio > 0.35 || missingTurnoverRatio > 0.35
          ? "partial"
          : "ok";
  const label = status === "ok" ? "正常" : status === "partial" ? "部分缺失" : status === "stale" ? "行情滞后" : "盘前/无成交";

  return {
    status,
    label,
    generatedAt: chinaDateTime(),
    latestQuoteTime,
    quoteDate: latestQuoteDate || undefined,
    totalQuotes: args.quotes.length,
    universeQuotes: universeQuotes.length,
    validQuotes,
    validQuoteRatio: round(validQuoteRatio * 100, 1),
    missingAmountRatio: round(missingAmountRatio * 100, 1),
    missingTurnoverRatio: round(missingTurnoverRatio * 100, 1),
    missingVolumeRatio: round(missingVolumeRatio * 100, 1),
    notes
  };
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

function chinaDateCompact(daysOffset = 0) {
  const date = new Date(Date.now() + daysOffset * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  })
    .format(date)
    .replace(/\//g, "");
}

function hasUsableQuote(item: { stock: StockListItem; quote?: RealQuote; rough: number }): item is RoughCandidate {
  return Boolean(item.quote) && Number.isFinite(item.rough);
}

async function loadMarketRegime(client: BiyingClient) {
  const histories: Record<string, KLine[]> = {};
  const start = chinaDateCompact(-520);
  const end = chinaDateCompact(0);

  await Promise.all(
    MARKET_INDEXES.map(async (index) => {
      try {
        histories[index.code] = await client.indexHistory(index.code, start, end);
      } catch (error) {
        console.warn(`[scan] market index ${index.code} skipped: ${(error as Error).message}`);
      }
    })
  );

  return evaluateMarketRegime(histories);
}

function downgradeToWatch(pick: StockPick, risk: string): StockPick {
  return {
    ...pick,
    signal: "watch",
    rating: "观察",
    risks: pick.risks.includes(risk) ? pick.risks : [...pick.risks, risk]
  };
}

async function enrichSectors(client: BiyingClient, ranked: StockPick[]) {
  const targets = ranked.filter((pick) => pick.signal === "strong" || pick.score >= 72).slice(0, 100);
  const enriched = new Map<string, StockPick>();

  await mapLimit(targets, 24, async (pick) => {
    try {
      const profile = await client.companyProfile(pick.code);
      enriched.set(pick.instrument, attachSector(pick, profile));
    } catch (error) {
      console.warn(`[scan] profile ${pick.instrument} skipped: ${(error as Error).message}`);
      enriched.set(pick.instrument, attachSector(pick));
    }
  });

  return ranked.map((pick) => enriched.get(pick.instrument) ?? attachSector(pick));
}

function annotateStrongConcentration(strong: StockPick[], maxPerSector: number) {
  const groups = new Map<string, StockPick[]>();
  for (const pick of strong) {
    const sector = pick.sector ?? "其他";
    groups.set(sector, [...(groups.get(sector) ?? []), pick]);
  }

  return strong.map((pick) => {
    const sector = pick.sector ?? "其他";
    const group = groups.get(sector) ?? [];
    const groupRank = group.findIndex((item) => item.instrument === pick.instrument) + 1;
    return {
      ...pick,
      concentration: {
        sector,
        groupRank,
        groupSize: group.length,
        maxPerSector,
        demoted: false
      }
    };
  });
}

function selectCoreBySector(strong: StockPick[], coreLimit: number, maxPerSector: number, capReason: string) {
  const picks: StockPick[] = [];
  const sectorDemoted: StockPick[] = [];
  const capacityDemoted: StockPick[] = [];
  const counts = new Map<string, number>();

  for (const pick of annotateStrongConcentration(strong, maxPerSector)) {
    const sector = pick.sector ?? "其他";
    const current = counts.get(sector) ?? 0;

    if (picks.length >= coreLimit) {
      capacityDemoted.push(downgradeToWatch(pick, capReason));
    } else if (current >= maxPerSector) {
      sectorDemoted.push(downgradeForConcentration(pick, maxPerSector));
    } else {
      picks.push(pick);
      counts.set(sector, current + 1);
    }
  }

  return { picks, sectorDemoted, capacityDemoted };
}

function isSurgePullbackPick(pick: StockPick) {
  return pick.reasons.some(
    (reason) => reason.includes("30m") || reason.includes("日量为前日") || reason.includes("倍量启动") || reason.includes("回调缩量") || reason.includes("回踩")
  );
}

function buildWatchlist(items: StockPick[], limit: number) {
  const setup = items.filter(isSurgePullbackPick).sort((a, b) => (b.setupStateRank ?? 0) - (a.setupStateRank ?? 0) || b.score - a.score);
  const regular = items.filter((item) => !isSurgePullbackPick(item)).sort((a, b) => b.score - a.score);
  return [...setup, ...regular].slice(0, limit);
}

function selectPicksByMarket(ranked: StockPick[], market: MarketRegime, topN: number, maxPerSector: number) {
  const strong = ranked.filter((item) => item.signal === "strong");
  const watch = ranked.filter((item) => item.signal === "watch");
  const wait = ranked.filter((item) => item.signal === "wait");
  let concentration: SectorConcentrationReport = buildConcentrationReport(strong, [], [], maxPerSector);

  if (market.action === "observe_only") {
    const demoted = strong.map((pick) => downgradeToWatch(pick, "市场弱势，暂停强关注"));
    concentration = buildConcentrationReport(strong, [], [], maxPerSector);
    return {
      picks: [],
      watchlist: buildWatchlist([...demoted, ...watch], Math.max(20, topN)),
      avoided: wait.slice(0, 25),
      concentration
    };
  }

  const coreLimit = market.action === "cap_core" ? Math.min(topN, 5) : topN;
  const capReason = market.action === "cap_core" ? "市场震荡，核心池上限收紧" : "核心池名额已满";
  const { picks, sectorDemoted, capacityDemoted } = selectCoreBySector(strong, coreLimit, maxPerSector, capReason);
  concentration = buildConcentrationReport(strong, picks, sectorDemoted, maxPerSector);

  return {
    picks,
    watchlist: buildWatchlist([...sectorDemoted, ...capacityDemoted, ...watch], Math.max(20, topN)),
    avoided: wait.slice(0, 25),
    concentration
  };
}

async function liveScan() {
  const license = process.env.BIYING_LICENSE;
  if (!license) throw new Error("Missing BIYING_LICENSE. Copy .env.example to .env.local or export it before running.");

  const config = configFromEnv();
  const client = new BiyingClient(license);
  const market = await loadMarketRegime(client);

  console.log("[scan] fetching stock list");
  const listed = await client.stockList();
  const universe = listed.filter(isMainBoardNonSt);
  const stockByCode = new Map(universe.map((stock) => [plainCode(stock.dm), stock]));

  console.log("[scan] fetching all realtime quotes");
  const quotes = await client.allRealtime();
  const quoteByCode = new Map(quotes.map((quote) => [plainCode(quote.dm), quote]));
  const dataQuality = buildDataQuality({ quotes, universe, quoteByCode });

  const roughCandidates = universe
    .map((stock) => {
      const code = plainCode(stock.dm);
      const quote = quoteByCode.get(code);
      const normalizedStock: StockListItem = { ...stock, dm: code, jys: inferExchange(stock.dm, stock.jys) };
      return {
        stock: normalizedStock,
        quote,
        rough: quote ? roughSetupScore(normalizedStock, quote, config.minAmount) : -Infinity
      };
    })
    .filter(hasUsableQuote)
    .sort((a, b) => b.rough - a.rough)
    .slice(0, config.flowCandidateLimit);

  if (!roughCandidates.length) {
    const quoteTime = quotes.find((quote) => quote.t)?.t ?? "unknown";
    const message = `No scan candidates found at ${quoteTime}. Data quality: ${dataQuality.label}, valid quotes ${dataQuality.validQuoteRatio}%.`;
    if (keepPreviousReport(message)) return;
    throw new Error(`${message} No previous report exists.`);
  }

  console.log(`[scan] scoring ${roughCandidates.length} candidates with history + money flow`);
  const scored = await mapLimit(roughCandidates, 24, async ({ stock, quote }, index) => {
    const exchange = inferExchange(stock.dm, stock.jys);
    const instrument = toInstrumentCode(stock.dm, exchange);
    try {
      const code = plainCode(stock.dm);
      const [history, history30m, latest30m, flows] = await Promise.all([
        client.history(instrument, config.historyDays),
        client.history30m(instrument, config.intraday30mDays).catch((error) => {
          console.warn(`[scan] 30m history ${instrument} skipped: ${(error as Error).message}`);
          return [];
        }),
        client.latest30m(instrument, Math.min(config.intraday30mDays, 96)).catch((error) => {
          console.warn(`[scan] 30m latest ${instrument} skipped: ${(error as Error).message}`);
          return [];
        }),
        client.moneyFlow(code, config.flowDays)
      ]);
      const intraday30m = mergeKLines(history30m, latest30m).slice(-Math.max(config.intraday30mDays, latest30m.length));
      const pick = scoreCandidate({ stock, quote, history, intraday30m, flows });
      if ((index + 1) % 25 === 0) console.log(`[scan] processed ${index + 1}/${roughCandidates.length}`);
      return pick;
    } catch (error) {
      console.warn(`[scan] skip ${stock.dm} ${stock.mc}: ${(error as Error).message}`);
      return null;
    }
  });

  const sorted = scored
    .filter((item): item is StockPick => Boolean(item))
    .sort((a, b) => b.score - a.score);
  const historyReports = await readHistoryReports();
  const currentTradeDate = tradeDateFromPicks(sorted);
  const ranked = attachRanks(annotateSetupTracking(await enrichSectors(client, sorted), historyReports, currentTradeDate));

  if (!ranked.length) {
    const message = "No candidates could be scored.";
    if (keepPreviousReport(message)) return;
    throw new Error(`${message} No previous report exists.`);
  }

  const { picks, watchlist, avoided, concentration } = selectPicksByMarket(ranked, market, config.topN, config.maxPerSector);

  const report: ScanReport = {
    meta: {
      generatedAt: chinaDateTime(),
      tradeDate: currentTradeDate,
      source: "Biying API",
      mode: "live",
      docsUrl: "https://www.biyingapi.com/doc_hs",
      nextRunHint: "交易日 22:15 Asia/Shanghai",
      notes: [
        "主板代码前缀过滤：000/001/002/003/600/601/603/605",
        "剔除名称包含 ST、*ST、退 的标的",
        "评分侧重近5个交易日内30m爆量大涨、对应日K成交额较前日3倍以上、资金连续性和成本区位置",
        `大盘环境：${market.label}，${market.reasons.join("；")}`,
        `行业集中度：同一主题核心池最多 ${config.maxPerSector} 只，${concentration.applied ? `已降级 ${concentration.demoted} 只` : "未触发降级"}`
      ]
    },
    universe: {
      listed: listed.length,
      mainBoardNonSt: universe.length,
      quoted: universe.filter((stock) => stockByCode.has(plainCode(stock.dm)) && quoteByCode.has(plainCode(stock.dm))).length,
      candidates: roughCandidates.length,
      scored: ranked.length,
      strong: picks.length,
      watch: watchlist.length
    },
    market,
    dataQuality,
    concentration,
    picks,
    watchlist,
    avoided
  };
  report.changes = buildChangeSummary(report, historyReports);

  await writeReport(report);
}

const args = new Set(process.argv.slice(2));
if (args.has("--sample")) {
  await writeReport(sampleReport);
} else {
  await liveScan();
}