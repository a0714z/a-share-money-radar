import dotenv from "dotenv";
import nodemailer from "nodemailer";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReviewReport, ScanReport, StockPick } from "../src/lib/types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const latestPath = resolve(root, "public/reports/latest.json");
const reviewPath = resolve(root, "public/reports/performance.json");
const defaultRecipient = "zxl4418@163.com";

dotenv.config({ path: resolve(root, ".env.local"), override: false, quiet: true });
dotenv.config({ path: resolve(root, ".env"), override: false, quiet: true });

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

function pickLine(pick: StockPick) {
  return [
    `${pick.rank}. ${pick.name} ${pick.instrument}`,
    `评分 ${round(pick.score, 1)}，现价 ${price(pick.price)}，涨跌 ${pct(pick.pctChange)}`,
    `主题 ${pick.sector ?? "其他"}，5日资金 ${money(pick.flow5d)} / ${pct(pick.flowRatio5d)}`,
    tradePlanText(pick),
    `理由：${compactReasons(pick.reasons)}`,
    pick.risks.length ? `风险：${compactReasons(pick.risks)}` : "风险：-"
  ].join("\n   ");
}

function reviewSummary(review?: ReviewReport) {
  if (!review) return "复盘：暂无 performance.json。";
  const fiveDay = review.summary.horizons["5d"];
  const winRate = Number.isFinite(fiveDay.winRate) ? `${fiveDay.winRate}%` : "-";
  const avgReturn = Number.isFinite(fiveDay.avgReturn) ? pct(fiveDay.avgReturn ?? 0) : "-";
  return `复盘：累计核心信号 ${review.summary.totalSignals} 只，追踪中 ${review.summary.tracking} 只，5日完成 ${fiveDay.completed} 只，5日胜率 ${winRate}，5日均值 ${avgReturn}。`;
}

function buildText(report: ScanReport, review?: ReviewReport) {
  const marketLabel = report.market ? `${report.market.label} / ${round(report.market.score, 1)}分` : "未计算";
  const lines = [
    `A股资金雷达 ${report.meta.tradeDate}`,
    "",
    `市场：${marketLabel}`,
    `节奏：${marketAction(report)}`,
    `核心强关注：${report.picks.length} 只；观察：${report.watchlist.length} 只；等待：${report.avoided.length} 只`,
    `数据模式：${report.meta.mode === "live" ? "真实数据" : "样例数据"}`,
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
  return `
    <tr>
      <td style="padding:14px 12px;border-bottom:1px solid #e5e7eb;">
        <div style="font-weight:700;color:#111827;">${pick.rank}. ${escapeHtml(pick.name)} <span style="font-weight:500;color:#6b7280;">${escapeHtml(pick.instrument)}</span></div>
        <div style="margin-top:6px;color:#374151;">${escapeHtml(pick.sector ?? "其他")} · 评分 ${round(pick.score, 1)} · 现价 ${price(pick.price)} · 涨跌 ${pct(pick.pctChange)}</div>
        <div style="margin-top:6px;color:#374151;">5日资金 ${money(pick.flow5d)} / ${pct(pick.flowRatio5d)}</div>
        <div style="margin-top:8px;color:#111827;">${escapeHtml(tradePlanText(pick))}</div>
        <div style="margin-top:8px;color:#4b5563;">理由：${escapeHtml(reasons)}</div>
        <div style="margin-top:4px;color:#6b7280;">风险：${escapeHtml(risks)}</div>
      </td>
    </tr>`;
}

function buildHtml(report: ScanReport, review?: ReviewReport) {
  const subjectDate = escapeHtml(report.meta.tradeDate);
  const marketLabel = report.market ? `${report.market.label} / ${round(report.market.score, 1)}分` : "未计算";
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
        </div>
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

function buildSubject(report: ScanReport) {
  const strong = report.picks.length;
  const market = report.market?.label ?? "未计算";
  return `A股资金雷达 ${report.meta.tradeDate}：强关注 ${strong} 只，市场${market}`;
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
  const subject = buildSubject(report);
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
