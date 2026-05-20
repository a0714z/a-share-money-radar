import { average, clamp, last, movingAverage, pctChange, round, sum } from "./math";
import type { KLine, MoneyFlow, RealQuote, StockListItem, StockPick } from "./types";
import { inferExchange, toInstrumentCode } from "./universe";

export type ScoreInput = {
  stock: StockListItem;
  quote: RealQuote;
  history: KLine[];
  flows: MoneyFlow[];
};

function activeBigBuy(flow: MoneyFlow) {
  const incremental = sum([flow.zmbtdcjzl, flow.zmbddcjzl]);
  return incremental > 0 ? incremental : sum([flow.zmbtdcje, flow.zmbddcje]);
}

function activeBigSell(flow: MoneyFlow) {
  const incremental = sum([flow.zmstdcjzl, flow.zmsddcjzl]);
  return incremental > 0 ? incremental : sum([flow.zmstdcje, flow.zmsddcje]);
}

export function netBigMoney(flow: MoneyFlow) {
  return activeBigBuy(flow) - activeBigSell(flow);
}

function flowAmount(flow: MoneyFlow) {
  const explicit = sum([flow.zmbljcjzl, flow.zmsljcjzl]);
  if (explicit > 0) return explicit;
  return activeBigBuy(flow) + activeBigSell(flow);
}

function byDateAsc<T extends { t?: string }>(items: T[]) {
  return [...items].sort((a, b) => String(a.t ?? "").localeCompare(String(b.t ?? "")));
}

function sweetSpotScore(position: number) {
  if (position <= 0.08) return 46;
  if (position <= 0.22) return 78;
  if (position <= 0.48) return 100;
  if (position <= 0.65) return 76;
  if (position <= 0.78) return 45;
  return 18;
}

function ratingFromSetup(args: {
  score: number;
  risks: string[];
  flowRatio5d: number;
  position: number;
  pullback: number;
  pctChange: number;
  flow3d: number;
  flowToday: number;
}) {
  const isEntryZone =
    args.score >= 83 &&
    args.risks.length <= 2 &&
    args.flowRatio5d >= 0.02 &&
    args.position >= 0.2 &&
    args.position <= 0.65 &&
    args.pullback >= 8 &&
    args.pullback <= 28 &&
    args.pctChange < 4.8 &&
    args.flow3d > 0 &&
    args.flowToday > 0;

  if (isEntryZone) return { signal: "strong" as const, rating: "强关注" };
  if (args.score >= 72) return { signal: "watch" as const, rating: "观察" };
  return { signal: "wait" as const, rating: "等待" };
}

function buildReasons(args: {
  flowRatio5d: number;
  flowToday: number;
  position: number;
  pullback: number;
  distanceToMa20: number;
  distanceToMa60: number;
  turnover: number;
  volumeRatio: number;
}) {
  const reasons: string[] = [];
  if (args.flowRatio5d > 0.035) reasons.push("5日大单净流入占比抬升");
  if (args.flowToday > 0) reasons.push("今日主买大单继续为正");
  if (args.position >= 0.18 && args.position <= 0.55) reasons.push("价格处在近120日中低分位");
  if (args.pullback >= 8 && args.pullback <= 28) reasons.push("离阶段高点有回撤空间");
  if (Math.abs(args.distanceToMa20) <= 6) reasons.push("收盘价贴近20日均线");
  if (args.distanceToMa60 > -4) reasons.push("未明显跌破60日成本区");
  if (args.turnover >= 0.8 && args.turnover <= 6.5) reasons.push("换手保持活跃但未极端拥挤");
  if (args.volumeRatio >= 0.8 && args.volumeRatio <= 2.2) reasons.push("量比温和放大");
  return reasons.slice(0, 5);
}

function buildRisks(args: {
  pctChange: number;
  position: number;
  turnover: number;
  volumeRatio: number;
  flowRatio5d: number;
  distanceToMa60: number;
  amount: number;
  historyLength: number;
}) {
  const risks: string[] = [];
  if (args.pctChange >= 7) risks.push("当日涨幅偏高，容易追高");
  if (args.position > 0.72) risks.push("价格已接近阶段高位");
  if (args.turnover > 9) risks.push("换手过热");
  if (args.volumeRatio > 3) risks.push("量比异常放大");
  if (args.flowRatio5d < 0) risks.push("近5日大单净流入仍为负");
  if (args.distanceToMa60 < -8) risks.push("跌破60日成本区较多");
  if (args.amount < 30_000_000) risks.push("成交额偏低");
  if (args.historyLength < 80) risks.push("上市或有效历史样本不足");
  return risks;
}

export function scoreCandidate({ stock, quote, history, flows }: ScoreInput): StockPick | null {
  const cleanHistory = byDateAsc(history).filter((bar) => Number.isFinite(bar.c) && bar.c > 0 && bar.sf !== 1);
  if (cleanHistory.length < 40) return null;

  const latestBar = last(cleanHistory);
  if (!latestBar) return null;

  const close = quote.p && quote.p > 0 ? quote.p : latestBar.c;
  const pct = Number.isFinite(quote.pc) ? Number(quote.pc) : pctChange(close, latestBar.pc ?? latestBar.o);
  const amount = Number(quote.cje ?? latestBar.a ?? 0);
  const turnover = Number(quote.hs ?? quote.tr ?? 0);
  const volumeRatio = Number(quote.lb ?? 0);
  const marketCap = quote.sz ?? quote.lt;
  const pe = quote.pe;
  const pb = quote.sjl ?? quote.pb_ratio;

  const sample = cleanHistory.slice(-120);
  const highs = sample.map((bar) => bar.h);
  const lows = sample.map((bar) => bar.l);
  const highN = Math.max(...highs);
  const lowN = Math.min(...lows);
  const range = Math.max(0.01, highN - lowN);
  const position = clamp((close - lowN) / range, 0, 1);
  const pullback = clamp(((highN - close) / highN) * 100, 0, 100);

  const closes = cleanHistory.map((bar) => bar.c);
  const ma20s = movingAverage(closes, 20);
  const ma60s = movingAverage(closes, 60);
  const ma20 = last(ma20s);
  const ma60 = last(ma60s);
  const distanceToMa20 = ma20 ? pctChange(close, ma20) : 0;
  const distanceToMa60 = ma60 ? pctChange(close, ma60) : 0;

  const cleanFlows = byDateAsc(flows).slice(-10);
  const flowBars = cleanFlows.map((flow) => {
    const net = netBigMoney(flow);
    const amountBase = flowAmount(flow);
    return {
      date: String(flow.t).slice(0, 10),
      net: round(net, 0),
      ratio: round(amountBase > 0 ? net / amountBase : 0, 4)
    };
  });

  const flowToday = last(flowBars)?.net ?? 0;
  const flow3d = sum(flowBars.slice(-3).map((flow) => flow.net));
  const flow5d = sum(flowBars.slice(-5).map((flow) => flow.net));
  const flowAmount5d = sum(cleanFlows.slice(-5).map(flowAmount));
  const flowRatio5d = flowAmount5d > 0 ? flow5d / flowAmount5d : 0;
  const dddxAvg = average(cleanFlows.slice(-5).map((flow) => Number(flow.dddx ?? 0)));

  const valueBase = sweetSpotScore(position);
  const pullbackScore = pullback >= 7 && pullback <= 28 ? 100 : pullback < 4 ? 42 : pullback <= 40 ? 66 : 38;
  const maCostScore = clamp(82 - Math.abs(distanceToMa20) * 5 + (distanceToMa60 > -3 ? 10 : -12));
  const valueScore = clamp(valueBase * 0.45 + pullbackScore * 0.28 + maCostScore * 0.27);

  const moneyScore = clamp(
    50 +
      flowRatio5d * 720 +
      (flow3d > 0 ? 12 : -12) +
      (flowToday > 0 ? 10 : -8) +
      clamp(dddxAvg, -8, 8) * 2.2
  );

  const trendScore = clamp(
    48 +
      (ma20 && close > ma20 ? 12 : -6) +
      (ma20 && ma60 && ma20 > ma60 ? 14 : -4) +
      (distanceToMa60 > 0 ? 8 : -6) +
      clamp(Number(quote.zdf60 ?? 0), -18, 22) * 0.55 -
      Math.max(0, pct - 4) * 4
  );

  const amountScore = amount >= 80_000_000 ? 78 : amount >= 30_000_000 ? 58 : 25;
  const turnoverScore = turnover >= 0.8 && turnover <= 6.5 ? 86 : turnover < 0.4 ? 35 : 58;
  const volumeScore = volumeRatio >= 0.75 && volumeRatio <= 2.3 ? 82 : volumeRatio > 3.5 ? 36 : 56;
  const liquidityScore = clamp(amountScore * 0.45 + turnoverScore * 0.35 + volumeScore * 0.2);

  const risks = buildRisks({
    pctChange: pct,
    position,
    turnover,
    volumeRatio,
    flowRatio5d,
    distanceToMa60,
    amount,
    historyLength: cleanHistory.length
  });

  const hardPenalty =
    (pct >= 8.8 ? 10 : 0) +
    (position > 0.82 ? 14 : 0) +
    (flowRatio5d < -0.025 ? 12 : 0) +
    (amount < 20_000_000 ? 16 : 0) +
    (distanceToMa60 < -12 ? 10 : 0);

  const score = clamp(moneyScore * 0.4 + valueScore * 0.3 + trendScore * 0.2 + liquidityScore * 0.1 - hardPenalty);
  const rating = ratingFromSetup({
    score,
    risks,
    flowRatio5d,
    position,
    pullback,
    pctChange: pct,
    flow3d,
    flowToday
  });
  const reasons = buildReasons({
    flowRatio5d,
    flowToday,
    position,
    pullback,
    distanceToMa20,
    distanceToMa60,
    turnover,
    volumeRatio
  });

  const exchange = inferExchange(stock.dm, stock.jys);
  const historyWithMa = sample.slice(-80).map((bar, index, bars) => {
    const localCloses = bars.slice(0, index + 1).map((item) => item.c);
    const localMa20 = localCloses.length >= 20 ? average(localCloses.slice(-20)) : undefined;
    const localMa60 = localCloses.length >= 60 ? average(localCloses.slice(-60)) : undefined;
    return {
      date: bar.t.slice(0, 10),
      close: round(bar.c, 2),
      ma20: localMa20 ? round(localMa20, 2) : undefined,
      ma60: localMa60 ? round(localMa60, 2) : undefined,
      amount: round(bar.a, 0)
    };
  });

  return {
    rank: 0,
    code: stock.dm,
    instrument: toInstrumentCode(stock.dm, exchange),
    name: stock.mc,
    exchange,
    signal: rating.signal,
    rating: rating.rating,
    score: round(score, 1),
    confidence: round(clamp(cleanFlows.length * 9 + Math.min(cleanHistory.length, 120) * 0.35), 0),
    price: round(close, 2),
    pctChange: round(pct, 2),
    amount: round(amount, 0),
    turnover: round(turnover, 2),
    volumeRatio: round(volumeRatio, 2),
    marketCap: marketCap ? round(marketCap, 0) : undefined,
    pe: pe ? round(pe, 2) : undefined,
    pb: pb ? round(pb, 2) : undefined,
    valuePosition: round(position * 100, 1),
    pullbackFromHigh: round(pullback, 1),
    distanceToMa20: round(distanceToMa20, 2),
    distanceToMa60: round(distanceToMa60, 2),
    ma20: ma20 ? round(ma20, 2) : undefined,
    ma60: ma60 ? round(ma60, 2) : undefined,
    flowToday: round(flowToday, 0),
    flow3d: round(flow3d, 0),
    flow5d: round(flow5d, 0),
    flowRatio5d: round(flowRatio5d * 100, 2),
    dddxAvg: round(dddxAvg, 2),
    reasons: reasons.length ? reasons : ["资金和价格条件接近观察区"],
    risks,
    history: historyWithMa,
    flowBars,
    updatedAt: quote.t
  };
}
