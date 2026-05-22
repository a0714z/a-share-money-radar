import dotenv from "dotenv";
import nodemailer from "nodemailer";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReviewReport, ScanReport, StockPick } from "../src/lib/types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const defaultRecipient = "zxl4418@163.com";
const defaultSiteUrl = "https://a0714z.github.io/a-share-money-radar/";

dotenv.config({ path: resolve(root, ".env.local"), override: false, quiet: true });
dotenv.config({ path: resolve(root, ".env"), override: false, quiet: true });

const reportsDir = resolve(root, process.env.REPORT_DIR ?? "public/reports");
const latestPath = resolve(root, process.env.SCAN_REPORT_PATH ?? resolve(reportsDir, "latest.json"));
const reviewPath = resolve(root, process.env.REVIEW_REPORT_PATH ?? resolve(reportsDir, "performance.json"));

async function readJson<T>(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function round(value: number, digits = 2) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function boolEnv(value: string | undefined, fallback: boolean) {
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function numberEnv(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function money(value: number) {
  if (!Number.isFinite(value)) return "-";
  if (Math.abs(value) >= 100_000_000) return `${round(value / 100_000_000, 2)}亿`;
  if (Math.abs(value) >= 10_000) return `${round(value / 10_000, 1)}万`;
  return `${round(value, 0)}`;
}

function pct(value: number) {
  if (!Number.isFinite(value)) return "-";
  return `${value > 0 ? "+" : ""}${round(value, 2)}%`;
}

function price(value: number | undefined) {
  return Number.isFinite(value) ? round(Number(value), 2).toFixed(2) : "-";
}

function siteUrl() {
  return (process.env.NOTIFY_SITE_URL || defaultSiteUrl).replace(/\/?$/, "/");
}

function stockUrl(instrument: string) {
  return `${siteUrl()}#/stock/${encodeURIComponent(instrument)}`;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function marketAction(report: ScanReport) {
  if (!report.market) return "未读取到市场过滤结果，按个股信号观察。";
  if (report.market.action === "allow_core") return "市场允许核心仓位，但仍按关注区间分批。";
  if (report.market.action === "cap_core") return "市场处于震荡区，核心池已收紧，优先低吸。";
  return "市场偏弱，暂停主动进攻，只做观察和复盘。";
}

function tradePlanText(pick: StockPick) {
  if (!pick.tradePlan) return "暂无交易计划";
  return [
    `关注区 ${price(pick.tradePlan.entryLow)}-${price(pick.tradePlan.entryHigh)}`,
    `追高线 ${price(pick.tradePlan.chaseAbove)}`,
    `失效位 ${price(pick.tradePlan.invalidBelow)}`,
    `止损 ${price(pick.tradePlan.stopLoss)}`,
    `目标 ${price(pick.tradePlan.target1)}/${price(pick.tradePlan.target2)}`,
    `仓位 ${pick.tradePlan.positionLabel}${pick.tradePlan.positionPct}%`
  ].join("；");
}

function compactReasons(values: string[], limit = 2) {
  return values.slice(0, limit).join("；") || "-";
}

function compactNames(items: Array<{ name: string; instrument: string }>, limit = 4) {
  if (!items.length) return "-";
  const names = items.slice(0, limit).map((item) => `${item.name} ${item.instrument}`);
  const extra = items.length > limit ? ` 等${items.length}只` : "";
  return `${names.join("、")}${extra}`;
}

function changeStats(report: ScanReport) {
  const changes = report.changes;
  return {
    newStrong: (changes?.newStrong.length ?? 0) + (changes?.upgradedToStrong.length ?? 0),
    consecutive: changes?.consecutiveStrong.length ?? 0,
    leftCore: (changes?.downgradedFromStrong.length ?? 0) + (changes?.exitedStrong.length ?? 0),
    delta: changes?.strongCountChange ?? report.picks.length
  };
}

function healthLine(review?: ReviewReport) {
  const health = review?.summary.health;
  if (!health) return "策略健康度：暂无健康度数据。";
  const action = health.action === "normal" ? "正常执行" : health.action === "light" ? "轻仓观察" : "暂停加仓";
  return `策略健康度：${health.label} ${health.score.toFixed(1)}，建议 ${action}。${health.headline}`;
}

function changeSummaryText(report: ScanReport) {
  const changes = report.changes;
  if (!changes) return ["今日变化：暂无上一交易日对比。"];
  const newOrUpgraded = [...changes.newStrong, ...changes.upgradedToStrong];
  const leftCore = [...changes.downgradedFromStrong, ...changes.exitedStrong];
  const setupPositive = [...(changes.newSetups ?? []), ...(changes.strengthenedSetups ?? []), ...(changes.breakoutSetups ?? [])];
  const setupNegative = [...(changes.weakenedSetups ?? []), ...(changes.invalidatedSetups ?? [])];
  return [
    `今日变化：${changes.headline}`,
    `新晋/升级：${compactNames(newOrUpgraded)}`,
    `连续入选：${compactNames(changes.consecutiveStrong)}`,
    `降级/退出：${compactNames(leftCore)}`,
    `阶段转强：${compactNames(setupPositive)}`,
    `转弱/失效：${compactNames(setupNegative)}`
  ];
}

function pickLine(pick: StockPick) {
  const setupAge = pick.setupAgeDays ? `，追踪 ${pick.setupAgeDays} 天` : "";
  return [
    `${pick.rank}. ${pick.name} ${pick.instrument}`,
    `阶段 ${pick.setupState ?? "常规观察"}${setupAge}，评分 ${round(pick.score, 1)}，现价 ${price(pick.price)}，涨跌 ${pct(pick.pctChange)}`,
    `主题 ${pick.sector ?? "其他"}，5日资金 ${money(pick.flow5d)} / ${pct(pick.flowRatio5d)}`,
    tradePlanText(pick),
    `详情：${stockUrl(pick.instrument)}`,
    `理由：${compactReasons(pick.reasons)}`,
    pick.risks.length ? `风险：${compactReasons(pick.risks)}` : "风险：-"
  ].join("\n   ");
}

function reviewSummary(review?: ReviewReport) {
  if (!review) return "复盘：暂无 performance.json。";
  const fiveDay = review.summary.horizons["5d"];
  const winRate = Number.isFinite(fiveDay.winRate) ? `${fiveDay.winRate}%` : "-";
  const avgReturn = Number.isFinite(fiveDay.avgReturn) ? pct(fiveDay.avgReturn ?? 0) : "-";
  const health = review.summary.health ? `；健康度 ${review.summary.health.label} ${review.summary.health.score.toFixed(1)}` : "";
  return `复盘：累计核心信号 ${review.summary.totalSignals} 只，追踪中 ${review.summary.tracking} 只，5日完成 ${fiveDay.completed} 只，5日胜率 ${winRate}，5日均值 ${avgReturn}${health}。`;
}

function dataQualityText(report: ScanReport) {
  const quality = report.dataQuality;
  if (!quality) return `数据模式：${report.meta.mode === "live" ? "真实数据" : "样例数据"}`;
  const notes = quality.notes.length ? `；${quality.notes.join("；")}` : "";
  return `数据质量：${quality.label}，有效报价 ${quality.validQuoteRatio}%，缺成交额 ${quality.missingAmountRatio}%，缺量比 ${quality.missingVolumeRatio}%${notes}`;
}

function buildText(report: ScanReport, review?: ReviewReport) {
  const marketLabel = report.market ? `${report.market.label} / ${round(report.market.score, 1)}分` : "未计算";
  const lines = [
    `A股资金雷达 ${report.meta.tradeDate}`,
    "",
    `市场：${marketLabel}`,
    `节奏：${marketAction(report)}`,
    `核心强关注：${report.picks.length} 只；观察：${report.watchlist.length} 只；等待：${report.avoided.length} 只`,
    dataQualityText(report),
    "",
    ...changeSummaryText(report),
    "",
    healthLine(review),
    "",
    "核心强关注：",
    report.picks.length ? report.picks.map(pickLine).join("\n\n") : "今日没有符合强关注条件的主板非 ST 标的。",
    "",
    reviewSummary(review),
    "",
    "提示：这是量化研究提醒，不构成投资建议；实际交易请结合仓位、止损和盘中变化。"
  ];
  return lines.join("\n");
}

function pickCard(pick: StockPick) {
  const reasons = compactReasons(pick.reasons);
  const risks = pick.risks.length ? compactReasons(pick.risks) : "-";
  const setupAge = pick.setupAgeDays ? `，追踪 ${pick.setupAgeDays} 天` : "";
  return `
    <tr>
      <td style="padding:14px 12px;border-bottom:1px solid #e5e7eb;">
        <div style="font-weight:700;color:#111827;">${pick.rank}. ${escapeHtml(pick.name)} <span style="font-weight:500;color:#6b7280;">${escapeHtml(pick.instrument)}</span></div>
        <div style="margin-top:6px;color:#374151;">${escapeHtml(pick.sector ?? "其他")} · 阶段 ${escapeHtml(`${pick.setupState ?? "常规观察"}${setupAge}`)} · 评分 ${round(pick.score, 1)} · 现价 ${price(pick.price)} · 涨跌 ${pct(pick.pctChange)}</div>
        <div style="margin-top:6px;color:#374151;">5日资金 ${money(pick.flow5d)} / ${pct(pick.flowRatio5d)}</div>
        <div style="margin-top:8px;color:#111827;">${escapeHtml(tradePlanText(pick))}</div>
        <div style="margin-top:8px;"><a href="${escapeHtml(stockUrl(pick.instrument))}" style="color:#0f766e;font-weight:800;text-decoration:none;">打开详情</a></div>
        <div style="margin-top:8px;color:#4b5563;">理由：${escapeHtml(reasons)}</div>
        <div style="margin-top:4px;color:#6b7280;">风险：${escapeHtml(risks)}</div>
      </td>
    </tr>`;
}

function htmlList(
  title: string,
  items: Array<{ name: string; instrument: string; sector?: string; score?: number; currentSetupState?: string; setupAgeDays?: number }>
) {
  const body = items.length
    ? items
        .slice(0, 5)
        .map((item) => {
          const secondary = item.currentSetupState
            ? `${item.currentSetupState}${item.setupAgeDays ? ` · ${item.setupAgeDays}天` : ""}`
            : item.sector ?? "未分组";
          return `
            <div style="padding:10px 12px;border:1px solid #e5e7eb;border-radius:8px;background:#ffffff;">
              <div style="font-weight:800;color:#111827;">${escapeHtml(item.name)} <span style="font-weight:500;color:#6b7280;">${escapeHtml(item.instrument)}</span></div>
              <div style="margin-top:4px;color:#4b5563;font-size:13px;">${escapeHtml(secondary)} ${Number.isFinite(item.score) ? `· ${round(item.score ?? 0, 1)}` : ""}</div>
            </div>`;
        })
        .join("")
    : `<div style="padding:12px;color:#6b7280;border:1px solid #e5e7eb;border-radius:8px;background:#ffffff;">暂无</div>`;
  return `
    <div style="min-width:0;">
      <div style="font-weight:800;margin-bottom:8px;">${escapeHtml(title)}</div>
      <div style="display:grid;gap:8px;">${body}</div>
    </div>`;
}

function changeSummaryHtml(report: ScanReport) {
  const changes = report.changes;
  if (!changes) return "";
  const newOrUpgraded = [...changes.newStrong, ...changes.upgradedToStrong];
  const leftCore = [...changes.downgradedFromStrong, ...changes.exitedStrong];
  const weakOrInvalidSetups = [...(changes.weakenedSetups ?? []), ...(changes.invalidatedSetups ?? [])];
  return `
    <div style="padding:16px 22px;border-bottom:1px solid #e5e7eb;background:#f9fafb;">
      <div style="font-weight:800;margin-bottom:8px;">今日变化</div>
      <div style="color:#111827;line-height:1.7;font-weight:700;">${escapeHtml(changes.headline)}</div>
      <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-top:12px;">
        ${htmlList("新异动", changes.newSetups ?? [])}
        ${htmlList("承接转强", changes.strengthenedSetups ?? [])}
        ${htmlList("二次突破", changes.breakoutSetups ?? [])}
        ${htmlList("转弱/失效", weakOrInvalidSetups)}
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:12px;">
        ${htmlList("新晋/升级", newOrUpgraded)}
        ${htmlList("连续入选", changes.consecutiveStrong)}
        ${htmlList("降级/退出", leftCore)}
      </div>
    </div>`;
}

function healthHtml(review?: ReviewReport) {
  const health = review?.summary.health;
  if (!health) return "";
  const color = health.status === "good" ? "#075535" : health.status === "watch" ? "#735012" : "#8b2d2c";
  const bg = health.status === "good" ? "#dff6e9" : health.status === "watch" ? "#fff2c7" : "#f8dedc";
  const action = health.action === "normal" ? "正常执行" : health.action === "light" ? "轻仓观察" : "暂停加仓";
  return `
    <div style="padding:16px 22px;border-bottom:1px solid #e5e7eb;">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:14px;">
        <div>
          <div style="font-weight:800;margin-bottom:6px;">策略健康度</div>
          <div style="color:#374151;line-height:1.7;">${escapeHtml(health.headline)}</div>
        </div>
        <div style="min-width:108px;text-align:center;padding:12px;border-radius:8px;background:${bg};color:${color};">
          <div style="font-size:28px;font-weight:900;line-height:1;">${health.score.toFixed(1)}</div>
          <div style="margin-top:6px;font-weight:800;">${escapeHtml(health.label)} · ${escapeHtml(action)}</div>
        </div>
      </div>
    </div>`;
}

function buildHtml(report: ScanReport, review?: ReviewReport) {
  const subjectDate = escapeHtml(report.meta.tradeDate);
  const marketLabel = report.market ? `${report.market.label} / ${round(report.market.score, 1)}分` : "未计算";
  const quality = report.dataQuality;
  const cards = report.picks.length
    ? report.picks.map(pickCard).join("")
    : `<tr><td style="padding:14px 12px;border-bottom:1px solid #e5e7eb;color:#374151;">今日没有符合强关注条件的主板非 ST 标的。</td></tr>`;

  return `<!doctype html>
<html lang="zh-CN">
  <body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111827;">
    <div style="max-width:760px;margin:0 auto;padding:24px 16px;">
      <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
        <div style="padding:20px 22px;border-bottom:1px solid #e5e7eb;background:#111827;color:#ffffff;">
          <div style="font-size:20px;font-weight:800;">A股资金雷达 ${subjectDate}</div>
          <div style="margin-top:8px;font-size:14px;color:#d1d5db;">市场：${escapeHtml(marketLabel)} · 核心 ${report.picks.length} 只 · 观察 ${report.watchlist.length} 只</div>
        </div>
        <div style="padding:16px 22px;border-bottom:1px solid #e5e7eb;">
          <div style="font-weight:700;margin-bottom:6px;">今日节奏</div>
          <div style="color:#374151;line-height:1.7;">${escapeHtml(marketAction(report))}</div>
          ${
            quality
              ? `<div style="margin-top:8px;color:#4b5563;line-height:1.7;">数据质量：${escapeHtml(quality.label)} · 有效报价 ${quality.validQuoteRatio}% · 缺成交额 ${quality.missingAmountRatio}% · 缺量比 ${quality.missingVolumeRatio}%</div>`
              : ""
          }
        </div>
        ${changeSummaryHtml(report)}
        ${healthHtml(review)}
        <table role="presentation" style="width:100%;border-collapse:collapse;">
          ${cards}
        </table>
        <div style="padding:16px 22px;color:#374151;line-height:1.7;">
          ${escapeHtml(reviewSummary(review))}
        </div>
        <div style="padding:14px 22px;border-top:1px solid #e5e7eb;color:#6b7280;font-size:12px;line-height:1.6;">
          这是量化研究提醒，不构成投资建议；实际交易请结合仓位、止损和盘中变化。
        </div>
      </div>
    </div>
  </body>
</html>`;
}

function buildSubject(report: ScanReport, review?: ReviewReport) {
  const strong = report.picks.length;
  const market = report.market?.label ?? "未计算";
  const stats = changeStats(report);
  const health = review?.summary.health ? ` 健康${review.summary.health.label}` : "";
  return `A股资金雷达 ${report.meta.tradeDate}：强关注${strong} 新晋${stats.newStrong} 连续${stats.consecutive} 退出${stats.leftCore} 市场${market}${health}`;
}

async function loadReports() {
  if (!existsSync(latestPath)) throw new Error(`Missing report: ${latestPath}`);
  const report = await readJson<ScanReport>(latestPath);
  const review = existsSync(reviewPath) ? await readJson<ReviewReport>(reviewPath) : undefined;
  return { report, review };
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has("--dry-run");
  const { report, review } = await loadReports();
  const to = process.env.NOTIFY_EMAIL_TO || defaultRecipient;
  const subject = buildSubject(report, review);
  const text = buildText(report, review);
  const html = buildHtml(report, review);

  if (dryRun) {
    console.log(`[notify] dry run`);
    console.log(`To: ${to}`);
    console.log(`Subject: ${subject}`);
    console.log("");
    console.log(text);
    return;
  }

  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const missing = [
    ["NOTIFY_EMAIL_TO", to],
    ["SMTP_HOST", host],
    ["SMTP_USER", user],
    ["SMTP_PASS", pass]
  ].filter(([, value]) => !value);

  if (missing.length) {
    console.warn(`[notify] skipped email because secrets are missing: ${missing.map(([name]) => name).join(", ")}`);
    return;
  }

  const port = numberEnv(process.env.SMTP_PORT, 465);
  const secure = boolEnv(process.env.SMTP_SECURE, port === 465);
  const from = process.env.SMTP_FROM || user;
  const transport = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass }
  });

  const info = await transport.sendMail({ from, to, subject, text, html });
  console.log(`[notify] email sent to ${to}: ${info.messageId}`);
}

await main();
