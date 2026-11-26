import { HIDDEN_RULES, gauss, rng } from "./core";
import { allLots } from "./wafers";

export type MetrologyParam = "SN_BOTTOM_CD" | "CMP_DEFECT" | "TIN_THICKNESS";

export const PARAM_META: Record<MetrologyParam, { name: string; step: string; unit: string; lsl?: number; usl?: number; sites: string[] }> = {
  SN_BOTTOM_CD: { name: "存储节点底部 CD", step: "5100", unit: "nm", lsl: 35.0, usl: 41.0, sites: ["中心", "r=0.35", "r=0.60", "r=0.80", "r=0.93"] },
  CMP_DEFECT: { name: "CMP 后缺陷数（Surfscan）", step: "4200", unit: "个/片", usl: 60, sites: ["总缺陷", "划伤类"] },
  TIN_THICKNESS: { name: "TiN 顶电极厚度", step: "5400", unit: "Å", lsl: 92, usl: 108, sites: ["中心", "r=0.35", "r=0.60", "r=0.80", "r=0.93"] },
};

export interface MetrologyPoint {
  lotId: string;
  waferId: string;
  tool: string;
  chamber: string;
  date: string;
  values: number[]; // 与 sites 对应
}

function measure(param: MetrologyParam): MetrologyPoint[] {
  const meta = PARAM_META[param];
  const out: MetrologyPoint[] = [];
  for (const lot of allLots()) {
    // 每个腔体抽测 2 片
    const byCh = new Map<string, typeof lot.wafers>();
    for (const w of lot.wafers) {
      const rec = w.route[meta.step];
      if (!rec) continue;
      byCh.set(rec.chamber, [...(byCh.get(rec.chamber) ?? []), w]);
    }
    for (const [, ws] of byCh) {
      for (const w of ws.slice(0, 2)) {
        const rec = w.route[meta.step];
        const r = rng(`metro:${param}:${w.id}`);
        let values: number[];
        if (param === "SN_BOTTOM_CD") {
          const base = [38.2, 38.1, 37.9, 37.6, 37.1];
          const H = HIDDEN_RULES.etchEdge;
          const hit = rec.tool === H.tool && rec.chamber === H.chamber && rec.date >= H.from;
          const shift = hit ? [0, -0.05, -0.25, -1.5, -3.9] : [0, 0, 0, 0, 0];
          values = base.map((b, i) => +(b + shift[i] + gauss(r) * 0.28).toFixed(2));
        } else if (param === "CMP_DEFECT") {
          const H = HIDDEN_RULES.cmpScratch;
          const hit = rec.tool === H.tool && rec.chamber === H.chamber && rec.date >= H.from && rec.date <= H.to!;
          const total = hit ? 150 + Math.round(r() * 90) : 18 + Math.round(r() * 22);
          const scratch = hit ? Math.round(total * (0.55 + r() * 0.2)) : Math.round(total * r() * 0.08);
          values = [total, scratch];
        } else {
          const base = [100.4, 100.2, 100.0, 99.6, 99.0];
          const H = HIDDEN_RULES.depCenter;
          const hit = rec.tool === H.tool && rec.chamber === H.chamber && rec.date >= H.from && rec.date <= H.to!;
          const shift = hit ? [-9.2, -6.0, -1.2, 0, 0] : [0, 0, 0, 0, 0];
          values = base.map((b, i) => +(b + shift[i] + gauss(r) * 0.7).toFixed(1));
        }
        out.push({ lotId: lot.id, waferId: w.id, tool: rec.tool, chamber: rec.chamber, date: rec.date, values });
      }
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

const cache = new Map<MetrologyParam, MetrologyPoint[]>();

export function queryMetrology(param: MetrologyParam, tool?: string, from?: string, to?: string) {
  if (!cache.has(param)) cache.set(param, measure(param));
  return cache
    .get(param)!
    .filter((p) => (!tool || p.tool === tool.toUpperCase()) && (!from || p.date >= from) && (!to || p.date <= to));
}
