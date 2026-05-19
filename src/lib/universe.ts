import type { Exchange, StockListItem } from "./types";

const MAIN_BOARD_PREFIXES = ["000", "001", "002", "003", "600", "601", "603", "605"];
const BLOCKED_NAME_PARTS = ["ST", "*ST", "退"];

export function plainCode(code: string) {
  return code.split(".")[0] ?? code;
}

export function isMainBoardCode(code: string) {
  const normalized = plainCode(code);
  return MAIN_BOARD_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function isNonStName(name: string) {
  const normalized = name.toUpperCase();
  return !BLOCKED_NAME_PARTS.some((part) => normalized.includes(part));
}

export function isMainBoardNonSt(stock: StockListItem) {
  return isMainBoardCode(stock.dm) && isNonStName(stock.mc);
}

export function inferExchange(code: string, jys?: string): Exchange {
  const normalizedJys = jys?.toLowerCase();
  if (normalizedJys === "sh" || normalizedJys === "sz") return normalizedJys;
  const suffix = code.split(".")[1]?.toLowerCase();
  if (suffix === "sh" || suffix === "sz") return suffix;
  return plainCode(code).startsWith("6") ? "sh" : "sz";
}

export function toInstrumentCode(code: string, exchange: Exchange) {
  return `${plainCode(code)}.${exchange.toUpperCase()}`;
}
