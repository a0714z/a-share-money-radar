import dotenv from "dotenv";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BiyingClient } from "./biying-client";
import { sampleReport } from "../src/data/sample-report";
import { evaluateMarketRegime, MARKET_INDEXES } from "../src/lib/market-regime";
import { scoreCandidate } from "../src/lib/scoring";
import { attachSector, buildConcentrationReport, downgradeForConcentration } from "../src/lib/sector";
import type { KLine, MarketRegime, RealQuote, ScanReport, SectorConcentrationReport, StockListItem, StockPick } from "../src/lib/types";
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
    flowDays: intEnv("SCAN_FLOW_DAYS", 10),
    flowCandidateLimit: intEnv("SCAN_FLOW_CANDIDATE_LIMIT", 180),
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
  const boardBonus = code.startsWith("6") || code.startsWith("000") ? 4 : 0;
  const notChasing = pct < 6.5 ? 18 : -18;
  const mediumTermValue = zdf60 < 35 && zdf60 > -35 ? 18 - Math.abs(zdf60) * 0.2 : -10;
  const liquidity = Math.min(24, Math.log10(Math.max(amount, 1)) * 3);
  const turnoverScore = turnover >= 0.6 && turnover <= 7 ? 18 : turnover > 10 ? -12 : 6;
  const volumeScore = volumeRatio >= 0.7 && volumeRatio <= 2.4 ? 12 : volumeRatio > 4 ? -8 : 3;
  const capScore = marketCap >= 2_000_000_000 ? 6 : -8;
  return boardBonus + notChasing + mediumTermValue + liquidity + turnoverScore + volumeScore + capScore;
}

function attachRanks(items: StockPick[]) {
  return items.map((item, index) => ({ ...item, rank: index + 1 }));
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
      watchlist: [...demoted, ...watch].sort((a, b) => b.score - a.score).slice(0, Math.max(20, topN)),
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
    watchlist: [...sectorDemoted, ...capacityDemoted, ...watch].sort((a, b) => b.score - a.score).slice(0, Math.max(20, topN)),
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
    throw new Error(
      `No scan candidates found at ${quoteTime}. The market data may be pre-open, stale, or missing turnover; keeping the previous report.`
    );
  }

  console.log(`[scan] scoring ${roughCandidates.length} candidates with history + money flow`);
  const scored = await mapLimit(roughCandidates, 24, async ({ stock, quote }, index) => {
    const exchange = inferExchange(stock.dm, stock.jys);
    const instrument = toInstrumentCode(stock.dm, exchange);
    try {
      const code = plainCode(stock.dm);
      const [history, flows] = await Promise.all([client.history(instrument, config.historyDays), client.moneyFlow(code, config.flowDays)]);
      const pick = scoreCandidate({ stock, quote, history, flows });
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
  const ranked = attachRanks(await enrichSectors(client, sorted));

  if (!ranked.length) {
    throw new Error("No candidates could be scored; keeping the previous report.");
  }

  const { picks, watchlist, avoided, concentration } = selectPicksByMarket(ranked, market, config.topN, config.maxPerSector);

  const report: ScanReport = {
    meta: {
      generatedAt: chinaDateTime(),
      tradeDate: tradeDateFromPicks(ranked),
      source: "Biying API",
      mode: "live",
      docsUrl: "https://www.biyingapi.com/doc_hs",
      nextRunHint: "交易日 22:15 Asia/Shanghai",
      notes: [
        "主板代码前缀过滤：000/001/002/003/600/601/603/605",
        "剔除名称包含 ST、*ST、退 的标的",
        "评分侧重资金流入、价格分位、均线成本区和流动性",
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
    concentration,
    picks,
    watchlist,
    avoided
  };

  await writeReport(report);
}

const args = new Set(process.argv.slice(2));
if (args.has("--sample")) {
  await writeReport(sampleReport);
} else {
  await liveScan();
}
