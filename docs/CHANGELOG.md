# Development Changelog

This file is the shared multi-agent update log. Every development milestone should add a dated entry with scope, changed files, validation, deployment status, and follow-up notes.

## 2026-05-26

### Strategy Data Quality Health

- `system-health.json` now checks strategy archive quality in addition to the latest strategy report:
  - `backtests/history/index.json` exists and points at the latest strategy date
  - latest archive has `meta.replayTracking`
  - `replay-review.json` exists and is synced to the archive latest date
  - strong-watch plus aesthetic-watch counts are not unexpectedly zero
  - daily production outputs expose date mismatches across latest, plan, strategy, archive, and replay review
- The homepage “系统状态” block now shows dedicated “策略数据” and “生产链路” cards, so daily chain failures are visible on the website.
- The health script still only reads local JSON/cache files and does not call 必盈 API.

Changed files:

- `scripts/run-system-health.ts`
- `src/App.tsx`
- `src/styles.css`
- `README.md`
- `docs/HANDOFF.md`
- `docs/CHANGELOG.md`

Validation:

- `npm run health`
- `npm run build`
- Browser check on `http://localhost:5174/`:
  - rendered “策略数据” and “生产链路”
  - no browser console errors

Deployment:

- Deployed source to `/opt/a-share-money-radar`.
- Built on server with `/opt/node-v24`.
- Ran `npm run health` on production:
  - `status: ok`
  - `strategyDataQuality.tone: ok`
  - archive latest date `2026-05-25`
  - replay review samples/tracking `28/28`
  - production chain latest/plan/strategy/archive/replay dates all `2026-05-25`
- Synced `dist/` to `http://112.126.57.131/` with `reports` excluded.
- Verified production UI renders “策略数据” and “生产链路” with no browser console errors.

### Strategy Replay Review Dashboard

- `strategy:refresh-replay` now writes `reports/backtests/replay-review.json`.
- The replay review report aggregates strategy archive candidates into:
  - `+5%` / `+8%` / `+10%` hit leaderboards
  - drawdown risk leaderboard
  - still-tracking list
  - near-target list
  - pool-level performance for main, strong watch, and aesthetic watch
  - factor buckets for `30m缩量比`, `回撤`, and `5日资金`
- The strategy experiment tab now shows a “策略复盘榜单” panel using `replay-review.json`.
- The panel stays useful before 5/10d completion by surfacing the tracking list, then fills hit/risk/factor boards as replay windows complete.
- Mobile layout was verified with no horizontal overflow.

Changed files:

- `scripts/run-strategy-replay-refresh.ts`
- `src/App.tsx`
- `src/styles.css`
- `README.md`
- `docs/HANDOFF.md`
- `docs/CHANGELOG.md`

Validation:

- `npm run build`
- `npm run strategy:refresh-replay`
- Browser check on `http://localhost:5174/` strategy tab:
  - rendered “策略复盘榜单”
  - rendered `+5% 命中榜`, `回撤风险榜`, `仍在追踪`, and `最近有效特征`
  - mobile viewport `390x844` had no horizontal overflow

Deployment:

- Deployed source to `/opt/a-share-money-radar`.
- Built on server with `/opt/node-v24`.
- Ran `npm run strategy:refresh-replay` on production:
  - refreshed `2026-05-22` and `2026-05-25`
  - emitted `replay-review.json` with 2 history dates and 28 tracking candidates
- Refreshed `system-health.json`.
- Synced `dist/` to `http://112.126.57.131/` with `reports` excluded.
- Verified production UI renders “策略复盘榜单”, `+5% 命中榜`, `回撤风险榜`, `仍在追踪`, and `最近有效特征` with no console errors.

### Strategy Replay Tracking Automation

- Added `strategy:refresh-replay` to refresh archived strategy replay results from local daily K-line cache.
- The refresh script updates archived `history/YYYY-MM-DD.json` reports with:
  - 5/10 day close return
  - max runup and max runup date/day
  - max drawdown and max drawdown date/day
  - +5%/+8%/+10% hit flags
  - pending progress via `availableDays` and `remainingDays`
- The archive index now records replay status and recent hit rates, enabling the website to show “追踪中 / 5日已验证 / 10日已验证”.
- `daily:close` now runs `strategy:refresh-replay` after `strategy:latest`.
- The strategy tab now has a “最近信号追踪” panel and candidate cards show replay verification status.
- `run-strategy-backtest.ts` now writes replay progress metadata even when a selected date has no future bars yet.

Changed files:

- `package.json`
- `scripts/run-strategy-backtest.ts`
- `scripts/run-strategy-replay-refresh.ts`
- `src/App.tsx`
- `src/styles.css`
- `README.md`
- `docs/HANDOFF.md`
- `docs/CHANGELOG.md`

Validation:

- `npm run build`
- `npm run strategy:refresh-replay`

Deployment:

- Deployed source to `/opt/a-share-money-radar`.
- Built on server with `/opt/node-v24`.
- Synced `dist/` to `http://112.126.57.131/` with `reports` excluded.
- Ran `npm run strategy:refresh-replay` on production reports:
  - `2026-05-22`: pending, 1 future trade day available, 9 days remaining for 10d.
  - `2026-05-25`: pending, 0 future trade days available, 10 days remaining for 10d.
- Refreshed `system-health.json` and verified production UI exposes “最近信号追踪”.

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
