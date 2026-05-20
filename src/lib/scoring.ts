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

function safeDivide(value: number, base: number, fallback = 0) {
  return Number.isFinite(value) && Number.isFinite(base) && base !== 0 ? value / base : fallback;
}

function closeLocation(close: number, high: number, low: number) {
  const range = Math.max(0.01, high - low);
  return clamp((close - low) / range, 0, 1);
}

function countPositive(values: number[]) {
  return values.filter((value) => value > 0).length;
}

type SurgePullbackSetup = {
  score: number;
  daysSince: number;
  surgePct: number;
  surgeAmountRatio: number;
  pullbackFromSurgeHigh: number;
  pullbackAmountRatio: number;
  heldCostArea: boolean;
};

function findSurgePullbackSetup(bars: KLine[], close: number, ma20?: number, ma60?: number): SurgePullbackSetup | undefined {
  if (bars.length < 35) return undefined;

  const latestIndex = bars.length - 1;
  const start = Math.max(20, bars.length - 16);
  let best: SurgePullbackSetup | undefined;

  for (let index = start; index < latestIndex; index += 1) {
    const bar = bars[index];
    const previous = bars[index - 1];
    if (!bar || !previous) continue;

    const surgePct = pctChange(bar.c, previous.c);
    const avgAmountBeforeSurge = average(bars.slice(Math.max(0, index - 20), index).map((item) => item.a));
    const surgeAmountRatio = safeDivide(bar.a, avgAmountBeforeSurge, 0);
    const surgeCloseLocation = closeLocation(bar.c, bar.h, bar.l);
    const daysSince = latestIndex - index;

    if (surgePct < 7 || surgeAmountRatio < 2 || surgeCloseLocation < 0.55 || daysSince < 1 || daysSince > 12) continue;

    const pullbackFromSurgeHigh = clamp(((bar.h - close) / bar.h) * 100, 0, 100);
    if (pullbackFromSurgeHigh < 5 || pullbackFromSurgeHigh > 22) continue;

    const pullbackBars = bars.slice(index + 1);
    const pullbackAmountBase = average(pullbackBars.slice(-3).map((item) => item.a)) || average(pullbackBars.map((item) => item.a));
    const pullbackAmountRatio = safeDivide(pullbackAmountBase, bar.a, 1);
    const heldCostArea = close >= bar.o * 0.96 && (!ma20 || close >= ma20 * 0.96) && (!ma60 || close >= ma60 * 0.99);
    const notOverExtended = close <= bar.c * 1.03;

    const pullbackScore =
      pullbackFromSurgeHigh >= 8 && pullbackFromSurgeHigh <= 16
        ? 24
        : pullbackFromSurgeHigh >= 5 && pullbackFromSurgeHigh <= 20
          ? 14
          : 4;
    const amountScore = surgeAmountRatio >= 2.6 ? 16 : surgeAmountRatio >= 2.2 ? 12 : 8;
    const shrinkScore = pullbackAmountRatio <= 0.55 ? 18 : pullbackAmountRatio <= 0.75 ? 12 : pullbackAmountRatio <= 0.95 ? 3 : -10;
    const dayScore = daysSince >= 2 && daysSince <= 8 ? 8 : 4;
    const costScore = heldCostArea ? 12 : -14;
    const extensionScore = notOverExtended ? 8 : -8;
    const score = clamp(38 + Math.min(14, (surgePct - 7) * 1.8) + amountScore + pullbackScore + shrinkScore + dayScore + costScore + extensionScore);
    const setup = {
      score,
      daysSince,
      surgePct: round(surgePct, 1),
      surgeAmountRatio: round(surgeAmountRatio, 2),
      pullbackFromSurgeHigh: round(pullbackFromSurgeHigh, 1),
      pullbackAmountRatio: round(pullbackAmountRatio, 2),
      heldCostArea
    };

    if (!best || setup.score > best.score) best = setup;
  }

  return best;
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
  flowPositiveDays5: number;
  flowAcceleration: number;
  priceVolumeScore: number;
  closeLocation: number;
  amountRatio20: number;
  surgePullbackScore: number;
  hasSurgePullbackSetup: boolean;
}) {
  const classicEntryZone =
    args.score >= 83 &&
    args.risks.length <= 2 &&
    args.flowRatio5d >= 0.02 &&
    args.position >= 0.2 &&
    args.position <= 0.65 &&
    args.pullback >= 8 &&
    args.pullback <= 28 &&
    args.pctChange < 4.8 &&
    args.flow3d > 0 &&
    args.flowToday > 0 &&
    args.flowPositiveDays5 >= 3 &&
    args.priceVolumeScore >= 58 &&
    args.closeLocation >= 0.34 &&
    !(args.amountRatio20 > 2.6 && args.pctChange < 0);

  const pullbackEntryZone =
    args.score >= 80 &&
    args.risks.length <= 3 &&
    args.hasSurgePullbackSetup &&
    args.surgePullbackScore >= 72 &&
    args.pullback >= 5 &&
    args.pullback <= 32 &&
    args.pctChange < 4.8 &&
    args.flowRatio5d > -0.008 &&
    args.priceVolumeScore >= 48 &&
    args.closeLocation >= 0.28 &&
    !(args.amountRatio20 > 2.4 && args.pctChange < -1.5);

  const isEntryZone = pullbackEntryZone || (classicEntryZone && args.surgePullbackScore >= 58);

  if (isEntryZone) return { signal: "strong" as const, rating: "强关注" };
  if (args.hasSurgePullbackSetup && args.surgePullbackScore >= 68 && args.score >= 68) return { signal: "watch" as const, rating: "观察" };
  if (args.score >= 72) return { signal: "watch" as const, rating: "观察" };
  return { signal: "wait" as const, rating: "等待" };
}

function buildReasons(args: {
  flowRatio5d: number;
  flowToday: number;
  flowPositiveDays5: number;
  flowAcceleration: number;
  position: number;
  pullback: number;
  distanceToMa20: number;
  distanceToMa60: number;
  turnover: number;
  volumeRatio: number;
  amountRatio20: number;
  priceVolumeScore: number;
  closeLocation: number;
  surgePullback?: SurgePullbackSetup;
}) {
  const reasons: string[] = [];
  if (args.surgePullback && args.surgePullback.score >= 72) {
    reasons.push(
      `前期大涨${args.surgePullback.surgePct}%且${args.surgePullback.surgeAmountRatio}倍量启动，回调${args.surgePullback.pullbackFromSurgeHigh}%`
    );
  }
  if (args.surgePullback && args.surgePullback.pullbackAmountRatio <= 0.75) reasons.push("启动后回调缩量，抛压相对收敛");
  if (args.surgePullback && args.surgePullback.heldCostArea) reasons.push("回踩仍守住启动成本区");
  if (args.flowRatio5d > 0.035) reasons.push("5日大单净流入占比抬升");
  if (args.flowToday > 0) reasons.push("今日主买大单继续为正");
  if (args.flowPositiveDays5 >= 4) reasons.push("近5日资金连续性较好");
  if (args.flowAcceleration > 0.012) reasons.push("近3日资金流入加速");
  if (args.priceVolumeScore >= 78) reasons.push("量价配合健康");
  if (args.closeLocation >= 0.62 && args.amountRatio20 >= 1.05 && args.amountRatio20 <= 2.4) reasons.push("放量收在日内偏强位置");
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
  flowPositiveDays5: number;
  flowAcceleration: number;
  distanceToMa60: number;
  distanceToMa20: number;
  amount: number;
  amountRatio20: number;
  priceVolumeScore: number;
  closeLocation: number;
  surgePullback?: SurgePullbackSetup;
  historyLength: number;
}) {
  const risks: string[] = [];
  if (args.pctChange >= 7) risks.push("当日涨幅偏高，容易追高");
  if (args.position > 0.72) risks.push("价格已接近阶段高位");
  if (args.turnover > 9) risks.push("换手过热");
  if (args.volumeRatio > 3) risks.push("量比异常放大");
  if (args.amountRatio20 > 2.6 && args.pctChange < 0) risks.push("放量下跌，承接偏弱");
  if (args.pctChange > 2.5 && args.amountRatio20 < 0.75) risks.push("缩量上涨，持续性待确认");
  if (args.priceVolumeScore < 42) risks.push("量价配合偏弱");
  if (args.closeLocation < 0.32 && args.amountRatio20 > 1.25) risks.push("放量但收盘位置偏低");
  if (args.surgePullback && args.surgePullback.pullbackAmountRatio > 0.95) risks.push("启动后回调未明显缩量");
  if (args.surgePullback && !args.surgePullback.heldCostArea) risks.push("回调已跌破启动成本区");
  if (args.flowRatio5d < 0) risks.push("近5日大单净流入仍为负");
  if (args.flowPositiveDays5 <= 1) risks.push("资金流入连续性不足");
  if (args.flowAcceleration < -0.012) risks.push("近3日资金流入转弱");
  if (args.distanceToMa60 < -8) risks.push("跌破60日成本区较多");
  if (args.distanceToMa20 < -6 && args.flowRatio5d > 0.03) risks.push("资金流入但价格未站回20日线");
  if (args.amount < 30_000_000) risks.push("成交额偏低");
  if (args.historyLength < 80) risks.push("上市或有效历史样本不足");
  return risks;
}

export function buildTradePlan(args: {
  signal: "strong" | "watch" | "wait";
  close: number;
  pctChange: number;
  valuePosition: number;
  flowRatio5d: number;
  ma20?: number;
  ma60?: number;
  sample: KLine[];
}) {
  const last20 = args.sample.slice(-20);
  const recentLow = last20.length ? Math.min(...last20.map((bar) => bar.l)) : args.close * 0.95;
  const recentHigh = last20.length ? Math.max(...last20.map((bar) => bar.h)) : args.close * 1.08;
  const ma20 = args.ma20 ?? args.close;
  const ma60 = args.ma60 ?? ma20;
  let entryLow = Math.max(recentLow * 1.015, Math.min(ma20, args.close) * 0.982, args.close * 0.94);
  let entryHigh = Math.min(args.close * 1.012, ma20 * 1.028);

  if (entryLow > entryHigh) {
    entryLow = args.close * 0.965;
    entryHigh = args.close * 1.01;
  }

  const invalidBase = Math.min(recentLow, ma20 * 0.975, ma60 * 0.99);
  const invalidBelow = Math.min(invalidBase, entryLow * 0.985);
  const stopLoss = invalidBelow * 0.992;
  const chaseAbove = Math.max(entryHigh * 1.018, Math.min(args.close * 1.04, recentHigh * 0.985));
  const unitRisk = Math.max(args.close - stopLoss, args.close * 0.035);
  const target1 = args.close + unitRisk * 1.45;
  const target2 = args.close + unitRisk * 2.25;
  const riskReward = (target1 - entryHigh) / Math.max(entryHigh - stopLoss, args.close * 0.01);

  let positionPct = 8;
  let positionLabel: "标准" | "半仓" | "轻仓" | "观察" = "观察";
  if (args.signal === "strong") {
    positionPct = 15;
    positionLabel = "标准";
  } else if (args.signal === "watch") {
    positionPct = 8;
    positionLabel = "轻仓";
  }
  if (args.pctChange > 3.5 || args.valuePosition > 62 || args.flowRatio5d < 0.025 || riskReward < 1.15) {
    positionPct = Math.min(positionPct, args.signal === "strong" ? 10 : 5);
    positionLabel = args.signal === "strong" ? "半仓" : "观察";
  }
  if (args.signal === "wait") {
    positionPct = 0;
    positionLabel = "观察";
  }

  const notes = [
    "优先等回踩关注区间，不追高开仓",
    `突破 ${round(chaseAbove, 2)} 后按追高处理`,
    `跌破 ${round(invalidBelow, 2)} 说明资金进场逻辑失效`
  ];
  if (args.pctChange > 3.5) notes.push("当日涨幅偏大，仓位自动降一档");
  if (args.valuePosition > 62) notes.push("阶段分位偏高，等待回踩更有性价比");

  return {
    entryLow: round(entryLow, 2),
    entryHigh: round(entryHigh, 2),
    chaseAbove: round(chaseAbove, 2),
    invalidBelow: round(invalidBelow, 2),
    stopLoss: round(stopLoss, 2),
    target1: round(target1, 2),
    target2: round(target2, 2),
    positionPct: round(positionPct, 0),
    positionLabel,
    riskReward: round(riskReward, 2),
    notes
  };
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
  const recent20 = cleanHistory.slice(-20);
  const recent5 = cleanHistory.slice(-5);
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
  const surgePullback = findSurgePullbackSetup(cleanHistory, close, ma20, ma60);
  const surgePullbackScore = surgePullback ? surgePullback.score : 38;
  const latestHigh = Number(quote.h ?? latestBar.h ?? close);
  const latestLow = Number(quote.l ?? latestBar.l ?? close);
  const dayCloseLocation = closeLocation(close, latestHigh, latestLow);
  const avgAmount20 = average(recent20.slice(0, -1).map((bar) => bar.a));
  const avgAmount5 = average(recent5.slice(0, -1).map((bar) => bar.a));
  const amountRatio20 = safeDivide(amount, avgAmount20, 1);
  const amountRatio5 = safeDivide(amount, avgAmount5, amountRatio20);
  const amountExpansionScore =
    amountRatio20 >= 1.05 && amountRatio20 <= 2.2
      ? 100
      : amountRatio20 >= 0.75 && amountRatio20 < 1.05
        ? 72
        : amountRatio20 > 2.2 && amountRatio20 <= 3
          ? 58
          : amountRatio20 < 0.55
            ? 32
            : 42;
  const closeStrengthScore = dayCloseLocation >= 0.68 ? 95 : dayCloseLocation >= 0.52 ? 76 : dayCloseLocation >= 0.35 ? 52 : 26;
  const shortAmountScore =
    amountRatio5 >= 0.9 && amountRatio5 <= 2.1
      ? 88
      : amountRatio5 > 2.1 && amountRatio5 <= 2.8 && pct >= 0
        ? 66
        : amountRatio5 < 0.65 && pct > 0
          ? 36
          : amountRatio5 > 2.8 && pct < 0
            ? 24
            : 54;
  const priceMoveQualityScore =
    pct > 0
      ? amountRatio20 >= 0.85
        ? 80 + Math.min(16, pct * 2)
        : 48
      : pct > -2
        ? amountRatio20 <= 1.7
          ? 68
          : 46
        : amountRatio20 > 1.3
          ? 24
          : 42;
  const priceVolumeScore = clamp(
    amountExpansionScore * 0.3 + closeStrengthScore * 0.3 + shortAmountScore * 0.18 + priceMoveQualityScore * 0.22
  );

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
  const prevFlow3d = sum(flowBars.slice(-6, -3).map((flow) => flow.net));
  const flowAmount5d = sum(cleanFlows.slice(-5).map(flowAmount));
  const flowAmount3d = sum(cleanFlows.slice(-3).map(flowAmount));
  const prevFlowAmount3d = sum(cleanFlows.slice(-6, -3).map(flowAmount));
  const flowRatio5d = safeDivide(flow5d, flowAmount5d);
  const flowRatio3d = safeDivide(flow3d, flowAmount3d);
  const prevFlowRatio3d = safeDivide(prevFlow3d, prevFlowAmount3d);
  const flowAcceleration = flowRatio3d - prevFlowRatio3d;
  const flowPositiveDays5 = countPositive(flowBars.slice(-5).map((flow) => flow.net));
  const dddxAvg = average(cleanFlows.slice(-5).map((flow) => Number(flow.dddx ?? 0)));

  const valueBase = sweetSpotScore(position);
  const pullbackScore = pullback >= 7 && pullback <= 28 ? 100 : pullback < 4 ? 42 : pullback <= 40 ? 66 : 38;
  const maCostScore = clamp(82 - Math.abs(distanceToMa20) * 5 + (distanceToMa60 > -3 ? 10 : -12));
  const valueScore = clamp(valueBase * 0.45 + pullbackScore * 0.28 + maCostScore * 0.27);

  const moneyScore = clamp(
    50 +
      flowRatio5d * 720 +
      flowAcceleration * 460 +
      (flowPositiveDays5 - 2.5) * 5 +
      (flow3d > 0 ? 12 : -12) +
      (flowToday > 0 ? 10 : -8) +
      clamp(dddxAvg, -8, 8) * 2.2
  );

  const volumePricePenalty =
    (amountRatio20 > 2.6 && pct < 0 ? 12 : 0) +
    (pct > 3.5 && amountRatio20 < 0.7 ? 10 : 0) +
    (dayCloseLocation < 0.28 && amountRatio20 > 1.2 ? 8 : 0);

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
    flowPositiveDays5,
    flowAcceleration,
    distanceToMa60,
    distanceToMa20,
    amount,
    amountRatio20,
    priceVolumeScore,
    closeLocation: dayCloseLocation,
    surgePullback,
    historyLength: cleanHistory.length
  });

  const hardPenalty =
    (pct >= 8.8 ? 10 : 0) +
    (position > 0.82 ? 14 : 0) +
    (flowRatio5d < -0.025 ? 12 : 0) +
    (amount < 20_000_000 ? 16 : 0) +
    (distanceToMa60 < -12 ? 10 : 0) +
    volumePricePenalty;

  const score = clamp(
    moneyScore * 0.28 +
      priceVolumeScore * 0.18 +
      surgePullbackScore * 0.22 +
      valueScore * 0.16 +
      trendScore * 0.1 +
      liquidityScore * 0.06 -
      hardPenalty
  );
  const rating = ratingFromSetup({
    score,
    risks,
    flowRatio5d,
    position,
    pullback,
    pctChange: pct,
    flow3d,
    flowToday,
    flowPositiveDays5,
    flowAcceleration,
    priceVolumeScore,
    closeLocation: dayCloseLocation,
    amountRatio20,
    surgePullbackScore,
    hasSurgePullbackSetup: Boolean(surgePullback)
  });
  const reasons = buildReasons({
    flowRatio5d,
    flowToday,
    flowPositiveDays5,
    flowAcceleration,
    position,
    pullback,
    distanceToMa20,
    distanceToMa60,
    turnover,
    volumeRatio,
    amountRatio20,
    priceVolumeScore,
    closeLocation: dayCloseLocation,
    surgePullback
  });
  const tradePlan = buildTradePlan({
    signal: rating.signal,
    close,
    pctChange: pct,
    valuePosition: position * 100,
    flowRatio5d,
    ma20,
    ma60,
    sample
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
    tradePlan,
    reasons: reasons.length ? reasons : ["资金和价格条件接近观察区"],
    risks,
    history: historyWithMa,
    flowBars,
    updatedAt: quote.t
  };
}
