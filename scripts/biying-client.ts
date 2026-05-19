import type { KLine, MoneyFlow, RealQuote, StockListItem } from "../src/lib/types";

const API_BASE = "https://api.biyingapi.com";
const ALL_BASE = "https://all.biyingapi.com";

type FetchOptions = {
  base?: string;
  query?: Record<string, string | number | undefined>;
};

function toUrl(path: string, options: FetchOptions = {}) {
  const base = options.base ?? API_BASE;
  const url = new URL(path, base);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  return url;
}

async function fetchJson<T>(path: string, options: FetchOptions = {}): Promise<T> {
  const url = toUrl(path, options);
  const response = await fetch(url, {
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Biying API ${response.status}: ${url.pathname}`);
  }

  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Biying API returned non-JSON for ${url.pathname}: ${text.slice(0, 80)}`);
  }
}

function assertArray<T>(value: unknown, label: string): T[] {
  if (!Array.isArray(value)) throw new Error(`${label} response is not an array`);
  return value as T[];
}

export class BiyingClient {
  constructor(private readonly license: string) {}

  async stockList() {
    return assertArray<StockListItem>(await fetchJson(`/hslt/list/${this.license}`), "stockList");
  }

  async allRealtime() {
    try {
      return assertArray<RealQuote>(await fetchJson(`/hsrl/ssjy/all/${this.license}`, { base: ALL_BASE }), "allRealtime");
    } catch (error) {
      console.warn(`[scan] broker all-realtime failed, fallback to network source: ${(error as Error).message}`);
      return assertArray<RealQuote>(await fetchJson(`/hsrl/real/all/${this.license}`, { base: ALL_BASE }), "allRealtimeFallback");
    }
  }

  async history(instrument: string, limit: number) {
    return assertArray<KLine>(
      await fetchJson(`/hsstock/history/${instrument}/d/f/${this.license}`, {
        query: { lt: limit }
      }),
      `history:${instrument}`
    );
  }

  async moneyFlow(code: string, limit: number) {
    return assertArray<MoneyFlow>(
      await fetchJson(`/hsstock/history/transaction/${code}/${this.license}`, {
        query: { lt: limit }
      }),
      `moneyFlow:${code}`
    );
  }
}
