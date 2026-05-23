import dotenv from "dotenv";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { attachActionPlan } from "../src/lib/scoring";
import type { PlanReport, ScanReport, StockPick } from "../src/lib/types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

dotenv.config({ path: resolve(root, ".env.local"), override: false, quiet: true });
dotenv.config({ path: resolve(root, ".env"), override: false, quiet: true });

const reportsDir = resolve(root, process.env.REPORT_DIR ?? "public/reports");

async function readJson<T>(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function refreshPicks(picks: StockPick[]) {
  return picks.map((pick) => attachActionPlan(pick));
}

async function refreshScan(path: string) {
  if (!existsSync(path)) return false;
  const report = await readJson<ScanReport>(path);
  report.picks = refreshPicks(report.picks);
  report.watchlist = refreshPicks(report.watchlist);
  report.avoided = refreshPicks(report.avoided);
  await writeJson(path, report);
  return true;
}

async function refreshPlan(path: string) {
  if (!existsSync(path)) return false;
  const report = await readJson<PlanReport>(path);
  report.plans = refreshPicks(report.plans);
  report.watchlist = refreshPicks(report.watchlist);
  report.avoided = refreshPicks(report.avoided);
  await writeJson(path, report);
  return true;
}

async function run() {
  const latestPath = resolve(reportsDir, "latest.json");
  const planPath = resolve(reportsDir, "plan.json");
  const latest = await refreshScan(latestPath);
  const plan = await refreshPlan(planPath);
  console.log(`[action-refresh] latest=${latest ? "ok" : "missing"} plan=${plan ? "ok" : "missing"}`);
}

await run();

