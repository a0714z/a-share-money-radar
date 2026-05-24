# A股资金雷达

基于必盈 API 的主板非 ST 异动票雷达。项目目标不是做全市场股票查询，而是在每天收盘后筛出“已经出现资金/量价异动、可能需要操作或继续跟踪”的股票，并生成页面、交易预案、复盘、健康检查和邮件提醒。

生产页面：`http://112.126.57.131/`

更完整的接手说明见 `docs/HANDOFF.md`。开发前请先阅读该文档，尤其是 API 风控边界和服务器部署事实。

## 当前生产方式

- 生产代码目录：`/opt/a-share-money-radar`
- 静态页面目录：`/var/www/a-share-money-radar`
- 运行报告目录：`/var/www/a-share-money-radar/reports`
- 生产 Node：`/opt/node-v24/bin/node`
- 服务器环境变量：`/etc/a-share-money-radar.env`
- 收盘生产：交易日 18:00 由 `a-share-kline-close.timer` 触发
- 邮件通知：交易日 09:00 由 `a-share-morning-notify.timer` 触发

服务器上的 `/opt/a-share-money-radar` 是 rsync 部署目录，不是 Git 工作区。推荐流程是本地开发、提交 GitHub、再打包同步到服务器。

## 数据流

每天收盘生产入口：

```bash
npm run daily:close
```

该脚本会依次执行：

```bash
npm run kline:sync &&
API_CACHE_REFRESH=1 npm run scan &&
API_CACHE_REFRESH=1 npm run plan &&
npm run action:refresh &&
npm run review &&
npm run stock:details &&
npm run health
```

主要输出：

- `public/reports/latest.json`：今日异动票和观察名单
- `public/reports/plan.json`：交易预案
- `public/reports/performance.json`：历史复盘
- `public/reports/system-health.json`：系统健康
- `public/reports/stocks/index.json`：异动票详情索引
- `public/reports/stocks/{instrument}.json`：单票详情

生产环境中这些文件写入 `/var/www/a-share-money-radar/reports`。

## API 风控边界

必须遵守：

- 页面只读取 `/reports/*.json` 和 `/reports/stocks/*.json`。
- 邮件只读取本地报告 JSON。
- 普通 `scan`/`plan` 的 K 线读取必须走本地 K 线缓存。
- 资金流和公司资料默认只读 `.cache/biying`。
- 只有 `API_CACHE_REFRESH=1` 时才允许刷新资金流/公司资料缓存。
- GitHub Actions 不承担定时扫描职责，不要恢复会调用必盈 API 的 schedule。

当前允许调用必盈 API 的入口主要是 `kline:sync`，以及带 `API_CACHE_REFRESH=1` 的收盘生产任务。

## 本地开发

安装依赖并构建：

```bash
npm install
npm run build
```

启动开发页面：

```bash
npm run dev
```

本地只看界面时，可以使用仓库内已有 `public/reports` 数据。需要生成样例数据时：

```bash
npm run scan:sample
npm run review:sample
```

需要跑真实数据时，复制环境变量模板并填入本地密钥：

```bash
cp .env.example .env.local
```

不要把必盈 license、SMTP 授权码或服务器 root 密码写入仓库。

## 常用脚本

```bash
npm run build
npm run kline:sync
npm run scan
npm run plan
npm run action:refresh
npm run review
npm run stock:details
npm run health
npm run notify:dry
npm run notify
npm run daily:close
```

- `kline:sync`：批量同步日 K、30m K 和指数 K 线。
- `scan`：生成 `latest.json`，默认从本地缓存读 K 线。
- `plan`：生成 `plan.json`，默认从本地缓存读 K 线。
- `action:refresh`：给现有报告补操作状态，不调用 API。
- `review`：生成 `performance.json`，只读本地 K 线缓存。
- `stock:details`：生成异动票详情 JSON 和搜索索引。
- `health`：生成 `system-health.json`。
- `notify:dry`：预览邮件内容，不发送。
- `notify`：发送邮件，只读本地 JSON。
- `backtest:strategy`：只读本地缓存的策略回测实验脚本。
- `cache:plan`：只扫描本地缓存并生成补数请求计划，不调用 API。
- `data:bootstrap`：一次性串行补齐研究用日 K、30m K 和资金流缓存。

## 策略回测

当前实验方向是在历史日期上模拟“当日选股”，再用后续 10/20 个交易日验证表现。回测脚本只读本地缓存，不调用必盈 API：

```bash
npm run backtest:strategy -- --from 2026-01-01 --to 2026-03-31 --horizons 10,20 --top 10 --target-pct 5
```

输出：

- `public/reports/backtests/latest.json`
- `public/reports/backtests/summary.md`

数据补齐必须通过受控脚本进行。必盈 API 请求只能串行，不能并发；项目已在 `BiyingClient` 层加入串行队列和请求频率保护。

一次性补齐我认为足够第一阶段策略回测的数据范围：

```bash
npm run data:bootstrap
```

默认会拉取：

- 全部主板非 ST 股票的 `620` 根日 K。
- 全部主板非 ST 股票的 `1200` 根 30m K。
- 全部主板非 ST 股票的 `240` 条资金流。
- 主要指数约 `1100` 个自然日范围的日 K。

可调参数：

```bash
npm run data:bootstrap -- --daily-bars 760 --30m-bars 1600
npm run data:bootstrap -- --daily-only
npm run data:bootstrap -- --flow-only
npm run data:bootstrap -- --kline-only
npm run data:bootstrap -- --force
```

补数过程会跳过已经满足数量要求的缓存；`--force` 会强制重拉。运行摘要写入：

- `public/reports/backtests/research-data-bootstrap.json`

`cache:plan` 仍可作为诊断工具使用，但主流程是直接用 `data:bootstrap` 建立研究数据集。

## GitHub Actions

`.github/workflows/daily-scan-pages.yml` 现在只在 push 到 `main` 或手动触发时构建静态页面并部署旧 GitHub Pages，不做定时扫描、不提交报告、不发送邮件。真实生产页面以服务器 `http://112.126.57.131/` 为准。

`.github/workflows/ci.yml` 用于 PR 或手动触发的构建校验，会生成样例报告后执行 `npm run build`。

## 部署摘要

部署细节见 `docs/HANDOFF.md`。核心原则：

- 本地打包并同步源码到 `/opt/a-share-money-radar`。
- 服务器使用 `/opt/node-v24/bin/npm` 安装依赖和构建。
- 将 `dist/` 同步到 `/var/www/a-share-money-radar/`。
- 同步静态页面时必须保留 `/var/www/a-share-money-radar/reports`。
- 不要覆盖 `/opt/a-share-money-radar/.cache`。

## 风险说明

这是研究和提醒工具，不构成投资建议。A 股数据、复权方式、资金流口径和盘后更新时间都会影响结果；实际交易仍需要结合仓位、止损、行业事件和市场环境。
