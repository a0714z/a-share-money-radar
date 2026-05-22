export type Exchange = "sh" | "sz";

export type Signal = "strong" | "watch" | "wait";

export type SetupState = "二次突破" | "承接确认" | "缩量回踩" | "爆量启动" | "承接转弱" | "放量派发风险" | "跌破失效" | "常规观察";

export type MarketState = "strong" | "neutral" | "weak";

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

export type CompanyProfile = {
  name?: string;
  bscope?: string;
  idea?: string;
  instype?: string;
  organ?: string;
  [key: string]: string | number | undefined;
};

export type SparkPoint = {
  date: string;
  open?: number;
  high?: number;
  low?: number;
  close: number;
  volume?: number;
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

export type TradePlan = {
  entryLow: number;
  entryHigh: number;
  chaseAbove: number;
  invalidBelow: number;
  stopLoss: number;
  target1: number;
  target2: number;
  positionPct: number;
  positionLabel: "标准" | "半仓" | "轻仓" | "观察";
  riskReward: number;
  notes: string[];
};

export type IntradayBurstEvidence = {
  score: number;
  supportScore: number;
  tradeDate: string;
  barTime: string;
  daysSince: number;
  intradayPct: number;
  intradayAmountRatio: number;
  dailyAmountRatio: number;
  dailyPct: number;
  followBars: number;
  burstLow: number;
  burstHigh: number;
  bodyMidpoint: number;
  brokeBurstLow: boolean;
  heldBodyMidpoint: boolean;
  pullbackAmountRatio: number;
  heavySelloff: boolean;
  breakoutConfirmed: boolean;
  brokeBurstDayLow: boolean;
  weakDriftDays: number;
};

export type SurgePullbackEvidence = {
  score: number;
  daysSince: number;
  surgePct: number;
  surgeAmountRatio: number;
  pullbackFromSurgeHigh: number;
  pullbackAmountRatio: number;
  heldCostArea: boolean;
};

export type BearishIntradayBurstEvidence = {
  barTime: string;
  tradeDate: string;
  intradayAmountRatio: number;
  bodyPct: number;
};

export type DataQuality = {
  status: "ok" | "partial" | "stale" | "pre_open";
  label: string;
  generatedAt: string;
  latestQuoteTime?: string;
  quoteDate?: string;
  totalQuotes: number;
  universeQuotes: number;
  validQuotes: number;
  validQuoteRatio: number;
  missingAmountRatio: number;
  missingTurnoverRatio: number;
  missingVolumeRatio: number;
  notes: string[];
};

export type StockPick = {
  rank: number;
  code: string;
  instrument: string;
  name: string;
  exchange: Exchange;
  signal: Signal;
  rating: string;
  setupState: SetupState;
  setupStateRank: number;
  setupAgeDays?: number;
  setupPreviousState?: SetupState;
  setupStateChanged?: boolean;
  score: number;
  confidence: number;
  price: number;
  pctChange: number;
  amount: number;
  turnover: number;
  volumeRatio: number;
  amountRatio20?: number;
  amountRatio5?: number;
  priceVolumeScore?: number;
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
  sector?: string;
  themes?: string[];
  sectorSource?: "biying" | "fallback";
  tradePlan?: TradePlan;
  concentration?: {
    sector: string;
    groupRank: number;
    groupSize: number;
    maxPerSector: number;
    demoted: boolean;
  };
  intradayBurst?: IntradayBurstEvidence;
  surgePullback?: SurgePullbackEvidence;
  bearishIntradayBurst?: BearishIntradayBurstEvidence;
  reasons: string[];
  risks: string[];
  history: SparkPoint[];
  intraday30m?: SparkPoint[];
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
  market?: MarketRegime;
  dataQuality?: DataQuality;
  concentration?: SectorConcentrationReport;
  changes?: DailyChangeSummary;
  picks: StockPick[];
  watchlist: StockPick[];
  avoided: StockPick[];
};

export type DailyChangeItem = {
  code: string;
  instrument: string;
  name: string;
  sector?: string;
  currentRank?: number;
  previousRank?: number;
  currentSignal?: Signal;
  previousSignal?: Signal;
  currentSetupState?: SetupState;
  previousSetupState?: SetupState;
  setupAgeDays?: number;
  score?: number;
  flowRatio5d?: number;
  consecutiveStrongDays?: number;
};

export type SectorChange = {
  sector: string;
  currentStrong: number;
  previousStrong: number;
  delta: number;
};

export type DailyChangeSummary = {
  previousTradeDate?: string;
  strongCountChange: number;
  headline: string;
  newStrong: DailyChangeItem[];
  upgradedToStrong: DailyChangeItem[];
  consecutiveStrong: DailyChangeItem[];
  downgradedFromStrong: DailyChangeItem[];
  exitedStrong: DailyChangeItem[];
  newSetups: DailyChangeItem[];
  strengthenedSetups: DailyChangeItem[];
  breakoutSetups: DailyChangeItem[];
  weakenedSetups: DailyChangeItem[];
  invalidatedSetups: DailyChangeItem[];
  sectorChanges: SectorChange[];
  notes: string[];
};

export type SectorConcentrationGroup = {
  sector: string;
  totalStrong: number;
  keptCore: number;
  demoted: number;
  maxPerSector: number;
  instruments: string[];
};

export type SectorConcentrationReport = {
  maxPerSector: number;
  applied: boolean;
  demoted: number;
  groups: SectorConcentrationGroup[];
  notes: string[];
};

export type MarketIndexSignal = {
  code: string;
  name: string;
  tradeDate: string;
  close: number;
  ma20: number;
  ma60: number;
  return5d: number;
  return20d: number;
  aboveMa20: boolean;
  aboveMa60: boolean;
  ma20Slope: number;
  score: number;
  reasons: string[];
};

export type MarketRegime = {
  state: MarketState;
  label: string;
  score: number;
  action: "allow_core" | "cap_core" | "observe_only";
  tradeDate: string;
  appliedToCore: boolean;
  indices: MarketIndexSignal[];
  reasons: string[];
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
  planReplay?: {
    entryTouched: boolean;
    stopLossTouched: boolean;
    target1Touched: boolean;
    target2Touched: boolean;
    firstTrigger?: "entry" | "stopLoss" | "target1" | "target2";
    firstTriggerDate?: string;
  };
  status: "complete" | "tracking";
};

export type HorizonSummary = {
  completed: number;
  winRate?: number;
  avgReturn?: number;
  medianReturn?: number;
};

export type StrategyHealth = {
  status: "good" | "watch" | "tighten";
  label: string;
  score: number;
  sampleSize: number;
  sampleWindow: number;
  action: "normal" | "light" | "pause";
  headline: string;
  metrics: {
    avgReturn5d?: number;
    winRate5d?: number;
    avgMaxDrawdown10d?: number;
    target1HitRate?: number;
    stopLossRate?: number;
    completed5d: number;
    completedPlan: number;
  };
  notes: string[];
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
    health?: StrategyHealth;
    planReplay?: {
      completed: number;
      entryTouches: number;
      stopLossHits: number;
      target1Hits: number;
      target2Hits: number;
      entryTouchRate?: number;
      stopLossRate?: number;
      target1HitRate?: number;
      target2HitRate?: number;
    };
  };
  records: ReviewRecord[];
};