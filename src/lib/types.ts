export type Exchange = "sh" | "sz";

export type Signal = "strong" | "watch" | "wait";

export type StockListItem = {
  dm: string;
  mc: string;
  jys: Exchange | string;
};

export type RealQuote = {
  dm: string;
  o?: number;
  h?: number;
  l?: number;
  p?: number;
  yc?: number;
  pc?: number;
  cje?: number;
  v?: number;
  hs?: number;
  tr?: number;
  lb?: number;
  lt?: number;
  sz?: number;
  pe?: number;
  sjl?: number;
  pb_ratio?: number;
  zdf60?: number;
  zdfnc?: number;
  t?: string;
};

export type KLine = {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  a: number;
  pc?: number;
  sf?: number;
};

export type MoneyFlow = {
  t: string;
  dddx?: number;
  zddy?: number;
  ddcf?: number;
  zmbtdcje?: number;
  zmbddcje?: number;
  zmbzdcje?: number;
  zmbxdcje?: number;
  zmstdcje?: number;
  zmsddcje?: number;
  zmszdcje?: number;
  zmsxdcje?: number;
  zmbtdcjzl?: number;
  zmbddcjzl?: number;
  zmbljcjzl?: number;
  zmstdcjzl?: number;
  zmsddcjzl?: number;
  zmsljcjzl?: number;
  [key: string]: string | number | undefined;
};

export type SparkPoint = {
  date: string;
  close: number;
  ma20?: number;
  ma60?: number;
  amount?: number;
};

export type FlowPoint = {
  date: string;
  net: number;
  ratio: number;
};

export type ScoreBreakdown = {
  money: number;
  value: number;
  trend: number;
  liquidity: number;
  penalty: number;
};

export type StockPick = {
  rank: number;
  code: string;
  instrument: string;
  name: string;
  exchange: Exchange;
  signal: Signal;
  rating: string;
  score: number;
  confidence: number;
  price: number;
  pctChange: number;
  amount: number;
  turnover: number;
  volumeRatio: number;
  marketCap?: number;
  pe?: number;
  pb?: number;
  valuePosition: number;
  pullbackFromHigh: number;
  distanceToMa20: number;
  distanceToMa60: number;
  ma20?: number;
  ma60?: number;
  flowToday: number;
  flow3d: number;
  flow5d: number;
  flowRatio5d: number;
  dddxAvg: number;
  reasons: string[];
  risks: string[];
  history: SparkPoint[];
  flowBars: FlowPoint[];
  updatedAt?: string;
};

export type ScanReport = {
  meta: {
    generatedAt: string;
    tradeDate: string;
    source: string;
    mode: "live" | "sample";
    docsUrl: string;
    nextRunHint: string;
    notes: string[];
  };
  universe: {
    listed: number;
    mainBoardNonSt: number;
    quoted: number;
    candidates: number;
    scored: number;
    strong: number;
    watch: number;
  };
  picks: StockPick[];
  watchlist: StockPick[];
  avoided: StockPick[];
};

export type ReviewHorizon = "1d" | "3d" | "5d" | "10d";

export type HorizonResult = {
  days: number;
  status: "complete" | "pending";
  date?: string;
  close?: number;
  returnPct?: number;
};

export type ReviewRecord = {
  signalDate: string;
  code: string;
  instrument: string;
  name: string;
  rank: number;
  score: number;
  signalPrice: number;
  flowRatio5d: number;
  valuePosition: number;
  pullbackFromHigh: number;
  horizons: Record<ReviewHorizon, HorizonResult>;
  bestEntryDrawdown3d?: number;
  maxDrawdown10d?: number;
  maxRunup10d?: number;
  status: "complete" | "tracking";
};

export type HorizonSummary = {
  completed: number;
  winRate?: number;
  avgReturn?: number;
  medianReturn?: number;
};

export type ReviewReport = {
  meta: {
    generatedAt: string;
    source: string;
    mode: "live" | "sample";
    historyReports: number;
    notes: string[];
  };
  summary: {
    totalSignals: number;
    completed10d: number;
    tracking: number;
    horizons: Record<ReviewHorizon, HorizonSummary>;
    avgMaxDrawdown10d?: number;
    avgBestEntryDrawdown3d?: number;
  };
  records: ReviewRecord[];
};
