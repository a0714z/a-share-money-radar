# A股资金雷达

基于必盈 API 的主板非 ST 量化选股平台。项目每天收盘后运行一次扫描，寻找“资金开始进场，同时价格仍处在有性价比区域”的候选标的。

## 核心逻辑

- 股票池：只保留 `000/001/002/003/600/601/603/605` 主板代码，剔除名称包含 `ST`、`*ST`、`退` 的标的。
- 粗筛：用全市场实时行情过滤成交额、量比、涨跌幅、60 日涨幅和流动性。
- 精筛：对候选池补 120 日 K 线和 10 日资金流向。
- 打分：资金流入 40%，价格分位与回撤 30%，趋势成本区 20%，流动性 10%，再扣除追高、过热、破位、流动性不足等风险。
- 市场过滤：用上证指数、深证成指、沪深300、创业板指的 20/60 日线和短期收益判断强势、震荡、弱势；震荡时收紧核心池，弱势时暂停强关注。
- 输出：`public/reports/latest.json`，前端读取这份报告展示核心强关注、观察和等待名单。默认核心池控制在个位数，避免候选过多。
- 复盘：每天归档 `public/reports/history/YYYY-MM-DD.json`，并生成 `public/reports/performance.json` 追踪核心池 1/3/5/10 日表现。

## 本地运行

```bash
cp .env.example .env.local
# 把 BIYING_LICENSE 改成你的必盈 API 证书
npm install
npm run scan
npm run review
npm run dev
```

只看界面可以先生成样例报告：

```bash
npm run scan:sample
npm run review:sample
npm run dev
```

## GitHub Actions

`.github/workflows/daily-scan-pages.yml` 会在交易日北京时间 22:15 运行：

1. 如果仓库 secret `BIYING_LICENSE` 存在，拉取必盈数据并生成真实报告。
2. 如果 secret 不存在，生成样例报告，保证页面仍可构建。
3. 提交 `public/reports/latest.json`、历史归档和 `public/reports/performance.json`，构建静态前端，并上传构建产物 artifact。
4. 如果仓库是公开仓库，额外部署到 GitHub Pages；私有仓库会保留在 Actions artifact 中。

## 配置项

| 环境变量 | 默认值 | 说明 |
| --- | ---: | --- |
| `BIYING_LICENSE` | 必填 | 必盈 API 证书 |
| `SCAN_TOP_N` | `8` | 核心强关注最多展示数量 |
| `SCAN_HISTORY_DAYS` | `120` | 历史 K 线窗口 |
| `SCAN_FLOW_DAYS` | `10` | 资金流向窗口 |
| `SCAN_FLOW_CANDIDATE_LIMIT` | `180` | 进入精筛的候选数量 |
| `SCAN_MIN_AMOUNT` | `30000000` | 最低成交额 |

## 风险说明

这是研究和提醒工具，不构成投资建议。A 股数据、复权方式、资金流口径和盘后更新时间都会影响结果；实际交易仍需要结合仓位、止损、行业事件和市场环境。
