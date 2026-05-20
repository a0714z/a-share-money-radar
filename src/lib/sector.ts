import type { CompanyProfile, SectorConcentrationReport, StockPick } from "./types";

type SectorRule = {
  sector: string;
  keywords: string[];
  priority: number;
};

const sectorRules: SectorRule[] = [
  {
    sector: "绿色电力",
    priority: 98,
    keywords: ["电力", "绿色电力", "清洁能源", "风电", "风能", "光伏", "储能", "虚拟电厂", "抽水蓄能", "超超临界", "垃圾发电", "天然气", "氢能源", "碳中和"]
  },
  {
    sector: "半导体显示",
    priority: 96,
    keywords: ["半导体", "芯片", "集成电路", "OLED", "MLED", "LED", "柔性电子", "折叠屏", "显示", "电子纸", "传感器", "苹果产业链"]
  },
  {
    sector: "数字科技",
    priority: 90,
    keywords: ["信创", "数据要素", "数据确权", "算力", "东数西算", "云计算", "大数据", "人工智能", "DeepSeek", "智谱AI", "国资云", "网络安全", "操作系统", "智慧政务", "数字经济", "工业互联网"]
  },
  {
    sector: "传媒内容",
    priority: 108,
    keywords: ["传媒", "影视", "广电", "短剧", "IP", "知识付费", "云视频", "虚拟数字人", "影视动漫"]
  },
  {
    sector: "港口物流",
    priority: 84,
    keywords: ["港口", "港口运输", "航运", "物流", "仓储", "海上丝路", "自由贸易港", "RCEP"]
  },
  {
    sector: "医药医疗",
    priority: 82,
    keywords: ["医药", "医疗", "医疗器械", "智慧医疗", "互联医疗", "生物", "民营医院", "养老产业"]
  },
  {
    sector: "高端制造",
    priority: 78,
    keywords: ["机器人", "智能制造", "工业母机", "高铁", "铁路基建", "智能交通", "低空经济", "核聚变", "专精特新"]
  },
  {
    sector: "消费服务",
    priority: 72,
    keywords: ["新零售", "旅游酒店", "体育产业", "在线教育", "智能家居", "家电", "食品", "消费"]
  },
  {
    sector: "金融地产",
    priority: 70,
    keywords: ["金融", "券商", "银行", "保险", "房地产", "地产", "参股金融", "融资租赁"]
  }
];

const weakConcepts = new Set([
  "所属概念板块",
  "融资融券",
  "大盘",
  "中盘",
  "小盘",
  "低价",
  "业绩预升",
  "业绩预降",
  "破净股",
  "MSCI中国",
  "基金重仓",
  "国企改革",
  "国资改革",
  "央企改革",
  "深圳本地",
  "广东国资",
  "北京国资",
  "陆股通活跃"
]);

function splitIdeas(profile?: CompanyProfile) {
  return String(profile?.idea ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function profileText(profile?: CompanyProfile) {
  return `${profile?.idea ?? ""},${profile?.bscope ?? ""},${profile?.name ?? ""}`.toUpperCase();
}

function fallbackSector(name: string) {
  if (/(能源|电力|电气|燃气|煤电|发电|热电|水电)/.test(name)) return "绿色电力";
  if (/(港|航运|物流|机场|铁路|高速)/.test(name)) return "港口物流";
  if (/(传媒|文化|广电|出版|影视|游戏)/.test(name)) return "传媒内容";
  if (/(科技|电子|芯片|半导体|光电|显示)/.test(name)) return "半导体显示";
  if (/(软件|信息|数据|通信|网络|智能)/.test(name)) return "数字科技";
  if (/(药|医|生物|医疗)/.test(name)) return "医药医疗";
  if (/(银行|证券|保险|地产|置业)/.test(name)) return "金融地产";
  return "其他";
}

export function inferSector(name: string, profile?: CompanyProfile) {
  const text = profileText(profile);
  const scored = sectorRules
    .map((rule) => {
      const hits = rule.keywords.filter((keyword) => text.includes(keyword.toUpperCase())).length;
      return { rule, hits, score: hits ? rule.priority + hits * 6 : 0 };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  const ideas = splitIdeas(profile)
    .filter((item) => !weakConcepts.has(item))
    .slice(0, 8);

  if (scored.length) {
    return {
      sector: scored[0].rule.sector,
      themes: ideas,
      source: "biying" as const
    };
  }

  return {
    sector: fallbackSector(name),
    themes: ideas,
    source: profile ? ("biying" as const) : ("fallback" as const)
  };
}

export function attachSector(pick: StockPick, profile?: CompanyProfile): StockPick {
  const result = inferSector(pick.name, profile);
  return {
    ...pick,
    sector: result.sector,
    themes: result.themes,
    sectorSource: result.source
  };
}

export function downgradeForConcentration(pick: StockPick, maxPerSector: number): StockPick {
  const sector = pick.sector ?? "其他";
  const risk = `行业集中度过滤：${sector} 核心池已满`;
  return {
    ...pick,
    signal: "watch",
    rating: "观察",
    concentration: {
      ...(pick.concentration ?? { sector, groupRank: 0, groupSize: 0, maxPerSector, demoted: false }),
      demoted: true,
      maxPerSector
    },
    risks: pick.risks.includes(risk) ? pick.risks : [...pick.risks, risk]
  };
}

export function buildConcentrationReport(strong: StockPick[], picks: StockPick[], demoted: StockPick[], maxPerSector: number): SectorConcentrationReport {
  const groups = new Map<string, StockPick[]>();
  for (const pick of strong) {
    const sector = pick.sector ?? "其他";
    groups.set(sector, [...(groups.get(sector) ?? []), pick]);
  }

  return {
    maxPerSector,
    applied: demoted.length > 0,
    demoted: demoted.length,
    groups: [...groups.entries()]
      .map(([sector, items]) => ({
        sector,
        totalStrong: items.length,
        keptCore: picks.filter((pick) => (pick.sector ?? "其他") === sector).length,
        demoted: demoted.filter((pick) => (pick.sector ?? "其他") === sector).length,
        maxPerSector,
        instruments: items.map((pick) => pick.instrument)
      }))
      .sort((a, b) => b.totalStrong - a.totalStrong || a.sector.localeCompare(b.sector)),
    notes: demoted.length ? [`同一主题核心池最多保留 ${maxPerSector} 只，超出的高分票降为观察`] : [`同一主题核心池最多保留 ${maxPerSector} 只，当前未触发降级`]
  };
}
