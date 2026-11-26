// 失效分析知识库：历史 8D 案例摘要
export interface FaCase {
  id: string;
  title: string;
  date: string;
  pattern: string;
  bins: number[];
  module: string;
  tags: string[];
  rootCause: string;
  fix: string;
  yieldImpact: string;
}

export const FA_CASES: FaCase[] = [
  {
    id: "FA-2025-031",
    title: "存储节点刻蚀更换聚焦环后边缘 CD 收缩导致数据保持失效",
    date: "2025-06-12",
    pattern: "边缘环",
    bins: [7],
    module: "电容存储节点刻蚀",
    tags: ["focus ring", "聚焦环", "边缘", "CD", "数据保持", "tREF", "季化", "seasoning", "PM", "刻蚀"],
    rootCause:
      "新聚焦环高度与磨损后旧件存在约 0.3 mm 差异，晶圆边缘鞘层弯曲，离子入射角偏斜，r > 0.8 区域底部 CD 收缩 3~4 nm，存储节点未完全打开，电容值不足，表现为 Bin 7 数据保持失效。季化片数不足放大了影响。",
    fix: "季化提升至 ≥ 50 片并增加边缘 CD 抽检作为复机必检项；聚焦环更换后执行边缘调谐配方（edge tuning gas 比例 +8%）；受影响 WIP 在电容介质沉积前做 CD 全检分流。",
    yieldImpact: "受影响晶圆良率 −20~25 个百分点",
  },
  {
    id: "FA-2024-118",
    title: "CMP 抛光垫寿命末期与保持环压力波动引起弧形划伤",
    date: "2024-11-03",
    pattern: "划伤",
    bins: [6, 3],
    module: "存储节点接触 CMP",
    tags: ["CMP", "划伤", "scratch", "抛光垫", "保持环", "膜片", "阵列失效"],
    rootCause: "抛光垫寿命 > 90% 后沟槽堵塞，配合保持环压力波动，硬质颗粒在晶圆表面拖出弧形划伤，切断位线接触，表现为阵列不可修复（Bin 6）和开短路（Bin 3）。",
    fix: "抛光垫寿命上限由 100% 下调至 90%；保持环压力波动纳入 SPC 互锁；CMP 后 Surfscan 划伤类缺陷 > 50 自动扣留。",
    yieldImpact: "受影响晶圆良率 −6~10 个百分点",
  },
  {
    id: "FA-2025-007",
    title: "TiN 顶电极喷淋头堵塞导致中心区域漏电",
    date: "2025-02-20",
    pattern: "中心团簇",
    bins: [4],
    module: "TiN 顶电极沉积",
    tags: ["TiN", "喷淋头", "showerhead", "中心", "漏电", "IDD", "MFC", "沉积"],
    rootCause: "喷淋头中心孔部分堵塞，中心区域 TiN 偏薄，电容顶电极覆盖不足，单元漏电升高，表现为 IDD 超限（Bin 4）中心团簇。",
    fix: "更换喷淋头；TiCl4 MFC 偏差 > 3% 设为互锁；TiN 厚度量测由 5 点扩展为 13 点并监控中心/边缘比。",
    yieldImpact: "受影响晶圆良率 −8~12 个百分点",
  },
  {
    id: "FA-2024-072",
    title: "STI 刻蚀腔体颗粒导致随机型开短路上升",
    date: "2024-07-15",
    pattern: "随机",
    bins: [3],
    module: "STI 浅槽隔离刻蚀",
    tags: ["颗粒", "particle", "随机", "开短路", "STI"],
    rootCause: "腔体顶盖涂层剥落，颗粒随机落在晶圆上。",
    fix: "更换顶盖，增加 PM 后颗粒监控频次。",
    yieldImpact: "批次良率 −2~3 个百分点",
  },
  {
    id: "FA-2025-044",
    title: "ALD 高 k 介质前驱体温控异常导致整片保持时间劣化",
    date: "2025-08-02",
    pattern: "随机",
    bins: [7, 5],
    module: "高 k 电介质 ALD",
    tags: ["ALD", "高 k", "保持", "前驱体", "温控"],
    rootCause: "前驱体源瓶加热器失控，介质膜致密性下降，整片均匀劣化，无明显空间模式。",
    fix: "加热器更换并加入源瓶温度互锁。",
    yieldImpact: "受影响晶圆良率 −5 个百分点",
  },
  {
    id: "FA-2023-155",
    title: "晶边光刻胶残留引起边缘局部开路",
    date: "2023-12-08",
    pattern: "边缘局部",
    bins: [3],
    module: "光刻 / 去边",
    tags: ["EBR", "去边", "边缘局部", "开路", "光刻"],
    rootCause: "去边（EBR）喷嘴偏位，晶圆一侧边缘光刻胶残留。",
    fix: "喷嘴校准，增加晶边检测。",
    yieldImpact: "受影响晶圆良率 −3 个百分点",
  },
];

export function searchCases(query: string, pattern?: string, bin?: number) {
  const words = query
    .toLowerCase()
    .split(/[\s,，、;；/]+/)
    .filter(Boolean);
  return FA_CASES.map((c) => {
    const hay = [c.title, c.module, c.rootCause, ...c.tags].join(" ").toLowerCase();
    let score = words.reduce((s, w) => s + (hay.includes(w) ? 1 : 0), 0);
    if (pattern && c.pattern === pattern) score += 2;
    if (bin && c.bins.includes(bin)) score += 1.5;
    return { c, score };
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ c, score }) => ({ ...c, relevance: Math.min(0.98, +(score / (words.length + 3.5)).toFixed(2)) }));
}
