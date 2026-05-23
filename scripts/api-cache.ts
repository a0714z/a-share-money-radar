import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CompanyProfile, MoneyFlow } from "../src/lib/types";
import type { BiyingClient } from "./biying-client";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

type CacheEnvelope<T> = {
  fetchedAt: string;
  data: T;
};

function cacheRoot() {
  return resolve(root, process.env.API_CACHE_DIR ?? ".cache/biying");
}

function safeCode(code: string) {
  return code.replace(/[^0-9A-Z.]/gi, "_");
}

function cachePath(kind: "money-flow" | "profile", code: string) {
  return resolve(cacheRoot(), kind, `${safeCode(code)}.json`);
}

function allowRefresh() {
  return ["1", "true", "yes"].includes(String(process.env.API_CACHE_REFRESH ?? "").toLowerCase());
}

async function readEnvelope<T>(path: string) {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(await readFile(path, "utf8")) as CacheEnvelope<T>;
  } catch (error) {
    console.warn(`[api-cache] read ${path} skipped: ${(error as Error).message}`);
    return undefined;
  }
}

async function writeEnvelope<T>(path: string, data: T) {
  await mkdir(dirname(path), { recursive: true });
  const envelope: CacheEnvelope<T> = {
    fetchedAt: new Date().toISOString(),
    data
  };
  await writeFile(path, `${JSON.stringify(envelope)}\n`, "utf8");
}

export async function cachedMoneyFlow(client: BiyingClient, code: string, limit: number) {
  const path = cachePath("money-flow", code);
  const cached = await readEnvelope<MoneyFlow[]>(path);

  if (!allowRefresh()) {
    return cached?.data?.slice(-limit) ?? [];
  }

  try {
    const flows = await client.moneyFlow(code, limit);
    await writeEnvelope(path, flows);
    return flows;
  } catch (error) {
    if (cached?.data?.length) {
      console.warn(`[api-cache] using cached money flow ${code}: ${(error as Error).message}`);
      return cached.data.slice(-limit);
    }
    throw error;
  }
}

export async function cachedCompanyProfile(client: BiyingClient, code: string) {
  const path = cachePath("profile", code);
  const cached = await readEnvelope<CompanyProfile>(path);

  if (!allowRefresh()) {
    return cached?.data;
  }

  try {
    const profile = await client.companyProfile(code);
    await writeEnvelope(path, profile);
    return profile;
  } catch (error) {
    if (cached?.data) {
      console.warn(`[api-cache] using cached profile ${code}: ${(error as Error).message}`);
      return cached.data;
    }
    throw error;
  }
}

