import type { PlanReport } from "../lib/types";
import { sampleReport } from "./sample-report";

export const samplePlan: PlanReport = {
  meta: {
    generatedAt: "待服务器生成",
    tradeDate: sampleReport.meta.tradeDate,
    source: "Sample",
    mode: "sample",
    lookbackDays: 80,
    setupWindowDays: 20,
    intraday30mBars: 160,
    notes: ["样例预案用于页面占位；真实预案只在最近20个交易日内寻找爆量回调结构。"]
  },
  summary: {
    universe: sampleReport.universe.mainBoardNonSt,
    dailyScored: sampleReport.universe.mainBoardNonSt,
    dailyCandidates: sampleReport.universe.candidates,
    intradayScored: sampleReport.universe.scored,
    plans: sampleReport.picks.length,
    watch: sampleReport.watchlist.length,
    risk: sampleReport.avoided.length
  },
  plans: sampleReport.picks.map((pick) => ({ ...pick, rating: "预案重点" })),
  watchlist: sampleReport.watchlist.map((pick) => ({ ...pick, rating: "预案观察" })),
  avoided: sampleReport.avoided.map((pick) => ({ ...pick, rating: "风险跟踪" }))
};
