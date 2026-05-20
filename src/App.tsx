import { useEffect, useMemo, useState } from "react";
import {
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
import type { ReviewHorizon, ReviewRecord, ReviewReport, ScanReport, Signal, StockPick } from "./lib/types";

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

function allPicks(report: ScanReport) {
  return [...report.picks, ...report.watchlist, ...report.avoided].sort((a, b) => a.rank - b.rank);
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
  tone?: "neutral" | "green" | "amber" | "blue";
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

function PickDetail({ pick }: { pick: StockPick }) {
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
            <th>3日低吸</th>
            <th>10日回撤</th>
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
                <ReviewReturn value={record.bestEntryDrawdown3d} />
              </td>
              <td>
                <ReviewReturn value={record.maxDrawdown10d} />
              </td>
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
          </section>

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
            {selected && <PickDetail pick={selected} />}
          </section>
        </>
      ) : (
        <ReviewPanel review={review} />
      )}
    </main>
  );
}
