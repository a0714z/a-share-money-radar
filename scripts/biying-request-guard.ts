type GuardOptions = {
  label: string;
  run: () => Promise<Response>;
};

type RequestStats = {
  startedAt: string;
  requests: number;
  maxRequests: number;
  minIntervalMs: number;
};

let chain: Promise<void> = Promise.resolve();
let lastRequestAt = 0;
const stats: RequestStats = {
  startedAt: new Date().toISOString(),
  requests: 0,
  maxRequests: intEnv("BIYING_MAX_REQUESTS", 5500),
  minIntervalMs: intEnv("BIYING_REQUEST_INTERVAL_MS", 250)
};

function intEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitTurn() {
  const previous = chain;
  let release!: () => void;
  chain = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  return release;
}

export function biyingRequestStats() {
  return { ...stats };
}

export async function guardedBiyingFetch({ label, run }: GuardOptions) {
  const release = await waitTurn();
  try {
    if (stats.requests >= stats.maxRequests) {
      throw new Error(`Biying request budget exhausted: ${stats.requests}/${stats.maxRequests}`);
    }

    const elapsed = Date.now() - lastRequestAt;
    if (lastRequestAt && elapsed < stats.minIntervalMs) {
      await sleep(stats.minIntervalMs - elapsed);
    }

    stats.requests += 1;
    lastRequestAt = Date.now();
    if (stats.requests === 1 || stats.requests % 100 === 0) {
      console.log(`[biying-api] serial request ${stats.requests}/${stats.maxRequests}: ${label}`);
    }
    return await run();
  } finally {
    release();
  }
}
