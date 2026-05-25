import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  BadgeCheck,
  BarChart3,
  CalendarClock,
  Filter,
  History,
  Layers,
  Link as LinkIcon,
  ListChecks,
  Percent,
  Radar,
  Search,
  ShieldCheck,
  Target,
  TrendingUp
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import { ColorType, CrosshairMode, LineStyle, createChart } from "lightweight-charts";
import type {
  DailyChangeItem,
  MarketRegime,
  PlanReport,
  ReviewHorizon,
  ReviewRecord,
  ReviewReport,
  ScanReport,
  SectorConcentrationReport,
  Signal,
  StockActionState,
  StockPick
} from "./lib/types";

const signalOrder: Signal[] = ["strong", "watch", "wait"];
const reviewHorizons: ReviewHorizon[] = ["1d", "3d", "5d", "10d"];
const decisionTiers = [
  { key: "ready", label: "可操作", hint: "到关注区，资金仍在" },
  { key: "pullback", label: "等回踩", hint: "异动成立，价格偏高" },
  { key: "track", label: "继续跟踪", hint: "承接未坏，条件未齐" },
  { key: "risk", label: "风控提醒", hint: "承接或资金转弱" },
  { key: "invalid", label: "已失效", hint: "跌破计划防守线" },
  { key: "all", label: "全部", hint: "完整候选池" }
] as const;

type DecisionTier = (typeof decisionTiers)[number]["key"];

type SystemHealthReport = {
  generatedAt: string;
  tradeDate?: string;
  status: "ok" | "warn" | "risk";
  schedule: {
    closeRun: string;
    mailNotify: string;
  };
  reports: {
    tone: "ok" | "warn" | "risk";
    latestGeneratedAt?: string;
    planGeneratedAt?: string;
    reviewGeneratedAt?: string;
    latestPicks: number;
    latestWatchlist: number;
    planCount: number;
    reviewSignals: number;
  };
  strategyBacktest?: {
    tone: "ok" | "warn" | "risk";
    generatedAt?: string;
    tradeDate?: string;
    expectedTradeDate?: string;
    mainSignals: number;
    aestheticSignals: number;
    cooldown10dWinRate?: number;
    aesthetic10dWinRate?: number;
  };
  klineCache: {
    tone: "ok" | "warn" | "risk";
    generatedAt?: string;
    universe: number;
    dailyFiles: number;
    minute30Files: number;
    indexFiles: number;
    dailyBars: number;
    minute30Bars: number;
  };
  apiCache: {
    tone: "ok" | "warn" | "risk";
    moneyFlowFiles: number;
    profileFiles: number;
    refreshEnabledOnlyWhen: string;
  };
  intraday?: {
    status?: string;
    generatedAt?: string;
    hot: number;
    watch: number;
    risk: number;
  };
  notes: string[];
};

type StockDetailIndexItem = {
  code: string;
  instrument: string;
  name: string;
  sector?: string;
  latestRank?: number;
  latestSignal?: Signal;
  latestScore?: number;
  latestTradeDate?: string;
  planRank?: number;
  reviewSignals: number;
};

type StockDetailIndex = {
  generatedAt: string;
  total: number;
  items: StockDetailIndexItem[];
};

type StockDetailReport = {
  meta: {
    generatedAt: string;
    tradeDate?: string;
    source: string;
    notes: string[];
  };
  code: string;
  instrument: string;
  name: string;
  sector?: string;
  latestPick?: StockPick;
  planPick?: StockPick;
  reviewRecords: ReviewRecord[];
};

type StrategyStats = {
  samples: number;
  completed: number;
  targetHits: number;
  strongTargetHits: number;
  stretchTargetHits: number;
  winRate?: number;
  positiveCloseRate?: number;
  strongTargetRate?: number;
  stretchTargetRate?: number;
  avgCloseReturnPct?: number;
  avgMaxRunupPct?: number;
  avgMaxDrawdownPct?: number;
  avgPeakDay?: number;
};

type StrategyReplay = {
  horizon: number;
  status: "complete" | "pending";
  entryPrice: number;
  closeReturnPct?: number;
  maxRunupPct?: number;
  maxRunupDate?: string;
  maxRunupDay?: number;
  maxDrawdownPct?: number;
  maxDrawdownDate?: string;
  maxDrawdownDay?: number;
  targetHit?: boolean;
  strongTargetHit?: boolean;
  stretchTargetHit?: boolean;
};

type StrategyBacktestPick = {
  tradeDate: string;
  rank: number;
  instrument: string;
  name: string;
  score: number;
  strategyScore: number;
  signalLayer: "main" | "watch";
  actionState: StockActionState;
  price: number;
  pctChange?: number;
  setupState: StockPick["setupState"];
  flowRatio5d: number;
  valuePosition: number;
  pullbackFromHigh: number;
  intradayScore?: number;
  intradaySupportScore?: number;
  thirtyMinutePullbackScore?: number;
  thirtyMinuteShrinkRatio?: number;
  thirtyMinuteDrawdownFromHigh?: number;
  reasons: string[];
  risks: string[];
  cooldownDuplicate?: boolean;
  replay: Record<string, StrategyReplay>;
};

type StrategyAestheticPick = StrategyBacktestPick & {
  bucket: "near-main" | "intraday-support" | "low-repair";
  bucketLabel: string;
  bucketScore: number;
  priority: "high" | "medium" | "low";
  watchReason: string;
  matchReasons: string[];
};

type StrategyDailyRecord = {
  tradeDate: string;
  signals: number;
  mainSignals: number;
  watchSignals: number;
  cooldownEligibleSignals: number;
  cooldownSkippedSignals: number;
  picks: StrategyBacktestPick[];
};

type StrategyAestheticDailyRecord = {
  tradeDate: string;
  signals: number;
  cooldownEligibleSignals: number;
  cooldownSkippedSignals: number;
  byBucket: Record<string, number>;
  picks: StrategyAestheticPick[];
};

type StrategyAestheticReport = {
  summary: Record<string, StrategyStats>;
  cooldownSummary: Record<string, StrategyStats>;
  byBucket: Record<string, Record<string, StrategyStats>>;
  cooldownByBucket: Record<string, Record<string, StrategyStats>>;
  dailyRecords: StrategyAestheticDailyRecord[];
  picks: StrategyAestheticPick[];
};

type StrategyBacktestReport = {
  meta: {
    generatedAt: string;
    from?: string;
    to?: string;
    selectDate?: string;
    horizons: number[];
    top: number;
    targetPct: number;
    strongTargetPct: number;
    stretchTargetPct: number;
    cooldownDays: number;
    preset: string;
    aestheticTop?: number;
    evaluatedDates: number;
    universe: number;
    notes: string[];
  };
  summary: Record<string, StrategyStats>;
  cooldownSummary: Record<string, StrategyStats>;
  bySignalLayer: Record<string, Record<string, StrategyStats>>;
  cooldownBySignalLayer: Record<string, Record<string, StrategyStats>>;
  aestheticWatch?: StrategyAestheticReport;
  dailyRecords: StrategyDailyRecord[];
  picks: StrategyBacktestPick[];
};

function formatMoney(value?: number) {
  if (!value) return "-";
  if (Math.abs(value) >= 100_000_000) return `${(value / 100_000_000).toFixed(2)}亿`;
  if (Math.abs(value) >= 10_000) return `${(value / 10_000).toFixed(0)}万`;
  return `${Math.round(value)}`;
}

function formatPct(value?: number) {
  if (!Number.isFinite(value)) return "-";
  return `${value! > 0 ? "+" : ""}${value!.toFixed(2)}%`;
}

function signalText(signal: Signal) {
  if (signal === "strong") return "强关注";
  if (signal === "watch") return "观察";
  return "等待";
}

function setupStateClass(state?: string) {
  if (state === "二次突破" || state === "承接确认") return "setup-good";
  if (state === "缩量回踩" || state === "爆量启动") return "setup-watch";
  if (state === "承接转弱" || state === "放量派发风险" || state === "跌破失效") return "setup-risk";
  return "setup-neutral";
}

function marketTone(market?: MarketRegime): "neutral" | "green" | "amber" | "blue" | "red" {
  if (!market) return "neutral";
  if (market.state === "strong") return "green";
  if (market.state === "weak") return "red";
  return "amber";
}

function marketActionText(market?: MarketRegime) {
  if (!market) return "未启用市场过滤";
  if (market.action === "allow_core") return "允许核心池";
  if (market.action === "observe_only") return "只观察";
  return "收紧核心池";
}

function allPicks(report: ScanReport) {
  return [...report.picks, ...report.watchlist, ...report.avoided].sort((a, b) => a.rank - b.rank);
}

function isInvalidPick(pick: StockPick) {
  return pick.setupState === "跌破失效" || Boolean(pick.tradePlan && pick.price < pick.tradePlan.invalidBelow);
}

function isWeakPick(pick: StockPick) {
  return (
    pick.setupState === "承接转弱" ||
    pick.setupState === "放量派发风险" ||
    pick.flowRatio5d < 0 ||
    pick.risks.some((risk) => /跌破|派发|转弱|追高/.test(risk))
  );
}

function isExtendedPick(pick: StockPick) {
  const plan = pick.tradePlan;
  return (
    !isInvalidPick(pick) &&
    !isWeakPick(pick) &&
    pick.flowRatio5d >= 0.018 &&
    (pick.valuePosition > 62 || pick.pctChange > 3.5 || Boolean(plan && pick.price > plan.chaseAbove))
  );
}

function isHighValuePick(pick: StockPick) {
  const plan = pick.tradePlan;
  return (
    !isInvalidPick(pick) &&
    !isWeakPick(pick) &&
    Boolean(plan) &&
    pick.valuePosition <= 62 &&
    pick.pctChange <= 3.5 &&
    pick.flowRatio5d >= 0.025 &&
    Number(plan?.riskReward ?? 0) >= 1.15
  );
}

function isPullbackPick(pick: StockPick) {
  const plan = pick.tradePlan;
  return (
    !isInvalidPick(pick) &&
    !isWeakPick(pick) &&
    !isHighValuePick(pick) &&
    Boolean(plan) &&
    pick.flowRatio5d >= 0.012 &&
    (pick.price > Number(plan?.entryHigh ?? Infinity) || pick.distanceToMa20 > 4 || pick.valuePosition > 48)
  );
}

function isActionablePick(pick: StockPick) {
  return (
    !isInvalidPick(pick) &&
    !isWeakPick(pick) &&
    !isExtendedPick(pick) &&
    (isHighValuePick(pick) || pick.signal === "strong" || pick.setupState === "承接确认" || pick.setupState === "缩量回踩")
  );
}

function decisionTierOf(pick: StockPick): DecisionTier {
  if (pick.actionState) return pick.actionState;
  if (isInvalidPick(pick)) return "invalid";
  if (isWeakPick(pick)) return "risk";
  if (isExtendedPick(pick) || isPullbackPick(pick)) return "pullback";
  if (isHighValuePick(pick) || isActionablePick(pick)) return "ready";
  return "track";
}

function matchesDecisionTier(pick: StockPick, tier: DecisionTier) {
  if (tier === "all") return true;
  return decisionTierOf(pick) === tier;
}

function decisionTierCounts(picks: StockPick[]) {
  return Object.fromEntries(decisionTiers.map((tier) => [tier.key, picks.filter((pick) => matchesDecisionTier(pick, tier.key)).length])) as Record<DecisionTier, number>;
}

function actionLabel(pick: StockPick) {
  return pick.actionLabel ?? decisionTiers.find((tier) => tier.key === decisionTierOf(pick))?.label ?? "继续跟踪";
}

function parseStockHash() {
  const match = window.location.hash.match(/^#\/stock\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]).toUpperCase() : undefined;
}

function stockHash(instrument: string) {
  return `#/stock/${encodeURIComponent(instrument)}`;
}

function findPick(report: ScanReport, instrument?: string) {
  if (!instrument) return undefined;
  const key = instrument.toUpperCase();
  return allPicks(report).find((pick) => pick.instrument.toUpperCase() === key || pick.code.toUpperCase() === key);
}

function triggerText(trigger?: NonNullable<ReviewRecord["planReplay"]>["firstTrigger"]) {
  if (trigger === "entry") return "触达关注区";
  if (trigger === "stopLoss") return "触发止损";
  if (trigger === "target1") return "触达目标一";
  if (trigger === "target2") return "触达目标二";
  return "未触发";
}

function ChangeItemList({ items, empty }: { items: DailyChangeItem[]; empty: string }) {
  if (!items.length) return <div className="change-empty">{empty}</div>;

  return (
    <div className="change-list">
      {items.slice(0, 5).map((item) => {
        const stageText = item.currentSetupState
          ? `${item.currentSetupState}${item.setupAgeDays ? ` · ${item.setupAgeDays}天` : ""}`
          : item.sector ?? "未分组";
        return (
          <a key={item.instrument} className="change-item" href={stockHash(item.instrument)} aria-label={`打开 ${item.name} 详情`}>
            <div>
              <strong>{item.name}</strong>
              <span className="code">{item.instrument}</span>
            </div>
            <div>
              <span>{stageText}</span>
              <strong>{item.score !== undefined ? item.score.toFixed(1) : "-"}</strong>
            </div>
          </a>
        );
      })}
    </div>
  );
}

async function loadReport() {
  const base = import.meta.env.BASE_URL || "/";
  const response = await fetch(`${base}reports/latest.json?t=${Date.now()}`);
  if (!response.ok) throw new Error("no live report");
  return (await response.json()) as ScanReport;
}

async function loadReview() {
  const base = import.meta.env.BASE_URL || "/";
  const response = await fetch(`${base}reports/performance.json?t=${Date.now()}`);
  if (!response.ok) throw new Error("no review report");
  return (await response.json()) as ReviewReport;
}

async function loadStrategyBacktest() {
  const base = import.meta.env.BASE_URL || "/";
  const response = await fetch(`${base}reports/backtests/latest.json?t=${Date.now()}`);
  if (!response.ok) return undefined;
  return (await response.json()) as StrategyBacktestReport;
}

async function loadPlan() {
  const base = import.meta.env.BASE_URL || "/";
  const response = await fetch(`${base}reports/plan.json?t=${Date.now()}`);
  if (!response.ok) throw new Error("no plan report");
  return (await response.json()) as PlanReport;
}

async function loadSystemHealth() {
  const base = import.meta.env.BASE_URL || "/";
  const response = await fetch(`${base}reports/system-health.json?t=${Date.now()}`);
  if (!response.ok) return undefined;
  return (await response.json()) as SystemHealthReport;
}

async function loadStockIndex() {
  const base = import.meta.env.BASE_URL || "/";
  const response = await fetch(`${base}reports/stocks/index.json?t=${Date.now()}`);
  if (!response.ok) return undefined;
  return (await response.json()) as StockDetailIndex;
}

async function loadStockDetail(instrument: string) {
  const base = import.meta.env.BASE_URL || "/";
  const file = instrument.replace(/[^0-9A-Z.]/gi, "_");
  const response = await fetch(`${base}reports/stocks/${file}.json?t=${Date.now()}`);
  if (!response.ok) return undefined;
  return (await response.json()) as StockDetailReport;
}

function Metric({
  icon: Icon,
  label,
  value,
  tone = "neutral"
}: {
  icon: typeof Radar;
  label: string;
  value: string | number;
  tone?: "neutral" | "green" | "amber" | "blue" | "red";
}) {
  return (
    <section className={`metric metric-${tone}`}>
      <div className="metric-icon">
        <Icon size={18} />
      </div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
    </section>
  );
}

function ScoreRing({ value }: { value: number }) {
  const deg = Math.max(0, Math.min(100, value)) * 3.6;
  return (
    <div className="score-ring" style={{ background: `conic-gradient(#159a65 ${deg}deg, #dde5e0 ${deg}deg)` }}>
      <span>{value.toFixed(1)}</span>
    </div>
  );
}

function PlanRange({ pick }: { pick: StockPick }) {
  const plan = pick.tradePlan;
  if (!plan) return <span className="mobile-muted">暂无交易计划</span>;

  return (
    <>
      <span>{plan.entryLow.toFixed(2)}-{plan.entryHigh.toFixed(2)}</span>
      <span>{plan.positionLabel}{plan.positionPct}%</span>
    </>
  );
}

function MobilePickCard({
  pick,
  selected,
  onSelect,
  onOpen
}: {
  pick: StockPick;
  selected?: StockPick;
  onSelect: (pick: StockPick) => void;
  onOpen: (pick: StockPick) => void;
}) {
  return (
    <article className={selected?.instrument === pick.instrument ? "mobile-pick-card is-selected" : "mobile-pick-card"} onClick={() => onSelect(pick)}>
      <div className="mobile-card-head">
        <div>
          <div className="mobile-rank">#{pick.rank}</div>
          <h3>{pick.name}</h3>
          <p>{pick.instrument}</p>
        </div>
        <div className="mobile-card-badges">
          <span className={`action-chip action-${decisionTierOf(pick)}`}>{actionLabel(pick)}</span>
          <span className={`signal signal-${pick.signal}`}>{pick.rating}</span>
          <strong>{pick.score.toFixed(1)}</strong>
        </div>
      </div>

      <div className="mobile-price-row">
        <strong>{pick.price.toFixed(2)}</strong>
        <span className={pick.pctChange >= 0 ? "up" : "down"}>{formatPct(pick.pctChange)}</span>
        <span className={`setup-state ${setupStateClass(pick.setupState)}`}>{pick.setupState ?? "常规观察"}</span>
      </div>

      <div className="mobile-card-grid">
        <div>
          <span>5日资金</span>
          <strong className={pick.flow5d >= 0 ? "up" : "down"}>{formatMoney(pick.flow5d)}</strong>
        </div>
        <div>
          <span>资金占比</span>
          <strong className={pick.flowRatio5d >= 0 ? "up" : "down"}>{formatPct(pick.flowRatio5d)}</strong>
        </div>
        <div>
          <span>关注区</span>
          <strong className="mobile-plan-range">
            <PlanRange pick={pick} />
          </strong>
        </div>
      </div>

      <div className="mobile-card-foot">
        <span>{pick.sector ?? "未分组"}</span>
        <button
          className="mini-action"
          onClick={(event) => {
            event.stopPropagation();
            onOpen(pick);
          }}
        >
          详情
        </button>
      </div>
    </article>
  );
}

function PickTable({
  picks,
  selected,
  onSelect,
  onOpen
}: {
  picks: StockPick[];
  selected?: StockPick;
  onSelect: (pick: StockPick) => void;
  onOpen: (pick: StockPick) => void;
}) {
  return (
    <div className="table-wrap">
      <div className="mobile-pick-list">
        {picks.map((pick) => (
          <MobilePickCard key={pick.instrument} pick={pick} selected={selected} onSelect={onSelect} onOpen={onOpen} />
        ))}
      </div>
      <table className="desktop-table">
        <thead>
          <tr>
            <th>Rank</th>
            <th>代码</th>
            <th>名称</th>
            <th>主题</th>
            <th>操作</th>
            <th>信号</th>
            <th>阶段</th>
            <th>分数</th>
            <th>涨跌</th>
            <th>5日资金</th>
            <th>分位</th>
            <th>成交额</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {picks.map((pick) => (
            <tr
              key={pick.instrument}
              className={selected?.instrument === pick.instrument ? "is-selected" : ""}
              onClick={() => onSelect(pick)}
            >
              <td data-label="Rank">{pick.rank}</td>
              <td data-label="代码" className="code">{pick.instrument}</td>
              <td data-label="名称">{pick.name}</td>
              <td data-label="主题">{pick.sector ?? "-"}</td>
              <td data-label="操作">
                <span className={`action-chip action-${decisionTierOf(pick)}`}>{actionLabel(pick)}</span>
              </td>
              <td data-label="信号">
                <span className={`signal signal-${pick.signal}`}>{pick.rating}</span>
              </td>
              <td data-label="阶段">
                <span className={`setup-state ${setupStateClass(pick.setupState)}`}>{pick.setupState ?? "常规观察"}</span>
                {pick.setupAgeDays ? <span className="setup-age">{pick.setupAgeDays}天</span> : null}
              </td>
              <td data-label="分数">
                <strong>{pick.score.toFixed(1)}</strong>
              </td>
              <td data-label="涨跌" className={pick.pctChange >= 0 ? "up" : "down"}>{formatPct(pick.pctChange)}</td>
              <td data-label="5日资金" className={pick.flow5d >= 0 ? "up" : "down"}>{formatMoney(pick.flow5d)}</td>
              <td data-label="分位">{pick.valuePosition.toFixed(1)}%</td>
              <td data-label="成交额">{formatMoney(pick.amount)}</td>
              <td data-label="操作">
                <button
                  className="mini-action"
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpen(pick);
                  }}
                >
                  详情
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!picks.length && <div className="empty">当前过滤条件下没有标的</div>}
    </div>
  );
}

function DecisionTierPanel({
  picks,
  active,
  onChange
}: {
  picks: StockPick[];
  active: DecisionTier;
  onChange: (tier: DecisionTier) => void;
}) {
  const counts = useMemo(() => decisionTierCounts(picks), [picks]);

  return (
    <section className="decision-panel">
      {decisionTiers.map((tier) => (
        <button key={tier.key} className={active === tier.key ? "decision-card active" : "decision-card"} onClick={() => onChange(tier.key)}>
          <span>{tier.label}</span>
          <strong>{counts[tier.key]}</strong>
          <small>{tier.hint}</small>
        </button>
      ))}
    </section>
  );
}

function StockSearchPanel({
  query,
  index,
  currentRows,
  onOpen
}: {
  query: string;
  index?: StockDetailIndex;
  currentRows: StockPick[];
  onOpen: (instrument: string) => void;
}) {
  const needle = query.trim().toLowerCase();
  const current = new Set(currentRows.map((pick) => pick.instrument));
  const matches = useMemo(() => {
    if (!needle || needle.length < 2 || !index) return [];
    return index.items
      .filter((item) => {
        const text = `${item.code} ${item.instrument} ${item.name} ${item.sector ?? ""}`.toLowerCase();
        return text.includes(needle) && !current.has(item.instrument);
      })
      .slice(0, 8);
  }, [currentRows, index, needle]);

  if (!matches.length) return null;

  return (
    <section className="stock-search-panel">
      <div className="stock-search-head">
        <span>详情库匹配</span>
        <strong>{matches.length}</strong>
      </div>
      <div className="stock-search-list">
        {matches.map((item) => (
          <button key={item.instrument} onClick={() => onOpen(item.instrument)}>
            <div>
              <strong>{item.name}</strong>
              <span>{item.instrument}</span>
            </div>
            <div>
              <span>{item.sector ?? "未分组"}</span>
              <strong>{item.latestScore !== undefined ? item.latestScore.toFixed(1) : item.reviewSignals ? `${item.reviewSignals} 信号` : "详情"}</strong>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}

function DetailActions({ pick, onBack }: { pick: StockPick; onBack?: () => void }) {
  const href = stockHash(pick.instrument);

  return (
    <div className="detail-actions">
      {onBack && (
        <button className="icon-action" onClick={onBack} title="返回列表">
          <ArrowLeft size={16} />
          <span>返回</span>
        </button>
      )}
      <a className="icon-action" href={href} title="打开可分享详情链接">
        <LinkIcon size={16} />
        <span>详情链接</span>
      </a>
    </div>
  );
}

type ChartFrame = "daily" | "30m";

function chartTimestamp(date: string) {
  const normalized = date.includes(" ") ? `${date.replace(" ", "T")}${date.length === 16 ? ":00" : ""}+08:00` : `${date}T00:00:00+08:00`;
  return Math.floor(new Date(normalized).getTime() / 1000);
}

function chartDateLabel(value: string | number, frame: ChartFrame) {
  if (typeof value === "string") return value.slice(0, 10);
  const date = new Date(value * 1000);
  const yyyyMmDd = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
  if (frame === "daily") return yyyyMmDd;
  const hhMm = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
  return `${yyyyMmDd} ${hhMm}`;
}

function chartVolumeLabel(points: StockPick["history"]) {
  const hasVolume = points.some((point) => Number.isFinite(point.volume) && Number(point.volume) > 0);
  return hasVolume ? "成交量" : "成交额";
}

function ratioText(value?: number) {
  return Number.isFinite(value) ? `${Number(value).toFixed(2)}x` : "-";
}

function scoreText(value?: number) {
  return Number.isFinite(value) ? `${Number(value).toFixed(0)}分` : "-";
}

function sameChartDate(left?: string, right?: string) {
  return String(left ?? "").slice(0, 16) === String(right ?? "").slice(0, 16);
}

function KLineChart({ pick }: { pick: StockPick }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [frame, setFrame] = useState<ChartFrame>("daily");
  const frames = useMemo(
    () => [
      { key: "daily" as const, label: "日K", points: pick.history },
      { key: "30m" as const, label: "30分钟", points: pick.intraday30m ?? [] }
    ],
    [pick.history, pick.intraday30m]
  );
  const active = frames.find((item) => item.key === frame && item.points.length) ?? frames[0];

  useEffect(() => {
    if (!containerRef.current || !active.points.length) return;

    const container = containerRef.current;
    const chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientWidth < 520 ? 320 : 380,
      layout: {
        background: { type: ColorType.Solid, color: "#ffffff" },
        textColor: "#526057",
        fontFamily: "Inter, PingFang SC, Microsoft YaHei, Arial, sans-serif",
        attributionLogo: false
      },
      grid: {
        vertLines: { color: "#edf1ee" },
        horzLines: { color: "#edf1ee" }
      },
      leftPriceScale: {
        visible: false
      },
      rightPriceScale: {
        borderColor: "#dfe7e2",
        minimumWidth: container.clientWidth < 520 ? 48 : 56,
        scaleMargins: { top: 0.08, bottom: 0.28 }
      },
      timeScale: {
        borderColor: "#dfe7e2",
        rightOffset: 2,
        timeVisible: active.key === "30m",
        secondsVisible: false,
        tickMarkFormatter: (time: string | number) => chartDateLabel(time, active.key)
      },
      crosshair: {
        mode: CrosshairMode.Normal
      },
      localization: {
        priceFormatter: (price: number) => price.toFixed(2),
        timeFormatter: (time: string | number) => chartDateLabel(time, active.key)
      }
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: "#159a65",
      downColor: "#bd3c3c",
      borderUpColor: "#159a65",
      borderDownColor: "#bd3c3c",
      wickUpColor: "#159a65",
      wickDownColor: "#bd3c3c"
    });
    const volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "",
      base: 0,
      priceLineVisible: false,
      lastValueVisible: false
    });
    volumeSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.78, bottom: 0 }
    });

    const ma20Series = chart.addLineSeries({
      color: "#2563eb",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false
    });
    const ma60Series = chart.addLineSeries({
      color: "#9a6a15",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false
    });

    const sorted = [...active.points].sort((a, b) => a.date.localeCompare(b.date));
    const intradayBaseTime = active.key === "30m" ? chartTimestamp(sorted[0]?.date ?? "") : 0;
    const pointTime = (point: StockPick["history"][number], index: number) =>
      active.key === "30m" ? ((intradayBaseTime + index * 30 * 60) as never) : (point.date.slice(0, 10) as never);
    const candles = sorted.map((point, index) => {
      const close = Number(point.close);
      const open = Number.isFinite(point.open) ? Number(point.open) : close;
      const high = Number.isFinite(point.high) ? Number(point.high) : Math.max(open, close);
      const low = Number.isFinite(point.low) ? Number(point.low) : Math.min(open, close);
      return {
        time: pointTime(point, index),
        open,
        high,
        low,
        close
      };
    });
    const volumes = sorted.map((point, index) => {
      const candle = candles[index];
      return {
        time: candle.time,
        value: Number(point.volume && point.volume > 0 ? point.volume : point.amount ?? 0),
        color: candle.close >= candle.open ? "rgba(21, 154, 101, 0.46)" : "rgba(189, 60, 60, 0.42)"
      };
    });
    const ma20 = sorted.flatMap((point, index) =>
      Number.isFinite(point.ma20) ? [{ time: pointTime(point, index), value: Number(point.ma20) }] : []
    );
    const ma60 = sorted.flatMap((point, index) =>
      Number.isFinite(point.ma60) ? [{ time: pointTime(point, index), value: Number(point.ma60) }] : []
    );

    candleSeries.setData(candles);
    volumeSeries.setData(volumes);
    ma20Series.setData(ma20);
    ma60Series.setData(ma60);

    const markers = [];
    if (pick.intradayBurst) {
      const burstIndex =
        active.key === "30m"
          ? sorted.findIndex((point) => sameChartDate(point.date, pick.intradayBurst?.barTime))
          : sorted.findIndex((point) => point.date.slice(0, 10) === pick.intradayBurst?.tradeDate);
      if (burstIndex >= 0 && candles[burstIndex]) {
        markers.push({
          time: candles[burstIndex].time,
          position: "belowBar" as const,
          color: "#0f766e",
          shape: "arrowUp" as const,
          text: active.key === "30m" ? `爆量 ${ratioText(pick.intradayBurst.intradayAmountRatio)}` : `日量 ${ratioText(pick.intradayBurst.dailyAmountRatio)}`
        });
      }
      if (active.key === "30m" && pick.intradayBurst.breakoutConfirmed && burstIndex >= 0) {
        const breakoutIndex = sorted.findIndex((point, index) => {
          const close = Number(point.close);
          const open = Number.isFinite(point.open) ? Number(point.open) : close;
          return index > burstIndex && close > pick.intradayBurst!.burstHigh * 1.01 && close > open;
        });
        if (breakoutIndex >= 0 && candles[breakoutIndex]) {
          markers.push({
            time: candles[breakoutIndex].time,
            position: "belowBar" as const,
            color: "#2563eb",
            shape: "circle" as const,
            text: "二次突破"
          });
        }
      }
      if (active.key === "30m") {
        candleSeries.createPriceLine({
          price: pick.intradayBurst.burstLow,
          color: "#bd3c3c",
          lineStyle: LineStyle.Dashed,
          lineWidth: 1,
          axisLabelVisible: true,
          title: "启动低点"
        });
        candleSeries.createPriceLine({
          price: pick.intradayBurst.bodyMidpoint,
          color: "#9a6a15",
          lineStyle: LineStyle.Dotted,
          lineWidth: 1,
          axisLabelVisible: false,
          title: "实体中位"
        });
        candleSeries.createPriceLine({
          price: pick.intradayBurst.burstHigh,
          color: "#0f766e",
          lineStyle: LineStyle.Dashed,
          lineWidth: 1,
          axisLabelVisible: false,
          title: "爆量高点"
        });
      }
    }
    if (pick.bearishIntradayBurst) {
      const bearishIndex =
        active.key === "30m"
          ? sorted.findIndex((point) => sameChartDate(point.date, pick.bearishIntradayBurst?.barTime))
          : sorted.findIndex((point) => point.date.slice(0, 10) === pick.bearishIntradayBurst?.tradeDate);
      if (bearishIndex >= 0 && candles[bearishIndex]) {
        markers.push({
          time: candles[bearishIndex].time,
          position: "aboveBar" as const,
          color: "#bd3c3c",
          shape: "arrowDown" as const,
          text: `阴量 ${ratioText(pick.bearishIntradayBurst.intradayAmountRatio)}`
        });
      }
    }
    candleSeries.setMarkers(markers);

    const visibleBarCount = () => Math.min(candles.length, container.clientWidth < 520 ? 64 : active.key === "30m" ? 72 : 92);
    const applyVisibleRange = () => {
      const visibleBars = visibleBarCount();
      const rightOffset = container.clientWidth < 520 ? 1 : 2;
      const fromIndex = Math.max(0, candles.length - visibleBars);
      chart.timeScale().applyOptions({ rightOffset });
      chart.timeScale().setVisibleRange({ from: candles[fromIndex].time, to: candles[candles.length - 1].time });
    };
    applyVisibleRange();

    const resize = () => {
      chart.applyOptions({ width: container.clientWidth, height: container.clientWidth < 520 ? 320 : 380 });
      applyVisibleRange();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    window.addEventListener("resize", resize);
    resize();

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resize);
      chart.remove();
    };
  }, [active, pick.bearishIntradayBurst, pick.intradayBurst]);

  return (
    <div className="kline-block">
      <div className="kline-toolbar">
        <div className="chart-title">
          <BarChart3 size={16} />
          <span>K线与{chartVolumeLabel(active.points)}</span>
        </div>
        <div className="chart-frame-switch">
          {frames.map((item) => (
            <button key={item.key} className={active.key === item.key ? "active" : ""} disabled={!item.points.length} onClick={() => setFrame(item.key)}>
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <div className="kline-legend">
        <span><i className="legend-candle" /> 蜡烛</span>
        <span><i className="legend-ma20" /> MA20</span>
        <span><i className="legend-ma60" /> MA60</span>
        <span>{active.points.length} 根</span>
      </div>
      <div ref={containerRef} className="kline-canvas" />
      <a className="chart-attribution" href="https://www.tradingview.com/" target="_blank" rel="noreferrer">
        图表技术支持 TradingView
      </a>
    </div>
  );
}

function VolumeEvidencePanel({ pick }: { pick: StockPick }) {
  const burst = pick.intradayBurst;
  const surge = pick.surgePullback;
  const bearish = pick.bearishIntradayBurst;
  if (!burst && !surge && !bearish && pick.amountRatio20 === undefined && pick.priceVolumeScore === undefined) return null;

  const supportTone = burst?.brokeBurstLow || burst?.brokeBurstDayLow ? "down" : burst?.heldBodyMidpoint ? "up" : "";

  return (
    <div className="evidence-panel">
      <div className="evidence-head">
        <div className="chart-title">
          <Activity size={16} />
          <span>量价证据</span>
        </div>
        <span className={`evidence-state ${setupStateClass(pick.setupState)}`}>{pick.setupState}</span>
      </div>
      <div className="evidence-grid">
        <div>
          <span>30m爆量</span>
          <strong>{burst ? `${ratioText(burst.intradayAmountRatio)} · ${formatPct(burst.intradayPct)}` : "未触发"}</strong>
          <small>{burst ? `${burst.barTime} · ${burst.daysSince}天前` : "等待新的阳柱爆量"}</small>
        </div>
        <div>
          <span>日K放量</span>
          <strong>{burst ? `${ratioText(burst.dailyAmountRatio)} · ${formatPct(burst.dailyPct)}` : ratioText(pick.amountRatio20)}</strong>
          <small>{burst ? `相对前日成交额` : "相对20日均额"}</small>
        </div>
        <div>
          <span>承接质量</span>
          <strong className={supportTone}>{burst ? scoreText(burst.supportScore) : scoreText(pick.priceVolumeScore)}</strong>
          <small>{burst?.heldBodyMidpoint ? "守住启动实体中位" : burst ? "承接仍需确认" : "按当日量价评分"}</small>
        </div>
        <div>
          <span>回调缩量</span>
          <strong>{burst ? ratioText(burst.pullbackAmountRatio) : surge ? ratioText(surge.pullbackAmountRatio) : "-"}</strong>
          <small>{burst?.pullbackAmountRatio && burst.pullbackAmountRatio <= 0.75 ? "抛压收敛" : "观察回踩量能"}</small>
        </div>
        <div>
          <span>防守线</span>
          <strong className={burst?.brokeBurstDayLow || burst?.brokeBurstLow ? "down" : ""}>
            {burst ? `${burst.burstLow.toFixed(2)} / ${burst.bodyMidpoint.toFixed(2)}` : pick.tradePlan ? pick.tradePlan.invalidBelow.toFixed(2) : "-"}
          </strong>
          <small>{burst ? "启动低点 / 实体中位" : "交易计划失效位"}</small>
        </div>
        <div>
          <span>阴量风险</span>
          <strong className={bearish || burst?.heavySelloff ? "down" : "up"}>{bearish ? ratioText(bearish.intradayAmountRatio) : burst?.heavySelloff ? "放量回落" : "未触发"}</strong>
          <small>{bearish ? `${bearish.tradeDate} · ${formatPct(bearish.bodyPct)}` : "阴柱爆量会减分"}</small>
        </div>
      </div>
    </div>
  );
}

function ActionConclusion({ pick }: { pick: StockPick }) {
  const state = decisionTierOf(pick);
  const plan = pick.actionPlan;

  return (
    <section className={`action-conclusion action-${state}`}>
      <div>
        <span className="action-eyebrow">当前结论</span>
        <h3>{actionLabel(pick)}</h3>
        <p>{plan?.summary ?? pick.actionReason ?? "继续观察承接和资金连续性"}</p>
      </div>
      <div className="action-facts">
        <div>
          <span>下一价格</span>
          <strong>{pick.nextPrice ?? plan?.nextPrice ?? "-"}</strong>
        </div>
        <div>
          <span>失效位</span>
          <strong>{plan?.invalidBelow !== undefined ? plan.invalidBelow.toFixed(2) : pick.tradePlan?.invalidBelow.toFixed(2) ?? "-"}</strong>
        </div>
        <div>
          <span>仓位</span>
          <strong>{plan?.positionPct !== undefined ? `${plan.positionPct}%` : pick.tradePlan ? `${pick.tradePlan.positionPct}%` : "-"}</strong>
        </div>
      </div>
    </section>
  );
}

function PickDetail({ pick, reviewRecords, onBack }: { pick: StockPick; reviewRecords: ReviewRecord[]; onBack?: () => void }) {
  const plan = pick.tradePlan;
  const historySignals = reviewRecords
    .filter((record) => record.instrument === pick.instrument)
    .sort((a, b) => b.signalDate.localeCompare(a.signalDate))
    .slice(0, 4);

  return (
    <aside className="detail-panel">
      <DetailActions pick={pick} onBack={onBack} />
      <div className="detail-head">
        <div>
          <span className={`signal signal-${pick.signal}`}>{pick.rating}</span>
          <span className={`setup-state ${setupStateClass(pick.setupState)}`}>{pick.setupState ?? "常规观察"}</span>
          {pick.setupAgeDays ? <span className="setup-age">追踪 {pick.setupAgeDays} 天</span> : null}
          <h2>{pick.name}</h2>
          <p>{pick.instrument}</p>
        </div>
        <ScoreRing value={pick.score} />
      </div>

      <div className="price-line">
        <strong>{pick.price.toFixed(2)}</strong>
        <span className={pick.pctChange >= 0 ? "up" : "down"}>{formatPct(pick.pctChange)}</span>
        <span>信心 {pick.confidence}%</span>
      </div>

      <ActionConclusion pick={pick} />

      <div className="theme-line">
        <span className="theme-primary">{pick.sector ?? "未分组"}</span>
        {(pick.themes ?? []).slice(0, 5).map((theme) => (
          <span key={theme}>{theme}</span>
        ))}
      </div>

      {plan && (
        <div className="trade-plan">
          <div className="trade-plan-head">
            <h3>交易计划</h3>
            <span>
              {plan.positionLabel} · {plan.positionPct}%
            </span>
          </div>
          <div className="trade-plan-grid">
            <div>
              <span>关注区间</span>
              <strong>
                {plan.entryLow.toFixed(2)} - {plan.entryHigh.toFixed(2)}
              </strong>
            </div>
            <div>
              <span>追高线</span>
              <strong>{plan.chaseAbove.toFixed(2)}</strong>
            </div>
            <div>
              <span>失效位</span>
              <strong className="down">{plan.invalidBelow.toFixed(2)}</strong>
            </div>
            <div>
              <span>止损参考</span>
              <strong className="down">{plan.stopLoss.toFixed(2)}</strong>
            </div>
            <div>
              <span>目标一</span>
              <strong className="up">{plan.target1.toFixed(2)}</strong>
            </div>
            <div>
              <span>目标二</span>
              <strong className="up">{plan.target2.toFixed(2)}</strong>
            </div>
          </div>
          <ul>
            {plan.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      )}

      <KLineChart pick={pick} />
      <VolumeEvidencePanel pick={pick} />

      <div className="detail-grid">
        <div>
          <span>5日资金占比</span>
          <strong className={pick.flowRatio5d >= 0 ? "up" : "down"}>{pick.flowRatio5d.toFixed(2)}%</strong>
        </div>
        <div>
          <span>阶段分位</span>
          <strong>{pick.valuePosition.toFixed(1)}%</strong>
        </div>
        <div>
          <span>高点回撤</span>
          <strong>{pick.pullbackFromHigh.toFixed(1)}%</strong>
        </div>
        <div>
          <span>换手</span>
          <strong>{pick.turnover.toFixed(2)}%</strong>
        </div>
        <div>
          <span>距20日线</span>
          <strong>{formatPct(pick.distanceToMa20)}</strong>
        </div>
        <div>
          <span>距60日线</span>
          <strong>{formatPct(pick.distanceToMa60)}</strong>
        </div>
      </div>

      <div className="history-card">
        <div className="chart-title">
          <History size={16} />
          <span>历史信号</span>
        </div>
        {historySignals.length ? (
          <div className="signal-history">
            {historySignals.map((record) => (
              <div key={`${record.signalDate}-${record.instrument}`} className="signal-history-row">
                <div>
                  <strong>{record.signalDate}</strong>
                  <span>
                    Rank {record.rank} · 评分 {record.score.toFixed(1)}
                  </span>
                </div>
                <div className="history-values">
                  <span>
                    5日 <ReviewReturn value={record.horizons["5d"].returnPct} />
                  </span>
                  <span>
                    浮盈 <ReviewReturn value={record.maxRunup10d} />
                  </span>
                  <span>{triggerText(record.planReplay?.firstTrigger)}</span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty small-empty">暂无历史核心信号</div>
        )}
      </div>

      <div className="reason-block">
        <h3>入选依据</h3>
        <ul>
          {pick.reasons.map((reason) => (
            <li key={reason}>
              <BadgeCheck size={15} />
              {reason}
            </li>
          ))}
        </ul>
      </div>

      <div className="reason-block risk-block">
        <h3>风险点</h3>
        <ul>
          {(pick.risks.length ? pick.risks : ["未触发主要风险标签"]).map((risk) => (
            <li key={risk}>
              <AlertTriangle size={15} />
              {risk}
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}

function SystemStatusPanel({
  report,
  review,
  health,
  status
}: {
  report: ScanReport;
  review: ReviewReport;
  health?: SystemHealthReport;
  status: "loading" | "live" | "sample";
}) {
  const reportFresh = report.meta.tradeDate === review.records[0]?.signalDate || review.meta.historyReports > 0;
  const dataTone = status === "live" ? "tag-ok" : status === "loading" ? "tag-warn" : "tag-warn";
  const quality = report.dataQuality;
  const qualityTone = quality?.status === "ok" ? "tag-ok" : quality?.status === "partial" ? "tag-warn" : "tag-risk";

  return (
    <section className="status-panel">
      <div className="status-head">
        <div>
          <h2>系统状态</h2>
          <span>{report.meta.source} · 下一次 {report.meta.nextRunHint}</span>
        </div>
        <span className={dataTone}>{status === "live" ? "Live 数据" : status === "loading" ? "加载中" : "Sample 数据"}</span>
      </div>
      <div className="status-grid">
        <div>
          <Activity size={16} />
          <span>扫描时间</span>
          <strong>{report.meta.generatedAt.replace("T", " ").slice(0, 19)}</strong>
        </div>
        <div>
          <ListChecks size={16} />
          <span>复盘样本</span>
          <strong>{review.summary.totalSignals} 个信号</strong>
        </div>
        <div>
          <ShieldCheck size={16} />
          <span>报告状态</span>
          <strong>{reportFresh ? "已归档" : "待归档"}</strong>
        </div>
        <div>
          <Target size={16} />
          <span>交易计划命中</span>
          <strong>{review.summary.planReplay?.target1HitRate !== undefined ? `${review.summary.planReplay.target1HitRate}%` : "追踪中"}</strong>
        </div>
        {quality && (
          <div>
            <Activity size={16} />
            <span>数据质量</span>
            <strong>{quality.label}</strong>
            <small className={qualityTone}>
              有效 {quality.validQuoteRatio}% · 缺量比 {quality.missingVolumeRatio}%
            </small>
          </div>
        )}
      </div>
      {quality?.notes.length ? <p className="data-quality-note">{quality.notes.join("；")}</p> : null}
      {health && (
        <div className="system-health-grid">
          <div className={`system-health-card health-${health.klineCache.tone}`}>
            <span>K线缓存</span>
            <strong>{health.klineCache.dailyFiles.toLocaleString("zh-CN")} / {health.klineCache.minute30Files.toLocaleString("zh-CN")}</strong>
            <small>日K / 30m · {health.klineCache.generatedAt ?? "未生成"}</small>
          </div>
          <div className={`system-health-card health-${health.apiCache.tone}`}>
            <span>API缓存</span>
            <strong>{health.apiCache.moneyFlowFiles.toLocaleString("zh-CN")} / {health.apiCache.profileFiles.toLocaleString("zh-CN")}</strong>
            <small>资金流 / 公司资料</small>
          </div>
          <div className={`system-health-card health-${health.reports.tone}`}>
            <span>报告产出</span>
            <strong>{health.reports.latestWatchlist} 观察 · {health.reports.planCount} 预案</strong>
            <small>{health.generatedAt}</small>
          </div>
          {health.strategyBacktest && (
            <div className={`system-health-card health-${health.strategyBacktest.tone}`}>
              <span>策略实验</span>
              <strong>{health.strategyBacktest.mainSignals} 主选 · {health.strategyBacktest.aestheticSignals} 审美</strong>
              <small>
                {health.strategyBacktest.tradeDate ?? "未生成"}
                {health.strategyBacktest.expectedTradeDate && health.strategyBacktest.tradeDate !== health.strategyBacktest.expectedTradeDate
                  ? ` · 需同步 ${health.strategyBacktest.expectedTradeDate}`
                  : ""}
              </small>
            </div>
          )}
          <div className={`system-health-card health-${health.status}`}>
            <span>定时任务</span>
            <strong>{health.schedule.closeRun}</strong>
            <small>邮件 {health.schedule.mailNotify}</small>
          </div>
        </div>
      )}
    </section>
  );
}

function ChangeSummaryPanel({ report }: { report: ScanReport }) {
  const changes = report.changes;
  if (!changes) return null;

  const newOrUpgraded = [...changes.newStrong, ...changes.upgradedToStrong].sort((a, b) => (a.currentRank ?? 999) - (b.currentRank ?? 999));
  const leftCore = [...changes.downgradedFromStrong, ...changes.exitedStrong];
  const newSetups = changes.newSetups ?? [];
  const strengthenedSetups = changes.strengthenedSetups ?? [];
  const breakoutSetups = changes.breakoutSetups ?? [];
  const weakOrInvalidSetups = [...(changes.weakenedSetups ?? []), ...(changes.invalidatedSetups ?? [])];
  const topSectors = changes.sectorChanges.filter((sector) => sector.currentStrong > 0).slice(0, 4);

  return (
    <section className="change-panel">
      <div className="change-head">
        <div>
          <h2>今日变化</h2>
          <span>{changes.previousTradeDate ? `对比 ${changes.previousTradeDate}` : "暂无上一交易日对比"}</span>
        </div>
        <strong className={changes.strongCountChange >= 0 ? "up" : "down"}>
          {changes.strongCountChange > 0 ? "+" : ""}
          {changes.strongCountChange}
        </strong>
      </div>
      <p>{changes.headline}</p>
      <div className="change-grid setup-change-grid">
        <div className="change-block">
          <h3>新异动</h3>
          <ChangeItemList items={newSetups} empty="暂无新异动" />
        </div>
        <div className="change-block">
          <h3>承接转强</h3>
          <ChangeItemList items={strengthenedSetups} empty="暂无承接转强" />
        </div>
        <div className="change-block">
          <h3>二次突破</h3>
          <ChangeItemList items={breakoutSetups} empty="暂无二次突破" />
        </div>
        <div className="change-block">
          <h3>转弱/失效</h3>
          <ChangeItemList items={weakOrInvalidSetups} empty="暂无转弱或失效" />
        </div>
      </div>
      <div className="change-grid">
        <div className="change-block">
          <h3>新晋强关注</h3>
          <ChangeItemList items={newOrUpgraded} empty="今天没有新晋强关注" />
        </div>
        <div className="change-block">
          <h3>连续入选</h3>
          <ChangeItemList
            items={changes.consecutiveStrong.map((item) => ({
              ...item,
              sector: item.consecutiveStrongDays ? `${item.sector ?? "未分组"} · ${item.consecutiveStrongDays}天` : item.sector
            }))}
            empty="暂无连续入选标的"
          />
        </div>
        <div className="change-block">
          <h3>降级/退出</h3>
          <ChangeItemList items={leftCore} empty="今天没有核心池降级或退出" />
        </div>
      </div>
      <div className="sector-change-strip">
        {topSectors.map((sector) => (
          <span key={sector.sector} className={sector.delta >= 0 ? "tag-ok" : "tag-warn"}>
            {sector.sector} {sector.currentStrong}只 {sector.delta > 0 ? `+${sector.delta}` : sector.delta}
          </span>
        ))}
      </div>
    </section>
  );
}

function MarketPanel({ market }: { market?: MarketRegime }) {
  if (!market) return null;

  return (
    <section className={`market-panel market-${market.state}`}>
      <div className="market-head">
        <div>
          <h2>市场环境</h2>
          <span>{market.tradeDate} · {marketActionText(market)}</span>
        </div>
        <div className="market-score">
          <strong>{market.label}</strong>
          <span>{market.score.toFixed(1)}</span>
        </div>
      </div>
      <div className="market-index-grid">
        {market.indices.map((index) => (
          <div key={index.code} className="market-index">
            <div>
              <strong>{index.name}</strong>
              <span>{index.code}</span>
            </div>
            <p>{index.close.toFixed(2)}</p>
            <div className="market-tags">
              <span className={index.aboveMa20 ? "tag-ok" : "tag-warn"}>20日</span>
              <span className={index.aboveMa60 ? "tag-ok" : "tag-warn"}>60日</span>
              <span className={index.return5d >= 0 ? "tag-ok" : "tag-warn"}>{formatPct(index.return5d)}</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function ConcentrationPanel({ concentration }: { concentration?: SectorConcentrationReport }) {
  if (!concentration) return null;

  return (
    <section className="concentration-panel">
      <div className="market-head">
        <div>
          <h2>行业集中度</h2>
          <span>同一主题核心池最多 {concentration.maxPerSector} 只</span>
        </div>
        <div className="market-score">
          <strong>{concentration.applied ? "已触发" : "未触发"}</strong>
          <span>{concentration.demoted} 只降级</span>
        </div>
      </div>
      <div className="sector-bars">
        {concentration.groups.slice(0, 8).map((group) => (
          <div key={group.sector} className={group.demoted ? "sector-bar is-capped" : "sector-bar"}>
            <div>
              <strong>{group.sector}</strong>
              <span>
                核心 {group.keptCore}/{group.totalStrong}
                {group.demoted ? ` · 降级 ${group.demoted}` : ""}
              </span>
            </div>
            <div className="sector-track">
              <span style={{ width: `${Math.min(100, (group.keptCore / Math.max(group.totalStrong, 1)) * 100)}%` }} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function horizonLabel(horizon: ReviewHorizon) {
  return horizon.replace("d", "日");
}

function ReviewReturn({ value }: { value?: number }) {
  if (!Number.isFinite(value)) return <span className="muted">追踪中</span>;
  return <span className={value! >= 0 ? "up" : "down"}>{formatPct(value)}</span>;
}

function formatRate(value?: number) {
  return Number.isFinite(value) ? `${Number(value).toFixed(1)}%` : "追踪中";
}

function replayValue(pick: StrategyBacktestPick, horizon: "5d" | "10d", key: "maxRunupPct" | "closeReturnPct" | "maxDrawdownPct") {
  const replay = pick.replay[horizon];
  if (!replay || replay.status !== "complete") return undefined;
  return replay[key];
}

function strategyDate(report: StrategyBacktestReport) {
  return report.meta.selectDate ?? report.meta.to ?? report.meta.from ?? "-";
}

function strategyPicksForDate<T extends StrategyBacktestPick>(picks: T[], date: string) {
  return picks.filter((pick) => pick.tradeDate === date).sort((a, b) => a.rank - b.rank);
}

function isAestheticPick(pick: StrategyBacktestPick | StrategyAestheticPick): pick is StrategyAestheticPick {
  return "bucketLabel" in pick;
}

function StrategyStatsTable({ title, rows }: { title: string; rows: Record<string, StrategyStats> }) {
  const horizons = Object.entries(rows);
  if (!horizons.length) return null;

  return (
    <section className="list-panel strategy-stats-panel">
      <div className="panel-toolbar">
        <div>
          <h2>{title}</h2>
          <span>选出后直接观察未来 5/10 日，不模拟买卖点</span>
        </div>
      </div>
      <div className="strategy-kpis">
        {horizons.map(([horizon, stats]) => (
          <div key={horizon}>
            <span>{horizon.replace("d", "日")}最高触达</span>
            <strong>{formatRate(stats.winRate)}</strong>
            <small>
              {stats.completed}/{stats.samples} 完成 · 平均最高 {formatPct(stats.avgMaxRunupPct)}
            </small>
          </div>
        ))}
      </div>
    </section>
  );
}

function StrategyBucketTable({ report }: { report?: StrategyAestheticReport }) {
  if (!report) return null;
  const rows = Object.entries(report.cooldownByBucket).flatMap(([bucket, horizons]) =>
    Object.entries(horizons).map(([horizon, stats]) => ({
      bucket,
      label: report.picks.find((pick) => pick.bucket === bucket)?.bucketLabel ?? bucket,
      horizon,
      stats
    }))
  );

  return (
    <section className="list-panel">
      <div className="panel-toolbar">
        <div>
          <h2>审美分桶回测</h2>
          <span>独立观察池，默认同票 {rows.length ? "冷却去重后" : ""}统计</span>
        </div>
      </div>
      <div className="table-wrap strategy-table">
        <table>
          <thead>
            <tr>
              <th>分桶</th>
              <th>窗口</th>
              <th>样本</th>
              <th>最高+5%</th>
              <th>最高+8%</th>
              <th>最高+10%</th>
              <th>平均收盘</th>
              <th>平均最高</th>
              <th>平均回撤</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ bucket, label, horizon, stats }) => (
              <tr key={`${bucket}-${horizon}`}>
                <td>{label}</td>
                <td>{horizon.replace("d", "日")}</td>
                <td>{stats.completed}/{stats.samples}</td>
                <td>{formatRate(stats.winRate)}</td>
                <td>{formatRate(stats.strongTargetRate)}</td>
                <td>{formatRate(stats.stretchTargetRate)}</td>
                <td><ReviewReturn value={stats.avgCloseReturnPct} /></td>
                <td><ReviewReturn value={stats.avgMaxRunupPct} /></td>
                <td><ReviewReturn value={stats.avgMaxDrawdownPct} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function MobileStrategyCard({ pick }: { pick: StrategyBacktestPick | StrategyAestheticPick }) {
  const isAesthetic = isAestheticPick(pick);
  return (
    <article className="mobile-review-card strategy-mobile-card">
      <div className="mobile-card-head">
        <div>
          <div className="mobile-rank">#{pick.rank} · {pick.tradeDate}</div>
          <h3>{pick.name}</h3>
          <p>{pick.instrument}</p>
        </div>
        <div className="mobile-card-badges">
          <span className={`action-chip action-${pick.actionState}`}>{isAesthetic ? pick.bucketLabel : pick.signalLayer}</span>
          <strong>{(isAesthetic ? pick.bucketScore : pick.strategyScore).toFixed(1)}</strong>
        </div>
      </div>
      <div className="mobile-review-grid">
        <div>
          <span>5日最高</span>
          <strong><ReviewReturn value={replayValue(pick, "5d", "maxRunupPct")} /></strong>
        </div>
        <div>
          <span>10日最高</span>
          <strong><ReviewReturn value={replayValue(pick, "10d", "maxRunupPct")} /></strong>
        </div>
        <div>
          <span>分位</span>
          <strong>{pick.valuePosition.toFixed(1)}%</strong>
        </div>
        <div>
          <span>30m</span>
          <strong>{pick.thirtyMinutePullbackScore ?? "-"}</strong>
        </div>
      </div>
      <div className="mobile-card-foot">
        <span>{isAesthetic ? pick.watchReason : pick.setupState}</span>
        <span>{formatPct(pick.flowRatio5d)}</span>
      </div>
    </article>
  );
}

function StrategyPickTable({ title, subtitle, picks }: { title: string; subtitle: string; picks: Array<StrategyBacktestPick | StrategyAestheticPick> }) {
  return (
    <section className="list-panel">
      <div className="panel-toolbar">
        <div>
          <h2>{title}</h2>
          <span>{subtitle}</span>
        </div>
      </div>
      <div className="table-wrap strategy-table">
        <div className="mobile-strategy-list">
          {picks.map((pick) => (
            <MobileStrategyCard key={`${pick.tradeDate}-${pick.instrument}-${isAestheticPick(pick) ? pick.bucket : "main"}`} pick={pick} />
          ))}
        </div>
        <table className="desktop-table">
          <thead>
            <tr>
              <th>Rank</th>
              <th>代码</th>
              <th>名称</th>
              <th>类型</th>
              <th>价格</th>
              <th>分数</th>
              <th>状态</th>
              <th>形态</th>
              <th>5日资金</th>
              <th>分位</th>
              <th>回撤</th>
              <th>30m</th>
              <th>5日最高</th>
              <th>10日最高</th>
            </tr>
          </thead>
          <tbody>
            {picks.map((pick) => {
              const aesthetic = isAestheticPick(pick);
              return (
                <tr key={`${pick.tradeDate}-${pick.instrument}-${aesthetic ? pick.bucket : "main"}`}>
                  <td>{pick.rank}</td>
                  <td className="code">{pick.instrument}</td>
                  <td>{pick.name}</td>
                  <td>{aesthetic ? pick.bucketLabel : pick.signalLayer === "main" ? "主策略" : "观察"}</td>
                  <td>{pick.price.toFixed(2)}</td>
                  <td><strong>{(aesthetic ? pick.bucketScore : pick.strategyScore).toFixed(1)}</strong></td>
                  <td><span className={`action-chip action-${pick.actionState}`}>{pick.actionState}</span></td>
                  <td><span className={`setup-state ${setupStateClass(pick.setupState)}`}>{pick.setupState}</span></td>
                  <td><ReviewReturn value={pick.flowRatio5d} /></td>
                  <td>{pick.valuePosition.toFixed(1)}%</td>
                  <td>{pick.pullbackFromHigh.toFixed(1)}%</td>
                  <td>{pick.thirtyMinutePullbackScore ?? "-"} / {pick.thirtyMinuteShrinkRatio ?? "-"}</td>
                  <td><ReviewReturn value={replayValue(pick, "5d", "maxRunupPct")} /></td>
                  <td><ReviewReturn value={replayValue(pick, "10d", "maxRunupPct")} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!picks.length && <div className="empty">这个交易日没有选出标的</div>}
      </div>
    </section>
  );
}

function StrategyDailyLedger({ report }: { report: StrategyBacktestReport }) {
  const aestheticByDate = new Map((report.aestheticWatch?.dailyRecords ?? []).map((day) => [day.tradeDate, day]));
  const days = report.dailyRecords.slice(-20).reverse();

  return (
    <section className="list-panel">
      <div className="panel-toolbar">
        <div>
          <h2>每日流水</h2>
          <span>最近 20 个回测交易日</span>
        </div>
      </div>
      <div className="table-wrap strategy-table">
        <table>
          <thead>
            <tr>
              <th>日期</th>
              <th>主策略</th>
              <th>主选</th>
              <th>观察</th>
              <th>冷却跳过</th>
              <th>审美池</th>
            </tr>
          </thead>
          <tbody>
            {days.map((day) => {
              const aesthetic = aestheticByDate.get(day.tradeDate);
              return (
                <tr key={day.tradeDate}>
                  <td>{day.tradeDate}</td>
                  <td>{day.signals}</td>
                  <td>{day.mainSignals}</td>
                  <td>{day.watchSignals}</td>
                  <td>{day.cooldownSkippedSignals}</td>
                  <td>{aesthetic?.signals ?? 0}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function StrategyPanel({ report }: { report?: StrategyBacktestReport }) {
  if (!report) {
    return (
      <section className="review-panel">
        <div className="empty standalone-empty">还没有生成策略实验报告，请先运行 backtest:strategy。</div>
      </section>
    );
  }

  const date = strategyDate(report);
  const latestMain = strategyPicksForDate(report.picks, date);
  const latestAesthetic = strategyPicksForDate(report.aestheticWatch?.picks ?? [], date);
  const tenDay = report.cooldownSummary["10d"] ?? report.summary["10d"];
  const aestheticTen = report.aestheticWatch?.cooldownSummary["10d"] ?? report.aestheticWatch?.summary["10d"];

  return (
    <section className="review-panel strategy-panel">
      <div className="summary-grid review-summary">
        <Metric icon={CalendarClock} label="策略交易日" value={date} tone="blue" />
        <Metric icon={ListChecks} label="当日主策略" value={latestMain.length} tone="green" />
        <Metric icon={Layers} label="当日审美池" value={latestAesthetic.length} tone="amber" />
        <Metric icon={Target} label="主策略10日" value={formatRate(tenDay?.winRate)} tone="green" />
        <Metric icon={Percent} label="审美池10日" value={formatRate(aestheticTen?.winRate)} tone="blue" />
        <Metric icon={History} label="回测交易日" value={report.meta.evaluatedDates} />
      </div>

      <div className="strategy-meta">
        <span>{report.meta.generatedAt.replace("T", " ").slice(0, 19)}</span>
        <span>样本 {report.meta.from ?? "-"} 至 {report.meta.to ?? "-"} · preset {report.meta.preset}</span>
        <span>目标 {report.meta.targetPct}% / {report.meta.strongTargetPct}% / {report.meta.stretchTargetPct}% · 冷却 {report.meta.cooldownDays} 日</span>
      </div>

      <div className="strategy-grid">
        <StrategyStatsTable title="主策略冷却统计" rows={report.cooldownSummary} />
        <StrategyStatsTable title="审美池冷却统计" rows={report.aestheticWatch?.cooldownSummary ?? {}} />
      </div>

      <div className="strategy-grid">
        <StrategyPickTable title="当日主策略" subtitle="不放宽当前稳定版，只展示真正通过条件的票" picks={latestMain} />
        <StrategyPickTable title="当日审美观察池" subtitle="接近主策略、30m承接、低位修复三类单独观察" picks={latestAesthetic} />
      </div>

      <div className="strategy-grid">
        <StrategyBucketTable report={report.aestheticWatch} />
        <StrategyDailyLedger report={report} />
      </div>

      <StrategyStatsTable title="主策略原始统计" rows={report.summary} />
    </section>
  );
}

function MobileReviewCard({ record }: { record: ReviewRecord }) {
  return (
    <article className="mobile-review-card">
      <div className="mobile-card-head">
        <div>
          <div className="mobile-rank">{record.signalDate}</div>
          <h3>{record.name}</h3>
          <p>{record.instrument} · 信号价 {record.signalPrice.toFixed(2)}</p>
        </div>
        <div className="mobile-card-badges">
          <span className="signal signal-strong">Rank {record.rank}</span>
          <strong>{record.score.toFixed(1)}</strong>
        </div>
      </div>
      <div className="mobile-review-grid">
        {reviewHorizons.map((horizon) => (
          <div key={horizon}>
            <span>{horizonLabel(horizon)}</span>
            <strong>
              <ReviewReturn value={record.horizons[horizon].returnPct} />
            </strong>
          </div>
        ))}
      </div>
      <div className="mobile-card-foot">
        <span>{triggerText(record.planReplay?.firstTrigger)}</span>
        <span>浮盈 <ReviewReturn value={record.maxRunup10d} /></span>
      </div>
    </article>
  );
}

function ReviewTable({ records }: { records: ReviewRecord[] }) {
  return (
    <div className="table-wrap review-table">
      <div className="mobile-review-list">
        {records.map((record) => (
          <MobileReviewCard key={`${record.signalDate}-${record.instrument}`} record={record} />
        ))}
      </div>
      <table className="desktop-table">
        <thead>
          <tr>
            <th>信号日</th>
            <th>代码</th>
            <th>名称</th>
            <th>信号价</th>
            <th>1日</th>
            <th>3日</th>
            <th>5日</th>
            <th>10日</th>
            <th>10日浮盈</th>
            <th>3日低吸</th>
            <th>10日回撤</th>
            <th>计划触发</th>
          </tr>
        </thead>
        <tbody>
          {records.map((record) => (
            <tr key={`${record.signalDate}-${record.instrument}`}>
              <td data-label="信号日">{record.signalDate}</td>
              <td data-label="代码" className="code">{record.instrument}</td>
              <td data-label="名称">{record.name}</td>
              <td data-label="信号价">{record.signalPrice.toFixed(2)}</td>
              {reviewHorizons.map((horizon) => (
                <td key={horizon} data-label={horizonLabel(horizon)}>
                  <ReviewReturn value={record.horizons[horizon].returnPct} />
                </td>
              ))}
              <td data-label="10日浮盈">
                <ReviewReturn value={record.maxRunup10d} />
              </td>
              <td data-label="3日低吸">
                <ReviewReturn value={record.bestEntryDrawdown3d} />
              </td>
              <td data-label="10日回撤">
                <ReviewReturn value={record.maxDrawdown10d} />
              </td>
              <td data-label="计划触发">{triggerText(record.planReplay?.firstTrigger)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!records.length && <div className="empty">还没有可复盘的核心信号</div>}
    </div>
  );
}

function StrategyHealthPanel({ review }: { review: ReviewReport }) {
  const health = review.summary.health;
  if (!health) return null;

  const actionText = health.action === "normal" ? "正常执行" : health.action === "light" ? "轻仓观察" : "暂停加仓";
  const toneClass = health.status === "good" ? "health-good" : health.status === "watch" ? "health-watch" : "health-tighten";

  return (
    <section className={`health-panel ${toneClass}`}>
      <div className="health-main">
        <div>
          <span className="health-label">策略健康度</span>
          <h2>{health.label}</h2>
          <p>{health.headline}</p>
        </div>
        <div className="health-score">
          <strong>{health.score.toFixed(1)}</strong>
          <span>{actionText}</span>
        </div>
      </div>
      <div className="health-grid">
        <div>
          <span>5日均收</span>
          <strong>{health.metrics.avgReturn5d !== undefined ? formatPct(health.metrics.avgReturn5d) : "追踪中"}</strong>
          <small>{health.metrics.completed5d} 个样本</small>
        </div>
        <div>
          <span>5日胜率</span>
          <strong>{health.metrics.winRate5d !== undefined ? `${health.metrics.winRate5d}%` : "追踪中"}</strong>
          <small>最近 {health.sampleWindow} 个核心信号</small>
        </div>
        <div>
          <span>平均回撤</span>
          <strong>{health.metrics.avgMaxDrawdown10d !== undefined ? formatPct(health.metrics.avgMaxDrawdown10d) : "追踪中"}</strong>
          <small>10日窗口</small>
        </div>
        <div>
          <span>目标一</span>
          <strong>{health.metrics.target1HitRate !== undefined ? `${health.metrics.target1HitRate}%` : "追踪中"}</strong>
          <small>{health.metrics.completedPlan} 个计划样本</small>
        </div>
        <div>
          <span>止损触发</span>
          <strong>{health.metrics.stopLossRate !== undefined ? `${health.metrics.stopLossRate}%` : "追踪中"}</strong>
          <small>越低越好</small>
        </div>
      </div>
    </section>
  );
}

function ReviewPanel({ review }: { review: ReviewReport }) {
  const summaryBars = reviewHorizons.map((horizon) => ({
    name: horizonLabel(horizon),
    avg: review.summary.horizons[horizon].avgReturn ?? 0,
    winRate: review.summary.horizons[horizon].winRate ?? 0,
    completed: review.summary.horizons[horizon].completed
  }));
  const fiveDay = review.summary.horizons["5d"];

  return (
    <section className="review-panel">
      <div className="summary-grid review-summary">
        <Metric icon={ListChecks} label="核心信号" value={review.summary.totalSignals} tone="blue" />
        <Metric icon={Target} label="10日完成" value={review.summary.completed10d} />
        <Metric icon={Percent} label="5日胜率" value={fiveDay.winRate !== undefined ? `${fiveDay.winRate}%` : "追踪中"} tone="green" />
        <Metric icon={History} label="历史报告" value={review.meta.historyReports} tone="amber" />
        <Metric icon={AlertTriangle} label="10日回撤" value={review.summary.avgMaxDrawdown10d !== undefined ? formatPct(review.summary.avgMaxDrawdown10d) : "追踪中"} tone="red" />
        <Metric icon={BadgeCheck} label="目标一命中" value={review.summary.planReplay?.target1HitRate !== undefined ? `${review.summary.planReplay.target1HitRate}%` : "追踪中"} tone="green" />
      </div>

      <StrategyHealthPanel review={review} />

      <div className="review-layout">
        <section className="list-panel review-chart-panel">
          <div className="panel-toolbar">
            <div>
              <h2>收益复盘</h2>
              <span>{review.meta.generatedAt}</span>
            </div>
          </div>
          <div className="review-chart">
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={summaryBars} margin={{ top: 18, right: 18, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="#edf1ee" vertical={false} />
                <XAxis dataKey="name" tickLine={false} axisLine={false} />
                <YAxis tickFormatter={(value) => `${Number(value).toFixed(1)}%`} tickLine={false} axisLine={false} width={44} />
                <Tooltip formatter={(value) => `${Number(value ?? 0).toFixed(2)}%`} />
                <Bar dataKey="avg" name="平均收益" fill="#159a65" radius={[5, 5, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="review-kpis">
            {reviewHorizons.map((horizon) => {
              const item = review.summary.horizons[horizon];
              return (
                <div key={horizon}>
                  <span>{horizonLabel(horizon)}</span>
                  <strong>{item.avgReturn !== undefined ? formatPct(item.avgReturn) : "追踪中"}</strong>
                  <small>{item.completed} 个完成样本</small>
                </div>
              );
            })}
          </div>
        </section>

        <section className="list-panel">
          <div className="panel-toolbar">
            <div>
              <h2>单票追踪</h2>
              <span>只统计核心强关注池</span>
            </div>
          </div>
          <ReviewTable records={review.records} />
        </section>
      </div>
    </section>
  );
}

function PlanPanel({ plan, reviewRecords }: { plan: PlanReport; reviewRecords: ReviewRecord[] }) {
  const [selected, setSelected] = useState<StockPick | undefined>(() => plan.plans[0] ?? plan.watchlist[0] ?? plan.avoided[0]);
  const [tier, setTier] = useState<DecisionTier>("ready");
  const allRows = useMemo(() => [...plan.plans, ...plan.watchlist, ...plan.avoided].sort((a, b) => a.rank - b.rank), [plan]);
  const rows = useMemo(() => allRows.filter((pick) => matchesDecisionTier(pick, tier)), [allRows, tier]);

  useEffect(() => {
    if (!selected || !rows.some((pick) => pick.instrument === selected.instrument)) setSelected(rows[0]);
  }, [rows, selected]);

  return (
    <section className="plan-panel">
      <div className="summary-grid">
        <Metric icon={CalendarClock} label="预案交易日" value={plan.meta.tradeDate} tone="blue" />
        <Metric icon={ShieldCheck} label="日K样本" value={plan.summary.dailyScored.toLocaleString("zh-CN")} />
        <Metric icon={BarChart3} label="30m精筛" value={plan.summary.intradayScored.toLocaleString("zh-CN")} tone="amber" />
        <Metric icon={Target} label="重点预案" value={plan.summary.plans} tone="green" />
        <Metric icon={AlertTriangle} label="风险跟踪" value={plan.summary.risk} tone="red" />
      </div>

      <section className="workspace">
        <div className="list-panel">
          <div className="panel-toolbar">
            <div>
              <h2>盘前交易预案</h2>
              <span>
                {plan.meta.generatedAt} · 当前 {rows.length} / 全部 {allRows.length} · 形态近 {plan.meta.setupWindowDays ?? plan.meta.lookbackDays} 天
              </span>
            </div>
          </div>
          <DecisionTierPanel picks={allRows} active={tier} onChange={setTier} />
          <PickTable picks={rows} selected={selected} onSelect={setSelected} onOpen={setSelected} />
        </div>
        {selected && <PickDetail pick={selected} reviewRecords={reviewRecords} />}
      </section>
    </section>
  );
}

function StockDetailPage({
  pick,
  detail,
  reviewRecords,
  onBack
}: {
  pick?: StockPick;
  detail?: StockDetailReport;
  reviewRecords: ReviewRecord[];
  onBack: () => void;
}) {
  const detailPick = pick ?? detail?.latestPick ?? detail?.planPick;
  const records = detail?.reviewRecords?.length ? detail.reviewRecords : reviewRecords;

  if (!detailPick && detail) {
    return (
      <section className="stock-page">
        <aside className="detail-panel">
          <DetailActions pick={{ instrument: detail.instrument } as StockPick} onBack={onBack} />
          <div className="detail-head">
            <div>
              <span className="signal signal-wait">历史详情</span>
              <h2>{detail.name}</h2>
              <p>{detail.instrument}</p>
            </div>
          </div>
          <div className="history-card">
            <div className="chart-title">
              <History size={16} />
              <span>历史信号</span>
            </div>
            <div className="signal-history">
              {records.slice(0, 8).map((record) => (
                <div key={`${record.signalDate}-${record.instrument}`} className="signal-history-row">
                  <div>
                    <strong>{record.signalDate}</strong>
                    <span>Rank {record.rank} · 评分 {record.score.toFixed(1)}</span>
                  </div>
                  <div className="history-values">
                    <span>5日 <ReviewReturn value={record.horizons["5d"].returnPct} /></span>
                    <span>浮盈 <ReviewReturn value={record.maxRunup10d} /></span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </section>
    );
  }

  if (!detailPick) {
    return (
      <section className="list-panel standalone-empty">
        <div className="panel-toolbar">
          <div>
            <h2>未找到标的</h2>
            <span>这个详情链接没有匹配到当前报告里的候选项</span>
          </div>
          <button className="icon-action" onClick={onBack}>
            <ArrowLeft size={16} />
            <span>返回</span>
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="stock-page">
      <PickDetail pick={detailPick} reviewRecords={records} onBack={onBack} />
    </section>
  );
}

function LoadingScreen({ message, error, onRetry }: { message: string; error?: string; onRetry?: () => void }) {
  return (
    <section className={error ? "loading-panel loading-error" : "loading-panel"}>
      <div className="loading-mark">
        {error ? <AlertTriangle size={26} /> : <Radar size={26} />}
      </div>
      <div>
        <h2>{error ? "数据加载失败" : "正在加载真实数据"}</h2>
        <p>{error ?? message}</p>
      </div>
      {onRetry && (
        <button className="mini-action" onClick={onRetry}>
          重新加载
        </button>
      )}
    </section>
  );
}

export default function App() {
  const [report, setReport] = useState<ScanReport | null>(null);
  const [plan, setPlan] = useState<PlanReport | null>(null);
  const [review, setReview] = useState<ReviewReport | null>(null);
  const [strategy, setStrategy] = useState<StrategyBacktestReport | undefined>();
  const [health, setHealth] = useState<SystemHealthReport | undefined>();
  const [stockIndex, setStockIndex] = useState<StockDetailIndex | undefined>();
  const [stockDetail, setStockDetail] = useState<StockDetailReport | undefined>();
  const [view, setView] = useState<"radar" | "plan" | "review" | "strategy">("radar");
  const [stockRoute, setStockRoute] = useState<string | undefined>(() => parseStockHash());
  const [query, setQuery] = useState("");
  const [signal, setSignal] = useState<Signal | "all">("all");
  const [tier, setTier] = useState<DecisionTier>("ready");
  const [selected, setSelected] = useState<StockPick | undefined>();
  const [status, setStatus] = useState<"loading" | "live" | "sample">("loading");
  const [loadError, setLoadError] = useState<string | undefined>();
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const handleHash = () => setStockRoute(parseStockHash());
    window.addEventListener("hashchange", handleHash);
    return () => window.removeEventListener("hashchange", handleHash);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setLoadError(undefined);

    Promise.all([
      loadReport(),
      loadPlan(),
      loadReview(),
      loadStrategyBacktest().catch(() => undefined),
      loadSystemHealth().catch(() => undefined),
      loadStockIndex().catch(() => undefined)
    ])
      .then(([liveReport, livePlan, liveReview, liveStrategy, liveHealth, liveStockIndex]) => {
        if (cancelled) return;
        setReport(liveReport);
        setPlan(livePlan);
        setReview(liveReview);
        setStrategy(liveStrategy);
        setHealth(liveHealth);
        setStockIndex(liveStockIndex);
        setStatus(liveReport.meta.mode === "live" ? "live" : "sample");
        setSelected(findPick(liveReport, parseStockHash()) ?? allPicks(liveReport)[0]);
      })
      .catch((error) => {
        if (cancelled) return;
        setStatus("loading");
        setLoadError((error as Error).message || "无法读取服务器报告，请稍后重试。");
      });

    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  useEffect(() => {
    let cancelled = false;
    setStockDetail(undefined);
    if (!stockRoute) return;
    loadStockDetail(stockRoute)
      .then((detail) => {
        if (!cancelled) setStockDetail(detail);
      })
      .catch(() => {
        if (!cancelled) setStockDetail(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [stockRoute]);

  const liveBadge = status === "live" ? "Live" : status === "loading" ? "Loading" : "Sample";
  const allRows = useMemo(() => (report ? allPicks(report) : []), [report]);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return allRows.filter((pick) => {
      const matchesTier = matchesDecisionTier(pick, tier);
      const matchesSignal = signal === "all" || pick.signal === signal;
      const matchesQuery =
        !needle ||
        pick.name.toLowerCase().includes(needle) ||
        pick.code.toLowerCase().includes(needle) ||
        pick.instrument.toLowerCase().includes(needle);
      return matchesTier && matchesSignal && matchesQuery;
    });
  }, [allRows, query, signal, tier]);

  useEffect(() => {
    if (!selected || !rows.some((pick) => pick.instrument === selected.instrument)) {
      setSelected(rows[0]);
    }
  }, [rows, selected]);

  if (!report || !plan || !review) {
    return (
      <main className="app-shell">
        <header className="topbar">
          <div className="brand">
            <div className="brand-mark">
              <Radar size={24} />
            </div>
            <div>
              <h1>A股资金雷达</h1>
              <span>主板非 ST · 收盘后扫描</span>
            </div>
          </div>
          <div className={`live-badge live-${loadError ? "sample" : "loading"}`}>
            <span />
            {loadError ? "Error" : liveBadge}
          </div>
        </header>
        <LoadingScreen
          message="正在读取服务器上的 latest、plan 和 performance 报告，不展示样例数据。"
          error={loadError}
          onRetry={loadError ? () => setReloadKey((key) => key + 1) : undefined}
        />
      </main>
    );
  }

  const clearRoute = () => {
    if (window.location.hash) {
      window.history.pushState(null, "", `${window.location.pathname}${window.location.search}`);
    }
    setStockRoute(undefined);
  };

  const openStock = (pick: StockPick) => {
    setSelected(pick);
    window.location.hash = stockHash(pick.instrument);
    setStockRoute(pick.instrument);
  };

  const openInstrument = (instrument: string) => {
    window.location.hash = stockHash(instrument);
    setStockRoute(instrument);
  };

  const routedPick = findPick(report, stockRoute) ?? stockDetail?.latestPick ?? stockDetail?.planPick;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <Radar size={24} />
          </div>
          <div>
            <h1>A股资金雷达</h1>
            <span>主板非 ST · 收盘后扫描</span>
          </div>
        </div>
        <div className="top-actions">
          <div className="view-switch">
            <button
              className={view === "radar" && !stockRoute ? "active" : ""}
              onClick={() => {
                clearRoute();
                setView("radar");
              }}
            >
              今日选股
            </button>
            <button
              className={view === "plan" && !stockRoute ? "active" : ""}
              onClick={() => {
                clearRoute();
                setView("plan");
              }}
            >
              交易预案
            </button>
            <button
              className={view === "review" && !stockRoute ? "active" : ""}
              onClick={() => {
                clearRoute();
                setView("review");
              }}
            >
              复盘统计
            </button>
            <button
              className={view === "strategy" && !stockRoute ? "active" : ""}
              onClick={() => {
                clearRoute();
                setView("strategy");
              }}
            >
              策略实验
            </button>
          </div>
          <div className={`live-badge live-${status}`}>
            <span />
            {liveBadge}
          </div>
        </div>
      </header>

      {stockRoute ? (
        <StockDetailPage pick={routedPick} detail={stockDetail} reviewRecords={review.records} onBack={clearRoute} />
      ) : view === "radar" ? (
        <div className="radar-view">
          <section className="summary-grid">
            <Metric icon={CalendarClock} label="交易日" value={report.meta.tradeDate} tone="blue" />
            <Metric icon={ShieldCheck} label="主板非 ST" value={report.universe.mainBoardNonSt.toLocaleString("zh-CN")} />
            <Metric icon={Filter} label="已评分" value={report.universe.scored.toLocaleString("zh-CN")} tone="amber" />
            <Metric icon={TrendingUp} label="强关注" value={report.universe.strong} tone="green" />
            <Metric icon={Radar} label="市场状态" value={report.market?.label ?? "未评估"} tone={marketTone(report.market)} />
          </section>

          <section className="workspace">
            <div className="list-panel">
              <div className="panel-toolbar">
                <div>
                  <h2>资金进场候选</h2>
                  <span>{report.meta.generatedAt.replace("T", " ").slice(0, 19)} · 当前 {rows.length} / 全部 {allRows.length}</span>
                </div>
                <div className="controls">
                  <label className="search-box">
                    <Search size={16} />
                    <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="代码 / 名称" />
                  </label>
                  <div className="segments">
                    <button className={signal === "all" ? "active" : ""} onClick={() => setSignal("all")}>
                      全部
                    </button>
                    {signalOrder.map((item) => (
                      <button key={item} className={signal === item ? "active" : ""} onClick={() => setSignal(item)}>
                        {signalText(item)}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <DecisionTierPanel picks={allRows} active={tier} onChange={setTier} />
              <StockSearchPanel query={query} index={stockIndex} currentRows={allRows} onOpen={openInstrument} />
              <PickTable picks={rows} selected={selected} onSelect={setSelected} onOpen={openStock} />
            </div>
            {selected && <PickDetail pick={selected} reviewRecords={review.records} />}
          </section>

          <div className="insight-stack">
            <SystemStatusPanel report={report} review={review} health={health} status={status} />
            <ChangeSummaryPanel report={report} />
            <MarketPanel market={report.market} />
            <ConcentrationPanel concentration={report.concentration} />
          </div>
        </div>
      ) : view === "plan" ? (
        <PlanPanel plan={plan} reviewRecords={review.records} />
      ) : view === "strategy" ? (
        <StrategyPanel report={strategy} />
      ) : (
        <ReviewPanel review={review} />
      )}
    </main>
  );
}
