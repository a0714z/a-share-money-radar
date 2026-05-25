# Development Changelog

This file is the shared multi-agent update log. Every development milestone should add a dated entry with scope, changed files, validation, deployment status, and follow-up notes.

## 2026-05-25

### Strong Watch Strategy Layer

- Added `strongWatch` as a second-stage filter over `aestheticWatch`.
- Default strong watch limit is `--strong-watch-top=5`.
- Current strong watch favors `30m承接审美`, `低位修复观察`, and only very high-scoring `接近主策略`.
- `2026-05-22` latest signal now has:
  - main strategy: `1`
  - strong watch: `3`
  - aesthetic watch: `20`
- Current strong watch picks:
  - `600857.SH 宁波中百`
  - `600635.SH 大众公用`
  - `002346.SZ 柘中股份`
- Benchmark window `2026-01-19` to `2026-05-22`:
  - main strategy 10d +5% hit rate: `77.8%`
  - strong watch 10d +5% hit rate: `60.2%`
  - aesthetic watch 10d +5% hit rate: `56.2%`

Changed files:

- `scripts/run-strategy-backtest.ts`
- `scripts/run-strategy-latest.ts`
- `scripts/run-system-health.ts`
- `src/App.tsx`
- `README.md`
- `docs/HANDOFF.md`
- `docs/CHANGELOG.md`

Validation:

- `STRATEGY_BACKTEST_FORCE=1 npm run strategy:latest`
- `npm run health`
- `npm run build`

Deployment:

- Deployed to `http://112.126.57.131/`.
- Production report was seeded with the locally verified `2026-05-22` strong watch report because the server cannot currently recompute `2026-05-25` strategy signals from its K-line cache.
- Production `system-health.json` is expected to be `warn` until strategy K-line cache catches up to `2026-05-25`; it keeps the valid `2026-05-22` strategy report instead of failing or publishing an empty strategy report.

### Strategy Archive And Attribution

- Added strategy report archive files under `reports/backtests/history/YYYY-MM-DD.json`.
- Added `reports/backtests/history/index.json`.
- Added frontend strategy archive table.
- Added frontend factor attribution table for `30m回踩分`, `30m缩量比`, `5日资金`, `120日分位`, `高点回撤`, and aesthetic bucket.
- Production was verified after deploy in the previous milestone.

### Latest Strategy Benchmark

- `strategy:latest` now attaches a historical `benchmark` report to the latest one-day signal report.
- Frontend uses the outer report for today and `benchmark` for historical statistics.
- `system-health.json` reads strategy win-rate fields from `benchmark` when available.
- Empty server-side benchmark runs are protected so they do not overwrite a valid existing benchmark.

### Aesthetic Watch Dashboard

- Added the frontend “策略实验” tab.
- Added `aestheticWatch` report output with independent buckets:
  - `接近主策略`
  - `30m承接审美`
  - `低位修复观察`
- Current `2026-05-22` latest signal keeps `001223.SZ 欧克科技` as the main strategy pick and includes `600635.SH 大众公用` / `000837.SZ 秦川机床` in aesthetic watch.
