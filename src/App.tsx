import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BadgeCheck,
  BarChart3,
  CalendarClock,
  CircleDollarSign,
  Filter,
  History,
  ListChecks,
  Percent,
  Radar,
  Search,
  ShieldCheck,
  Target,
  TrendingUp
} from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import { sampleReport } from "./data/sample-report";
import { sampleReview } from "./data/sample-review";
import type { MarketRegime, ReviewHorizon, ReviewRecord, ReviewReport, ScanReport, SectorConcentrationReport, Signal, StockPick } from "./lib/types";

const signalOrder: Signal[] = ["strong", "watch", "wait"];
const reviewHorizons: ReviewHorizon[] = ["1d", "3d", "5d", "10d"];

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

function triggerText(trigger?: NonNullable<ReviewRecord["planReplay"]>["firstTrigger"]) {
  if (trigger === "entry") return "触达关注区";
  if (trigger === "stopLoss") return "触发止损";
  if (trigger === "target1") return "触达目标一";
  if (trigger === "target2") return "触达目标二";
  return "未触发";
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

function PickTable({
  picks,
  selected,
  onSelect
}: {
  picks: StockPick[];
  selected?: StockPick;
  onSelect: (pick: StockPick) => void;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Rank</th>
            <th>代码</th>
            <th>名称</th>
            <th>主题</th>
            <th>信号</th>
            <th>分数</th>
            <th>涨跌</th>
            <th>5日资金</th>
            <th>分位</th>
            <th>成交额</th>
          </tr>
        </thead>
        <tbody>
          {picks.map((pick) => (
            <tr
              key={pick.instrument}
              className={selected?.instrument === pick.instrument ? "is-selected" : ""}
              onClick={() => onSelect(pick)}
            >
              <td>{pick.rank}</td>
              <td className="code">{pick.instrument}</td>
              <td>{pick.name}</td>
              <td>{pick.sector ?? "-"}</td>
              <td>
                <span className={`signal signal-${pick.signal}`}>{pick.rating}</span>
              </td>
              <td>
                <strong>{pick.score.toFixed(1)}</strong>
              </td>
              <td className={pick.pctChange >= 0 ? "up" : "down"}>{formatPct(pick.pctChange)}</td>
              <td className={pick.flow5d >= 0 ? "up" : "down"}>{formatMoney(pick.flow5d)}</td>
              <td>{pick.valuePosition.toFixed(1)}%</td>
              <td>{formatMoney(pick.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!picks.length && <div className="empty">当前过滤条件下没有标的</div>}
    </div>
  );
}

function PickDetail({ pick, reviewRecords }: { pick: StockPick; reviewRecords: ReviewRecord[] }) {
  const plan = pick.tradePlan;
  const historySignals = reviewRecords
    .filter((record) => record.instrument === pick.instrument)
    .sort((a, b) => b.signalDate.localeCompare(a.signalDate))
    .slice(0, 4);

  return (
    <aside className="detail-panel">
      <div className="detail-head">
        <div>
          <span className={`signal signal-${pick.signal}`}>{pick.rating}</span>
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

      <div className="chart-block">
        <div className="chart-title">
          <BarChart3 size={16} />
          <span>价格与成本线</span>
        </div>
        <ResponsiveContainer width="100%" height={210}>
          <AreaChart data={pick.history} margin={{ top: 10, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="priceFill" x1="0" x2="0" y1="0" y2="1">
                <stop offset="5%" stopColor="#159a65" stopOpacity={0.24} />
                <stop offset="95%" stopColor="#159a65" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="#e7ece9" vertical={false} />
            <XAxis dataKey="date" minTickGap={24} tickLine={false} axisLine={false} />
            <YAxis domain={["dataMin", "dataMax"]} tickLine={false} axisLine={false} width={36} />
            <Tooltip formatter={(value) => Number(value ?? 0).toFixed(2)} />
            <Area type="monotone" dataKey="close" stroke="#159a65" fill="url(#priceFill)" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="ma20" stroke="#2563eb" strokeWidth={1.6} dot={false} />
            <Line type="monotone" dataKey="ma60" stroke="#9a6a15" strokeWidth={1.4} dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div className="chart-block">
        <div className="chart-title">
          <CircleDollarSign size={16} />
          <span>大单净额</span>
        </div>
        <ResponsiveContainer width="100%" height={150}>
          <BarChart data={pick.flowBars} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="#edf1ee" vertical={false} />
            <XAxis dataKey="date" minTickGap={18} tickLine={false} axisLine={false} />
            <YAxis tickFormatter={(value) => formatMoney(Number(value))} tickLine={false} axisLine={false} width={42} />
            <Tooltip formatter={(value) => formatMoney(Number(value ?? 0))} />
            <Bar dataKey="net" radius={[4, 4, 0, 0]} fill="#159a65" />
          </BarChart>
        </ResponsiveContainer>
      </div>

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
  status
}: {
  report: ScanReport;
  review: ReviewReport;
  status: "loading" | "live" | "sample";
}) {
  const reportFresh = report.meta.tradeDate === review.records[0]?.signalDate || review.meta.historyReports > 0;
  const dataTone = status === "live" ? "tag-ok" : status === "loading" ? "tag-warn" : "tag-warn";

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

function ReviewTable({ records }: { records: ReviewRecord[] }) {
  return (
    <div className="table-wrap review-table">
      <table>
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
              <td>{record.signalDate}</td>
              <td className="code">{record.instrument}</td>
              <td>{record.name}</td>
              <td>{record.signalPrice.toFixed(2)}</td>
              {reviewHorizons.map((horizon) => (
                <td key={horizon}>
                  <ReviewReturn value={record.horizons[horizon].returnPct} />
                </td>
              ))}
              <td>
                <ReviewReturn value={record.maxRunup10d} />
              </td>
              <td>
                <ReviewReturn value={record.bestEntryDrawdown3d} />
              </td>
              <td>
                <ReviewReturn value={record.maxDrawdown10d} />
              </td>
              <td>{triggerText(record.planReplay?.firstTrigger)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!records.length && <div className="empty">还没有可复盘的核心信号</div>}
    </div>
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

export default function App() {
  const [report, setReport] = useState<ScanReport>(sampleReport);
  const [review, setReview] = useState<ReviewReport>(sampleReview);
  const [view, setView] = useState<"radar" | "review">("radar");
  const [query, setQuery] = useState("");
  const [signal, setSignal] = useState<Signal | "all">("all");
  const [selected, setSelected] = useState<StockPick | undefined>(sampleReport.picks[0]);
  const [status, setStatus] = useState<"loading" | "live" | "sample">("loading");

  useEffect(() => {
    loadReport()
      .then((liveReport) => {
        setReport(liveReport);
        setStatus(liveReport.meta.mode === "live" ? "live" : "sample");
        setSelected(allPicks(liveReport)[0]);
      })
      .catch(() => {
        setStatus("sample");
        setReport(sampleReport);
        setSelected(sampleReport.picks[0]);
      });
  }, []);

  useEffect(() => {
    loadReview()
      .then(setReview)
      .catch(() => setReview(sampleReview));
  }, []);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return allPicks(report).filter((pick) => {
      const matchesSignal = signal === "all" || pick.signal === signal;
      const matchesQuery =
        !needle ||
        pick.name.toLowerCase().includes(needle) ||
        pick.code.toLowerCase().includes(needle) ||
        pick.instrument.toLowerCase().includes(needle);
      return matchesSignal && matchesQuery;
    });
  }, [query, report, signal]);

  useEffect(() => {
    if (!selected || !rows.some((pick) => pick.instrument === selected.instrument)) {
      setSelected(rows[0]);
    }
  }, [rows, selected]);

  const liveBadge = status === "live" ? "Live" : status === "loading" ? "Loading" : "Sample";

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
            <button className={view === "radar" ? "active" : ""} onClick={() => setView("radar")}>
              今日选股
            </button>
            <button className={view === "review" ? "active" : ""} onClick={() => setView("review")}>
              复盘统计
            </button>
          </div>
          <div className={`live-badge live-${status}`}>
            <span />
            {liveBadge}
          </div>
        </div>
      </header>

      {view === "radar" ? (
        <>
          <section className="summary-grid">
            <Metric icon={CalendarClock} label="交易日" value={report.meta.tradeDate} tone="blue" />
            <Metric icon={ShieldCheck} label="主板非 ST" value={report.universe.mainBoardNonSt.toLocaleString("zh-CN")} />
            <Metric icon={Filter} label="已评分" value={report.universe.scored.toLocaleString("zh-CN")} tone="amber" />
            <Metric icon={TrendingUp} label="强关注" value={report.universe.strong} tone="green" />
            <Metric icon={Radar} label="市场状态" value={report.market?.label ?? "未评估"} tone={marketTone(report.market)} />
          </section>

          <SystemStatusPanel report={report} review={review} status={status} />
          <MarketPanel market={report.market} />
          <ConcentrationPanel concentration={report.concentration} />

          <section className="workspace">
            <div className="list-panel">
              <div className="panel-toolbar">
                <div>
                  <h2>资金进场候选</h2>
                  <span>{report.meta.generatedAt.replace("T", " ").slice(0, 19)}</span>
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
              <PickTable picks={rows} selected={selected} onSelect={setSelected} />
            </div>
            {selected && <PickDetail pick={selected} reviewRecords={review.records} />}
          </section>
        </>
      ) : (
        <ReviewPanel review={review} />
      )}
    </main>
  );
}
