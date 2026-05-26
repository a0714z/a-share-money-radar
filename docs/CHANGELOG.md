# Development Changelog

This file is the shared multi-agent update log. Every development milestone should add a dated entry with scope, changed files, validation, deployment status, and follow-up notes.

## 2026-05-26

### Strategy Candidate Archive UI

- Added a front-end “当日核心候选池” section on the strategy experiment tab.
- The candidate pool deduplicates by stock and prioritizes main strategy, then strong watch, then aesthetic watch.
- Each candidate card now exposes the selection reason, 30m score, shrink ratio, pullback, 5-day flow, and 5/10-day replay status directly on the page.
- Strategy archive rows are now selectable; selecting a date loads `reports/backtests/history/YYYY-MM-DD.json` and shows that day’s candidate pool plus benchmark metrics.
- Tightened strategy mobile layout so candidate cards and strategy mobile tables do not create horizontal overflow.
- Corrected handoff notes for production `2026-05-25`: strategy report and health are now synced and `ok`.

Changed files:

- `src/App.tsx`
- `src/styles.css`
- `docs/HANDOFF.md`
- `docs/CHANGELOG.md`

Validation:

- `npm run build`
- Browser check on `http://localhost:5174/` strategy tab:
  - desktop DOM contained “当日核心候选池”, “策略归档”, and “归档候选池”
  - archive date button loaded without console errors
  - mobile viewport `390x844` had no horizontal overflow

Deployment:

- Deployed `dist/` to `http://112.126.57.131/` with `reports` excluded.
- Verified production HTML references the new built assets.
- Verified production strategy report remains `2026-05-25` with main `0`, strong watch `1`, aesthetic `7`.
- Verified production `system-health.json` status is `ok`.

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
