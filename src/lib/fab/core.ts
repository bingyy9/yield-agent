// 合成晶圆厂数据的基础定义：几何、Bin 定义、工艺路线、批次清单。
// 一切数据由确定性随机数生成，同一份代码在服务端（工具执行）和浏览器（看板渲染）得到完全相同的结果。

export const TODAY = "2026-11-25";
export const PRODUCT = "D1b LPDDR5 16Gb";
export const PRODUCT_CODE = "N3B";
export const BASELINE_YIELD = 0.912;

// ---------- 随机数 ----------

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function rng(seed: number | string) {
  let a = typeof seed === "string" ? hashString(seed) : seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gauss(r: () => number) {
  const u = Math.max(r(), 1e-9);
  const v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------- 晶圆几何 ----------

export const WAFER_RADIUS = 150; // mm
export const EDGE_EXCLUSION = 3;
export const DIE_W = 9.6;
export const DIE_H = 10.4;
export const COLS = 32;
export const ROWS = 29;

export interface DieSite {
  i: number; // 列
  j: number; // 行
  x: number; // 中心坐标 mm，向右为正
  y: number; // 中心坐标 mm，向上为正
  r: number; // 归一化半径 0..1
  theta: number; // 弧度
}

function buildSites(): DieSite[] {
  const sites: DieSite[] = [];
  const usable = WAFER_RADIUS - EDGE_EXCLUSION;
  for (let j = 0; j < ROWS; j++) {
    for (let i = 0; i < COLS; i++) {
      const x = (i - COLS / 2 + 0.5) * DIE_W;
      const y = (ROWS / 2 - j - 0.5) * DIE_H;
      const corners = [
        [x - DIE_W / 2, y - DIE_H / 2],
        [x + DIE_W / 2, y - DIE_H / 2],
        [x - DIE_W / 2, y + DIE_H / 2],
        [x + DIE_W / 2, y + DIE_H / 2],
      ];
      if (corners.every(([cx, cy]) => Math.hypot(cx, cy) <= usable)) {
        sites.push({ i, j, x, y, r: Math.hypot(x, y) / usable, theta: Math.atan2(y, x) });
      }
    }
  }
  return sites;
}

export const SITES = buildSites();
export const DIES_PER_WAFER = SITES.length;

// ---------- Bin 定义 ----------

export type BinId = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface BinDef {
  id: BinId;
  name: string;
  short: string;
  pass: boolean;
  color: string;
  desc: string;
}

// 失效 Bin 的分类色经 dataviz 校验脚本验证（all-pairs、浅色晶圆底）。Bin 8 为中性灰，不占分类色。
export const BINS: Record<BinId, BinDef> = {
  1: { id: 1, name: "Bin 1 良品", short: "良品", pass: true, color: "#cdd6db", desc: "全部 CP 测试通过" },
  2: { id: 2, name: "Bin 2 修复良品", short: "修复良品", pass: true, color: "#a9b7bf", desc: "经冗余行/列修复后通过" },
  3: { id: 3, name: "Bin 3 开短路", short: "开短路", pass: false, color: "#199e70", desc: "接触/连通性测试失效" },
  4: { id: 4, name: "Bin 4 IDD 漏电", short: "IDD 漏电", pass: false, color: "#2a78d6", desc: "待机/工作电流超限" },
  5: { id: 5, name: "Bin 5 时序", short: "时序", pass: false, color: "#e87ba4", desc: "tAA/tRCD 等时序参数失效" },
  6: { id: 6, name: "Bin 6 阵列不可修复", short: "阵列失效", pass: false, color: "#4a3aa7", desc: "失效位超出冗余修复能力" },
  7: { id: 7, name: "Bin 7 数据保持", short: "数据保持", pass: false, color: "#d03a2c", desc: "tREF 刷新时间内数据保持失效" },
  8: { id: 8, name: "Bin 8 其他参数", short: "其他", pass: false, color: "#7d8894", desc: "其他参数类失效" },
};

export const FAIL_BINS: BinId[] = [3, 4, 5, 6, 7, 8];
export const ALL_BINS: BinId[] = [1, 2, 3, 4, 5, 6, 7, 8];

// ---------- 工艺路线 ----------

export interface Tool {
  id: string;
  chambers: string[];
  kind: "刻蚀" | "沉积" | "CMP" | "ALD";
}

export interface Step {
  id: string;
  name: string;
  offsetDays: number; // 相对投片日
  tools: Tool[];
}

export const ROUTE: Step[] = [
  { id: "1100", name: "STI 浅槽隔离刻蚀", offsetDays: 0, tools: [
    { id: "ETCH-02", chambers: ["A", "B"], kind: "刻蚀" },
    { id: "ETCH-03", chambers: ["A", "B"], kind: "刻蚀" },
  ] },
  { id: "2300", name: "埋入式字线 W 沉积", offsetDays: 6, tools: [
    { id: "DEP-05", chambers: ["A", "B"], kind: "沉积" },
    { id: "DEP-06", chambers: ["A", "B"], kind: "沉积" },
  ] },
  { id: "3400", name: "位线接触刻蚀", offsetDays: 12, tools: [
    { id: "ETCH-04", chambers: ["A", "B", "C"], kind: "刻蚀" },
  ] },
  { id: "4200", name: "存储节点接触 CMP", offsetDays: 18, tools: [
    { id: "CMP-03", chambers: ["H1", "H2", "H3", "H4"], kind: "CMP" },
    { id: "CMP-04", chambers: ["H1", "H2", "H3", "H4"], kind: "CMP" },
  ] },
  { id: "5100", name: "电容存储节点刻蚀（高深宽比）", offsetDays: 24, tools: [
    { id: "ETCH-07", chambers: ["A", "B", "C"], kind: "刻蚀" },
    { id: "ETCH-05", chambers: ["A", "B"], kind: "刻蚀" },
  ] },
  { id: "5300", name: "高 k 电介质 ALD", offsetDays: 27, tools: [
    { id: "ALD-04", chambers: ["A", "B"], kind: "ALD" },
    { id: "ALD-02", chambers: ["A", "B"], kind: "ALD" },
  ] },
  { id: "5400", name: "TiN 顶电极沉积", offsetDays: 29, tools: [
    { id: "DEP-11", chambers: ["A", "B"], kind: "沉积" },
    { id: "DEP-12", chambers: ["A", "B"], kind: "沉积" },
  ] },
  { id: "6100", name: "M1 金属刻蚀", offsetDays: 36, tools: [
    { id: "ETCH-09", chambers: ["A", "B"], kind: "刻蚀" },
  ] },
];

export const CP_OFFSET_DAYS = 62;

export const STEP_BY_ID = Object.fromEntries(ROUTE.map((s) => [s.id, s])) as Record<string, Step>;

export function findTool(toolId: string): { step: Step; tool: Tool } | null {
  for (const step of ROUTE) {
    const tool = step.tools.find((t) => t.id === toolId);
    if (tool) return { step, tool };
  }
  return null;
}

// ---------- 日期工具 ----------

export function addDays(date: string, days: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
}

// ---------- 批次清单 ----------

// 每道工序选哪台机台、哪些腔体参与（按槽位轮转分配）。未指定的工序由随机数决定。
export interface LotDef {
  id: string;
  start: string;
  overrides?: Record<string, { tool: string; chambers?: string[] }>;
  note?: string;
}

export const LOT_DEFS: LotDef[] = [
  { id: "N3B398", start: "2026-09-05", overrides: { "5100": { tool: "ETCH-07" } } },
  { id: "N3B401", start: "2026-09-08", overrides: { "5100": { tool: "ETCH-05" } } },
  { id: "N3B403", start: "2026-09-10", overrides: { "5100": { tool: "ETCH-07" }, "4200": { tool: "CMP-04" } } },
  { id: "N3B406", start: "2026-09-12", overrides: { "5100": { tool: "ETCH-05" }, "4200": { tool: "CMP-04" } } },
  { id: "N3B409", start: "2026-09-14", overrides: { "4200": { tool: "CMP-03" }, "5100": { tool: "ETCH-05" }, "5400": { tool: "DEP-12" } } },
  { id: "N3B412", start: "2026-09-16", overrides: { "5400": { tool: "DEP-11" }, "5100": { tool: "ETCH-05" }, "4200": { tool: "CMP-04" } } },
  { id: "N3B414", start: "2026-09-18", overrides: { "5100": { tool: "ETCH-07" }, "4200": { tool: "CMP-04" }, "5400": { tool: "DEP-12" } } },
  { id: "N3B419", start: "2026-09-22", overrides: { "5100": { tool: "ETCH-05" }, "4200": { tool: "CMP-04" }, "5400": { tool: "DEP-12" } } },
  // 主场景：ETCH-07 腔体 B 因静电卡盘问题停机，晶圆只在 A/C 间轮转
  { id: "N3B417", start: "2026-09-23", overrides: { "5100": { tool: "ETCH-07", chambers: ["A", "C"] }, "4200": { tool: "CMP-04" }, "5400": { tool: "DEP-12" } } },
  { id: "N3B421", start: "2026-09-24", overrides: { "5100": { tool: "ETCH-07" }, "4200": { tool: "CMP-04" }, "5400": { tool: "DEP-11" } } },
  // 以下为在制批次（尚未 CP）
  { id: "N3B425", start: "2026-09-28", overrides: { "5100": { tool: "ETCH-07" } } },
  { id: "N3B428", start: "2026-10-01", overrides: { "5100": { tool: "ETCH-07", chambers: ["A", "C"] } } },
  { id: "N3B430", start: "2026-10-04", overrides: { "5100": { tool: "ETCH-05" } } },
  { id: "N3B433", start: "2026-10-08", overrides: { "5100": { tool: "ETCH-07" } } },
  { id: "N3B436", start: "2026-10-13", overrides: { "5100": { tool: "ETCH-07" } } },
  { id: "N3B439", start: "2026-10-19", overrides: { "5100": { tool: "ETCH-05" } } },
  { id: "N3B442", start: "2026-10-27", overrides: { "5100": { tool: "ETCH-07" } } },
  { id: "N3B445", start: "2026-11-06", overrides: {} },
];

export const WAFERS_PER_LOT = 25;

// ---------- 根因（数据生成规则，仅用于造数据，不对 agent 暴露） ----------

export const HIDDEN_RULES = {
  etchEdge: { tool: "ETCH-07", chamber: "C", from: "2026-10-14" },
  cmpScratch: { tool: "CMP-03", chamber: "H2", from: "2026-09-29", to: "2026-10-07" },
  depCenter: { tool: "DEP-11", chamber: "B", from: "2026-10-13", to: "2026-10-18" },
};
