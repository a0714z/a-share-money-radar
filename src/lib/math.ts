export function clamp(value: number, min = 0, max = 100) {
  if (Number.isNaN(value)) return min;
  return Math.max(min, Math.min(max, value));
}

export function sum(values: Array<number | undefined>) {
  let total = 0;
  for (const value of values) {
    total += Number.isFinite(value) ? Number(value) : 0;
  }
  return total;
}

export function average(values: Array<number | undefined>) {
  const clean = values.filter((value): value is number => Number.isFinite(value));
  if (!clean.length) return 0;
  return sum(clean) / clean.length;
}

export function movingAverage(values: number[], window: number) {
  return values.map((_, index) => {
    const start = Math.max(0, index - window + 1);
    const slice = values.slice(start, index + 1);
    if (slice.length < window) return undefined;
    return sum(slice) / window;
  });
}

export function pctChange(current: number, base: number) {
  if (!Number.isFinite(current) || !Number.isFinite(base) || base === 0) return 0;
  return ((current - base) / base) * 100;
}

export function round(value: number, digits = 2) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function last<T>(items: T[], fallback?: T) {
  return items.length ? items[items.length - 1] : fallback;
}
