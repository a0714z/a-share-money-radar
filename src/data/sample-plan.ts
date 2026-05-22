import type { PlanReport } from "../lib/types";
import { sampleReport } from "./sample-report";

export const samplePlan: PlanReport = {
  meta: {
    generatedAt: "待服务器生成",
    tradeDate: sampleReport.meta.tradeDate,
    source: "Sample",
    mode: "sample",
    lookbackDays: 260,
    intraday30mBars: 160,
    notes: ["样例预案用于页面占位；真实预案需要服务器运行 npm run plan。"]
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
