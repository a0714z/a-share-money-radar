import { sampleReport } from "./sample-report";
import type { ReviewReport } from "../lib/types";

export const sampleReview: ReviewReport = {
  meta: {
    generatedAt: "2026-05-19 22:20:00",
    source: "sample",
    mode: "sample",
    historyReports: 1,
    notes: ["样例复盘数据用于界面预览"]
  },
  summary: {
    totalSignals: sampleReport.picks.length,
    completed10d: 0,
    tracking: sampleReport.picks.length,
    horizons: {
      "1d": { completed: 0 },
      "3d": { completed: 0 },
      "5d": { completed: 0 },
      "10d": { completed: 0 }
    }
  },
  records: sampleReport.picks.map((pick) => ({
    signalDate: sampleReport.meta.tradeDate,
    code: pick.code,
    instrument: pick.instrument,
    name: pick.name,
    rank: pick.rank,
    score: pick.score,
    signalPrice: pick.price,
    flowRatio5d: pick.flowRatio5d,
    valuePosition: pick.valuePosition,
    pullbackFromHigh: pick.pullbackFromHigh,
    horizons: {
      "1d": { days: 1, status: "pending" },
      "3d": { days: 3, status: "pending" },
      "5d": { days: 5, status: "pending" },
      "10d": { days: 10, status: "pending" }
    },
    status: "tracking"
  }))
};
