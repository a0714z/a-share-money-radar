import type { ScanReport, StockPick } from "../lib/types";

const history = [
  8.8, 8.73, 8.66, 8.7, 8.76, 8.83, 8.9, 8.86, 8.79, 8.74, 8.8, 8.92, 9.04, 9.1, 9.02, 8.98, 9.06,
  9.14, 9.2, 9.28, 9.23, 9.18, 9.12, 9.05, 9.0, 8.94, 8.98, 9.08, 9.18, 9.3
].map((close, index) => ({
  date: `2026-04-${String(index + 1).padStart(2, "0")}`,
  close,
  ma20: index > 18 ? 8.95 + index * 0.01 : undefined,
  ma60: index > 25 ? 8.88 + index * 0.006 : undefined,
  amount: 120_000_000 + index * 2_400_000
}));

function pick(seed: Partial<StockPick>): StockPick {
  return {
    rank: 1,
    code: "000001",
    instrument: "000001.SZ",
    name: "样例银行",
    exchange: "sz",
    signal: "strong",
    rating: "强关注",
    score: 82.4,
    confidence: 92,
    price: 9.3,
    pctChange: 1.42,
    amount: 312_000_000,
    turnover: 2.1,
    volumeRatio: 1.28,
    marketCap: 56_000_000_000,
    pe: 8.8,
    pb: 0.92,
    valuePosition: 38.6,
    pullbackFromHigh: 13.4,
    distanceToMa20: 2.2,
    distanceToMa60: 5.4,
    ma20: 9.1,
    ma60: 8.82,
    flowToday: 36_500_000,
    flow3d: 96_000_000,
    flow5d: 162_000_000,
    flowRatio5d: 7.8,
    dddxAvg: 3.4,
    reasons: ["5日大单净流入占比抬升", "价格处在近120日中低分位", "收盘价贴近20日均线", "量比温和放大"],
    risks: ["样例数据，仅用于界面预览"],
    history,
    flowBars: [
      { date: "2026-05-12", net: -18_000_000, ratio: -0.018 },
      { date: "2026-05-13", net: 22_000_000, ratio: 0.021 },
      { date: "2026-05-14", net: 31_000_000, ratio: 0.034 },
      { date: "2026-05-15", net: 27_500_000, ratio: 0.028 },
      { date: "2026-05-18", net: 45_500_000, ratio: 0.043 },
      { date: "2026-05-19", net: 36_500_000, ratio: 0.036 }
    ],
    updatedAt: "2026-05-19 15:29:10",
    ...seed
  };
}

export const sampleReport: ScanReport = {
  meta: {
    generatedAt: "2026-05-19T22:15:00+08:00",
    tradeDate: "2026-05-19",
    source: "sample",
    mode: "sample",
    docsUrl: "https://www.biyingapi.com/doc_hs",
    nextRunHint: "交易日 22:15 Asia/Shanghai",
    notes: ["未检测到 live 报告时展示样例数据", "真实扫描会写入 public/reports/latest.json"]
  },
  universe: {
    listed: 5360,
    mainBoardNonSt: 3176,
    quoted: 3158,
    candidates: 180,
    scored: 156,
    strong: 2,
    watch: 4
  },
  market: {
    state: "strong",
    label: "强势",
    score: 82.5,
    action: "allow_core",
    tradeDate: "2026-05-19",
    appliedToCore: false,
    indices: [
      {
        code: "000001.SH",
        name: "上证指数",
        tradeDate: "2026-05-19",
        close: 4169.54,
        ma20: 4052.31,
        ma60: 3928.64,
        return5d: 2.18,
        return20d: 4.65,
        aboveMa20: true,
        aboveMa60: true,
        ma20Slope: 1.26,
        score: 86,
        reasons: ["站上20日线", "站上60日线", "20日线抬升", "5日收益为正"]
      },
      {
        code: "399001.SZ",
        name: "深证成指",
        tradeDate: "2026-05-19",
        close: 15569.91,
        ma20: 15088.2,
        ma60: 14572.46,
        return5d: 2.04,
        return20d: 5.12,
        aboveMa20: true,
        aboveMa60: true,
        ma20Slope: 1.38,
        score: 84,
        reasons: ["站上20日线", "站上60日线", "20日线抬升", "5日收益为正"]
      }
    ],
    reasons: ["指数综合分 82.5", "2 个指数参与评估", "0 个指数低于20日线", "0 个指数低于60日线"]
  },
  picks: [
    pick({ rank: 1 }),
    pick({
      rank: 2,
      code: "600000",
      instrument: "600000.SH",
      name: "样例制造",
      exchange: "sh",
      price: 14.76,
      score: 79.2,
      pctChange: 0.86,
      valuePosition: 31.2,
      pullbackFromHigh: 18.8,
      flowToday: 28_200_000,
      flow3d: 71_000_000,
      flow5d: 121_000_000
    })
  ],
  watchlist: [
    pick({
      rank: 3,
      code: "002001",
      instrument: "002001.SZ",
      name: "样例消费",
      signal: "watch",
      rating: "观察",
      score: 71.5,
      pctChange: -0.38,
      valuePosition: 46.9,
      risks: ["60日趋势仍需确认"]
    }),
    pick({
      rank: 4,
      code: "601001",
      instrument: "601001.SH",
      name: "样例能源",
      exchange: "sh",
      signal: "watch",
      rating: "观察",
      score: 69.8,
      volumeRatio: 0.74,
      risks: ["量能尚未明显放大"]
    })
  ],
  avoided: [
    pick({
      rank: 5,
      code: "000002",
      instrument: "000002.SZ",
      name: "样例高位",
      signal: "wait",
      rating: "等待",
      score: 58.4,
      pctChange: 8.2,
      valuePosition: 86.1,
      risks: ["当日涨幅偏高，容易追高", "价格已接近阶段高位"]
    })
  ]
};
