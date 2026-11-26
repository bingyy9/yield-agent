// Agent 工具：每个工具对模拟 fab 数据做真实计算，返回给模型的精简 JSON（forModel）和给界面的视图（view）。
import { sci } from "../sci";
import { z } from "zod";
import {
  baselineBinRates,
  binPareto,
  classifyWafer,
  commonality,
  radialProfile,
  stackedMap,
} from "../fab/analysis";
import { BASELINE_YIELD, BINS, BinId, FAIL_BINS, STEP_BY_ID, TODAY, findTool } from "../fab/core";
import { queryEvents } from "../fab/equipment";
import { searchCases } from "../fab/knowledge";
import { MetrologyParam, PARAM_META, queryMetrology } from "../fab/metrology";
import { Wafer, allLots, getLot, testedLots } from "../fab/wafers";
import type { Report8D, ToolView } from "./types";

export interface ToolOutput {
  forModel: unknown;
  view?: ToolView;
  summary: string;
}

class ToolError extends Error {}

const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;
const stepName = (id: string) => STEP_BY_ID[id]?.name ?? id;
const binIdSchema = z.coerce.number().int().min(3).max(8);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式应为 YYYY-MM-DD");

function requireTestedLot(id: string) {
  const lot = getLot(id);
  if (!lot) throw new ToolError(`找不到批次 ${id}。可用 list_lots 查看批次清单。`);
  if (!lot.binCounts) throw new ToolError(`批次 ${lot.id} 仍在制（当前完成到 ${stepName(lot.currentStep)}），还没有 CP 测试数据。`);
  return lot;
}

function focusRate(w: Wafer, bin: BinId) {
  let n = 0;
  for (const b of w.bins!) if (b === bin) n++;
  return n / w.bins!.length;
}

// ---------- 工具定义 ----------

const listLots = {
  name: "list_lots",
  description:
    "列出 D1b LPDDR5 16Gb 产品近期所有批次：状态（CP 完成 / 在制）、投片日、CP 日期、当前完成工序、批次良率。用于先掌握全局，找出良率异常的批次。",
  schema: z.object({
    status: z.enum(["全部", "CP 完成", "在制"]).optional().describe("按状态筛选，默认全部"),
  }),
  run({ status }: { status?: "全部" | "CP 完成" | "在制" }): ToolOutput {
    const lots = allLots()
      .filter((l) => !status || status === "全部" || l.status === status)
      .map((l) => ({
        id: l.id,
        status: l.status,
        start: l.start,
        cpDate: l.cpDate,
        currentStep: stepName(l.currentStep),
        yield: l.yield,
      }));
    const flagged = lots.filter((l) => l.yield !== null && l.yield < BASELINE_YIELD - 0.03);
    return {
      forModel: {
        today: TODAY,
        baselineYield: BASELINE_YIELD,
        lots: lots.map((l) => ({ ...l, yield: l.yield === null ? null : +l.yield.toFixed(4) })),
        lowYieldLots: flagged.map((l) => l.id),
      },
      view: { kind: "lots", lots, baseline: BASELINE_YIELD },
      summary: `${lots.length} 个批次，${flagged.length} 个良率低于基线 3 个百分点以上`,
    };
  },
};

const lotSummary = {
  name: "get_lot_summary",
  description:
    "获取单个已完成 CP 测试批次的良率概况：批次良率、各失效 Bin 的失效率与近期基线（其他批次中位数）的对比、每片晶圆良率。用于判断是哪类失效拉低了良率。",
  schema: z.object({ lot_id: z.string().describe("批次号，如 N3B417") }),
  run({ lot_id }: { lot_id: string }): ToolOutput {
    const lot = requireTestedLot(lot_id);
    const base = baselineBinRates([lot.id], testedLots());
    const pareto = binPareto(lot).map((p) => ({ ...p, baseline: base[p.bin] }));
    const waferYields = lot.wafers.map((w) => ({ slot: w.slot, yield: w.yield! }));
    const top = [...pareto].sort((a, b) => b.rate - b.baseline - (a.rate - a.baseline))[0];
    const worst = [...waferYields].sort((a, b) => a.yield - b.yield).slice(0, 6);
    return {
      forModel: {
        lotId: lot.id,
        yield: +lot.yield!.toFixed(4),
        baselineYield: BASELINE_YIELD,
        cpDate: lot.cpDate,
        failBins: pareto.map((p) => ({
          bin: p.bin,
          name: BINS[p.bin].name,
          rate: +p.rate.toFixed(4),
          baselineRate: +p.baseline.toFixed(4),
          ratioToBaseline: +(p.rate / Math.max(p.baseline, 1e-4)).toFixed(1),
        })),
        worstWafers: worst.map((w) => ({ slot: w.slot, yield: +w.yield.toFixed(3) })),
        waferYieldRange: [
          +Math.min(...waferYields.map((w) => w.yield)).toFixed(3),
          +Math.max(...waferYields.map((w) => w.yield)).toFixed(3),
        ],
      },
      view: { kind: "lotSummary", lotId: lot.id, yield: lot.yield!, baseline: BASELINE_YIELD, pareto, waferYields },
      summary: `良率 ${pct(lot.yield!)}；${BINS[top.bin].short} 失效率 ${pct(top.rate, 2)}，基线 ${pct(top.baseline, 2)}`,
    };
  },
};

const waferMaps = {
  name: "analyze_wafer_maps",
  description:
    "对批次内每片晶圆的 CP Bin 图做空间模式识别（边缘环、边缘局部、中心团簇、划伤、局部团簇、随机），并给出叠加图和径向失效分布。可指定关注的失效 Bin；不指定时自动选择相对基线超出最多的 Bin。",
  schema: z.object({
    lot_id: z.string().describe("批次号"),
    focus_bin: binIdSchema.optional().describe("关注的失效 Bin（3~8）"),
  }),
  run({ lot_id, focus_bin }: { lot_id: string; focus_bin?: number }): ToolOutput {
    const lot = requireTestedLot(lot_id);
    let focus = focus_bin as BinId | undefined;
    let auto = false;
    if (!focus) {
      const base = baselineBinRates([lot.id], testedLots());
      const total = Object.values(lot.binCounts!).reduce((a, b) => a + b, 0);
      focus = [...FAIL_BINS].sort(
        (a, b) => lot.binCounts![b] / total - base[b] - (lot.binCounts![a] / total - base[a]),
      )[0];
      auto = true;
    }
    const results = lot.wafers.map((w) => classifyWafer(w, focus));
    const tally: Record<string, number> = {};
    for (const r of results) tally[r.kind] = (tally[r.kind] ?? 0) + 1;
    const radial = radialProfile(lot.wafers, focus);
    const patterned = results.filter((r) => r.kind !== "随机" && r.kind !== "无明显模式");
    const dominant = Object.entries(tally)
      .filter(([k]) => k !== "随机" && k !== "无明显模式")
      .sort((a, b) => b[1] - a[1])[0];
    return {
      forModel: {
        lotId: lot.id,
        focusBin: focus,
        focusBinName: BINS[focus].name,
        focusBinAutoSelected: auto,
        patternCounts: tally,
        wafers: results.map((r) => ({
          slot: r.slot,
          yield: +r.yield.toFixed(3),
          pattern: r.kind,
          confidence: r.confidence,
          focusBinRate: +r.focusRate.toFixed(3),
        })),
        radialFailRate: radial.map((p) => ({ r: p.r, rate: +p.rate.toFixed(4) })),
        note: "r 为归一化半径（0 中心，1 边缘）。",
      },
      view: {
        kind: "waferMaps",
        lotId: lot.id,
        focusBin: focus,
        wafers: lot.wafers.map((w, k) => ({
          slot: w.slot,
          waferId: w.id,
          yield: w.yield!,
          kind: results[k].kind,
          confidence: results[k].confidence,
          bins: Array.from(w.bins!).join(""),
        })),
        stacked: stackedMap(lot.wafers, focus).map((v) => +v.toFixed(3)),
        radial,
        tally,
      },
      summary: patterned.length
        ? `${BINS[focus].short}：${patterned.length} 片呈空间模式，主模式「${dominant[0]}」${dominant[1]} 片`
        : `${BINS[focus].short}：未见明显空间模式`,
    };
  },
};

const commonalityTool = {
  name: "commonality_analysis",
  description:
    "设备共性分析：把晶圆按「某失效 Bin 的失效率是否超过阈值」分成坏片 / 好片，对工艺路线上每道工序的设备与腔体做 2×2 卡方检验，找出坏片高度集中的设备腔体。默认使用所有已完成 CP 的批次以获得足够样本。",
  schema: z.object({
    bin: binIdSchema.describe("用于定义坏片的失效 Bin"),
    threshold: z.coerce.number().min(0.005).max(0.5).optional().describe("该 Bin 失效率超过此值视为坏片，默认 0.05"),
    lot_ids: z.array(z.string()).optional().describe("参与分析的批次；默认全部已完成 CP 的批次"),
  }),
  run({ bin, threshold = 0.05, lot_ids }: { bin: number; threshold?: number; lot_ids?: string[] }): ToolOutput {
    const ids = lot_ids?.length ? lot_ids.map((s) => s.toUpperCase()) : testedLots().map((l) => l.id);
    for (const id of ids) requireTestedLot(id);
    const b = bin as BinId;
    const res = commonality(ids, (w) => focusRate(w, b) > threshold);
    if (!res.badWafers) throw new ToolError(`在 ${ids.length} 个批次中没有晶圆的 ${BINS[b].name} 失效率超过 ${pct(threshold)}，请降低阈值。`);
    const rows = res.rows.slice(0, 8);
    const top = rows[0];
    const criterion = `${BINS[b].short}失效率 > ${pct(threshold, 0)}`;
    return {
      forModel: {
        criterion,
        lotsAnalyzed: ids,
        wafers: res.wafers,
        badWafers: res.badWafers,
        ranking: rows.map((r) => ({
          step: `${r.stepId} ${r.stepName}`,
          tool: r.tool,
          chamber: r.chamber,
          wafers: r.wafers,
          badWafers: r.badWafers,
          badRate: +r.badRate.toFixed(3),
          othersBadRate: +r.othersBadRate.toFixed(3),
          chi2: +r.chi2.toFixed(1),
          pValue: Number(r.pValue.toExponential(2)),
        })),
      },
      view: { kind: "commonality", criterion, wafers: res.wafers, bad: res.badWafers, rows },
      summary: `${res.badWafers}/${res.wafers} 片为坏片；最集中：${top.tool} 腔体 ${top.chamber}（${top.badWafers}/${top.wafers}，p = ${sci(top.pValue)}）`,
    };
  },
};

const equipmentLog = {
  name: "query_equipment_log",
  description:
    "查询设备事件日志：PM 保养、复机认证、告警、停机、配方变更，含详细描述。可按腔体和日期范围筛选。用于核实可疑设备腔体在异常开始前后发生了什么。",
  schema: z.object({
    tool_id: z.string().describe("设备号，如 ETCH-07"),
    chamber: z.string().optional().describe("腔体 / 研磨头，如 C 或 H2"),
    start_date: dateSchema.optional(),
    end_date: dateSchema.optional(),
  }),
  run({ tool_id, chamber, start_date, end_date }: { tool_id: string; chamber?: string; start_date?: string; end_date?: string }): ToolOutput {
    const events = queryEvents(tool_id, chamber, start_date, end_date);
    if (!events) throw new ToolError(`设备 ${tool_id} 不存在。`);
    const notable = events.filter((e) => e.severity !== "信息" || e.type !== "告警");
    return {
      forModel: {
        tool: tool_id.toUpperCase(),
        chamber: chamber?.toUpperCase() ?? "全部",
        range: [start_date ?? "不限", end_date ?? "不限"],
        count: events.length,
        events: events.slice(0, 40),
      },
      view: {
        kind: "events",
        tool: tool_id.toUpperCase(),
        chamber: chamber?.toUpperCase() ?? null,
        from: start_date ?? null,
        to: end_date ?? null,
        events,
      },
      summary: `${events.length} 条事件，${notable.filter((e) => e.severity !== "信息").length} 条警告或严重`,
    };
  },
};

const metrology = {
  name: "query_inline_metrology",
  description:
    "查询在线量测数据。参数：SN_BOTTOM_CD（存储节点刻蚀后底部 CD，5 个径向位置）、CMP_DEFECT（存储节点接触 CMP 后缺陷数，总数与划伤类）、TIN_THICKNESS（TiN 顶电极厚度，5 个径向位置）。返回按腔体汇总的各位置均值；给出 split_date 时同时对比该日期前后。",
  schema: z.object({
    parameter: z.enum(["SN_BOTTOM_CD", "CMP_DEFECT", "TIN_THICKNESS"]),
    tool_id: z.string().optional().describe("只看某台设备"),
    start_date: dateSchema.optional(),
    end_date: dateSchema.optional(),
    split_date: dateSchema.optional().describe("对比该日期之前 / 之后（含当天）"),
  }),
  run(input: { parameter: MetrologyParam; tool_id?: string; start_date?: string; end_date?: string; split_date?: string }): ToolOutput {
    const meta = PARAM_META[input.parameter];
    const points = queryMetrology(input.parameter, input.tool_id, input.start_date, input.end_date);
    if (!points.length) throw new ToolError("所选条件下没有量测数据。");
    const mean = (rows: typeof points) =>
      meta.sites.map((_, i) => +(rows.reduce((s, p) => s + p.values[i], 0) / rows.length).toFixed(2));
    const groups = new Map<string, typeof points>();
    for (const p of points) {
      const keys = [`${p.tool}/${p.chamber}`];
      if (input.split_date) keys[0] += p.date >= input.split_date ? `（${input.split_date} 起）` : `（${input.split_date} 前）`;
      groups.set(keys[0], [...(groups.get(keys[0]) ?? []), p]);
    }
    const summaryRows = [...groups].sort((a, b) => a[0].localeCompare(b[0])).map(([group, rows]) => {
      const m = mean(rows);
      const oos = rows.filter((p) => p.values.some((v) => (meta.lsl !== undefined && v < meta.lsl) || (meta.usl !== undefined && v > meta.usl))).length;
      return { group, n: rows.length, mean: Object.fromEntries(meta.sites.map((s, i) => [s, m[i]])), outOfSpecWafers: oos };
    });
    const oosTotal = summaryRows.reduce((s, r) => s + r.outOfSpecWafers, 0);
    return {
      forModel: {
        parameter: input.parameter,
        name: meta.name,
        step: `${meta.step} ${stepName(meta.step)}`,
        unit: meta.unit,
        spec: { lsl: meta.lsl ?? null, usl: meta.usl ?? null },
        sites: meta.sites,
        byGroup: summaryRows,
      },
      view: { kind: "metrology", param: input.parameter, tool: input.tool_id?.toUpperCase() ?? null, splitDate: input.split_date ?? null, points },
      summary: `${points.length} 片量测，${oosTotal} 片有位置超规格`,
    };
  },
};

const knowledge = {
  name: "search_fa_knowledge",
  description: "检索历史失效分析（FA）与 8D 案例库，按关键词、空间模式和 Bin 匹配，返回根因与纠正措施。",
  schema: z.object({
    query: z.string().describe("关键词，空格分隔，如「刻蚀 聚焦环 边缘 数据保持」"),
    pattern: z.string().optional().describe("空间模式，如 边缘环 / 划伤 / 中心团簇"),
    bin: binIdSchema.optional(),
  }),
  run({ query, pattern, bin }: { query: string; pattern?: string; bin?: number }): ToolOutput {
    const cases = searchCases(query, pattern, bin);
    return {
      forModel: { query, matches: cases },
      view: { kind: "cases", query, cases },
      summary: cases.length ? `${cases.length} 个相似案例，最相关 ${cases[0].id}（${pct(cases[0].relevance, 0)}）` : "没有找到相似案例",
    };
  },
};

const exposure = {
  name: "find_exposed_lots",
  description:
    "风险评估：找出在某日期之后经过指定设备腔体的所有批次与晶圆，包括已测批次（给出受影响晶圆良率）和仍在制的批次（给出当前工序），用于制定围堵（containment）范围。",
  schema: z.object({
    tool_id: z.string(),
    chamber: z.string(),
    since: dateSchema.describe("起始日期（含）"),
    until: dateSchema.optional().describe("截止日期（含），问题已修复时填写修复日期"),
  }),
  run({ tool_id, chamber, since, until }: { tool_id: string; chamber: string; since: string; until?: string }): ToolOutput {
    const t = tool_id.toUpperCase();
    const ch = chamber.toUpperCase();
    const found = findTool(t);
    if (!found) throw new ToolError(`设备 ${tool_id} 不存在。`);
    if (!found.tool.chambers.includes(ch)) throw new ToolError(`${t} 没有腔体 ${ch}，可选：${found.tool.chambers.join("、")}`);
    const stepId = found.step.id;
    const lots = allLots()
      .map((lot) => {
        const hit = lot.wafers.filter((w) => {
          const r = w.route[stepId];
          return r && r.tool === t && r.chamber === ch && r.date >= since && (!until || r.date <= until);
        });
        if (!hit.length) return null;
        const ys = hit.filter((w) => w.yield !== null).map((w) => w.yield!);
        return {
          lotId: lot.id,
          status: lot.status,
          currentStep: stepName(lot.currentStep),
          date: hit[0].route[stepId].date,
          slots: hit.map((w) => w.slot),
          affectedYield: ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : null,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    const wip = lots.filter((l) => l.status === "在制");
    return {
      forModel: {
        tool: t,
        chamber: ch,
        step: `${stepId} ${found.step.name}`,
        since,
        until: until ?? null,
        lots: lots.map((l) => ({ ...l, affectedYield: l.affectedYield === null ? null : +l.affectedYield.toFixed(3) })),
        totals: { lots: lots.length, wafers: lots.reduce((s, l) => s + l.slots.length, 0), wipLots: wip.length, wipWafers: wip.reduce((s, l) => s + l.slots.length, 0) },
      },
      view: { kind: "exposure", tool: t, chamber: ch, since, lots },
      summary: `${lots.length} 个批次 ${lots.reduce((s, l) => s + l.slots.length, 0)} 片受影响，其中在制 ${wip.length} 批`,
    };
  },
};

const report = {
  name: "publish_8d_report",
  description:
    "在调查结束时发布 8D 报告草稿（D2 问题描述、D3 围堵、D4 根因与证据、D5 纠正措施、D7 预防措施）。只在证据链完整后调用一次。",
  schema: z.object({
    title: z.string(),
    severity: z.enum(["高", "中", "低"]),
    lot_ids: z.array(z.string()).describe("涉及批次"),
    d2_problem: z.string(),
    d3_containment: z.array(z.string()),
    d4_root_cause: z.string(),
    evidence: z.array(z.string()).describe("支撑根因的证据，每条注明来源数据"),
    d5_corrective: z.array(z.string()),
    d7_preventive: z.array(z.string()),
    confidence: z.coerce.number().min(0).max(1).describe("对根因结论的置信度 0~1"),
  }),
  run(i: {
    title: string;
    severity: "高" | "中" | "低";
    lot_ids: string[];
    d2_problem: string;
    d3_containment: string[];
    d4_root_cause: string;
    evidence: string[];
    d5_corrective: string[];
    d7_preventive: string[];
    confidence: number;
  }): ToolOutput {
    const r: Report8D = {
      id: `8D-${TODAY.replaceAll("-", "")}-${String(Math.abs(i.title.length * 37) % 90 + 10)}`,
      title: i.title,
      severity: i.severity,
      lotIds: i.lot_ids,
      createdAt: TODAY,
      d2Problem: i.d2_problem,
      d3Containment: i.d3_containment,
      d4RootCause: i.d4_root_cause,
      evidence: i.evidence,
      d5Corrective: i.d5_corrective,
      d7Preventive: i.d7_preventive,
      confidence: i.confidence,
    };
    return {
      forModel: { published: true, reportId: r.id },
      view: { kind: "report", report: r },
      summary: `已生成 ${r.id}`,
    };
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TOOLS: { name: string; description: string; schema: z.ZodObject<any>; run: (input: any) => ToolOutput }[] = [
  listLots,
  lotSummary,
  waferMaps,
  commonalityTool,
  equipmentLog,
  metrology,
  knowledge,
  exposure,
  report,
];

export { TOOL_LABELS } from "./labels";

// 给 Claude 的工具定义（JSON Schema 由 zod 生成）
export function toolDefinitions() {
  return TOOLS.map((t) => {
    const schema = z.toJSONSchema(t.schema, { io: "input" }) as Record<string, unknown>;
    delete schema.$schema;
    return {
      name: t.name,
      description: t.description,
      input_schema: schema as { type: "object"; [k: string]: unknown },
      eager_input_streaming: true,
    };
  });
}

export type ToolRun =
  | { ok: true; output: ToolOutput }
  | { ok: false; code: "INVALID_INPUT" | "UNKNOWN_TOOL" | "TOOL_ERROR"; message: string };

export function runTool(name: string, input: unknown): ToolRun {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { ok: false, code: "UNKNOWN_TOOL", message: `未知工具 ${name}` };
  const parsed = tool.schema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: `参数校验失败：${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("；")}`,
    };
  }
  try {
    return { ok: true, output: tool.run(parsed.data) };
  } catch (err) {
    if (err instanceof ToolError) return { ok: false, code: "TOOL_ERROR", message: err.message };
    throw err;
  }
}
