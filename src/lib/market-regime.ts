import { average, clamp, pctChange, round } from "./math";
import type { KLine, MarketIndexSignal, MarketRegime } from "./types";

export const MARKET_INDEXES = [
  { code: "000001.SH", name: "上证指数", weight: 0.32 },
  { code: "399001.SZ", name: "深证成指", weight: 0.24 },
  { code: "000300.SH", name: "沪深300", weight: 0.32 },
  { code: "399006.SZ", name: "创业板指", weight: 0.12 }
] as const;

function byDateAsc(items: KLine[]) {
  return [...items].sort((a, b) => a.t.localeCompare(b.t));
}

function ma(values: number[], window: number) {
  if (values.length < window) return 0;
  return average(values.slice(-window));
}

function indexSignal(code: string, name: string, history: KLine[]): MarketIndexSignal | null {
  const bars = byDateAsc(history).filter((bar) => Number.isFinite(bar.c) && bar.c > 0);
  if (bars.length < 65) return null;

  const latest = bars[bars.length - 1];
  const closes = bars.map((bar) => bar.c);
  const close = latest.c;
  const ma20 = ma(closes, 20);
  const ma60 = ma(closes, 60);
  const prevMa20 = average(closes.slice(-25, -5));
  const return5d = pctChange(close, closes[closes.length - 6]);
  const return20d = pctChange(close, closes[closes.length - 21]);
  const ma20Slope = pctChange(ma20, prevMa20);
  const aboveMa20 = close >= ma20;
  const aboveMa60 = close >= ma60;

  const score = clamp(
    50 +
      (aboveMa20 ? 18 : -16) +
      (aboveMa60 ? 14 : -18) +
      (ma20Slope > 0 ? 10 : -8) +
      (return5d > 0 ? 7 : -7) +
      (return20d > 0 ? 7 : -7) +
      clamp(return20d, -8, 8) * 1.2
  );

  const reasons: string[] = [];
  reasons.push(aboveMa20 ? "站上20日线" : "跌破20日线");
  reasons.push(aboveMa60 ? "站上60日线" : "跌破60日线");
  reasons.push(ma20Slope > 0 ? "20日线抬升" : "20日线走弱");
  reasons.push(return5d > 0 ? "5日收益为正" : "5日收益为负");

  return {
    code,
    name,
    tradeDate: latest.t.slice(0, 10),
    close: round(close, 2),
    ma20: round(ma20, 2),
    ma60: round(ma60, 2),
    return5d: round(return5d, 2),
    return20d: round(return20d, 2),
    aboveMa20,
    aboveMa60,
    ma20Slope: round(ma20Slope, 2),
    score: round(score, 1),
    reasons
  };
}

export function evaluateMarketRegime(histories: Record<string, KLine[]>): MarketRegime {
  const indices = MARKET_INDEXES.map((item) => indexSignal(item.code, item.name, histories[item.code] ?? [])).filter(
    (item): item is MarketIndexSignal => Boolean(item)
  );

  if (!indices.length) {
    return {
      state: "neutral",
      label: "震荡",
      score: 50,
      action: "cap_core",
      tradeDate: "",
      appliedToCore: false,
      indices: [],
      reasons: ["指数数据不足，按震荡市场处理"]
    };
  }

  const weightedScore = MARKET_INDEXES.reduce((total, config) => {
    const signal = indices.find((item) => item.code === config.code);
    return total + (signal ? signal.score * config.weight : 0);
  }, 0);
  const activeWeight = MARKET_INDEXES.reduce((total, config) => total + (indices.some((item) => item.code === config.code) ? config.weight : 0), 0);
  const score = round(weightedScore / Math.max(activeWeight, 0.01), 1);
  const below20Count = indices.filter((item) => !item.aboveMa20).length;
  const below60Count = indices.filter((item) => !item.aboveMa60).length;
  const weakBreadth = below20Count >= 3 || below60Count >= 3;
  const strongBreadth = indices.filter((item) => item.aboveMa20 && item.aboveMa60 && item.ma20Slope > 0).length >= 3;

  const state = score >= 68 && strongBreadth ? "strong" : score < 48 || weakBreadth ? "weak" : "neutral";
  const label = state === "strong" ? "强势" : state === "weak" ? "弱势" : "震荡";
  const action = state === "strong" ? "allow_core" : state === "weak" ? "observe_only" : "cap_core";
  const tradeDate = indices.map((item) => item.tradeDate).sort().at(-1) ?? "";
  const reasons = [
    `指数综合分 ${score}`,
    `${indices.length} 个指数参与评估`,
    `${below20Count} 个指数低于20日线`,
    `${below60Count} 个指数低于60日线`
  ];
  if (action === "observe_only") reasons.push("市场过滤触发：暂停强关注");
  if (action === "cap_core") reasons.push("市场震荡：核心池上限收紧");

  return {
    state,
    label,
    score,
    action,
    tradeDate,
    appliedToCore: action !== "allow_core",
    indices,
    reasons
  };
}
