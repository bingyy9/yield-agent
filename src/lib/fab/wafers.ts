import {
  BINS,
  BinId,
  CP_OFFSET_DAYS,
  DIES_PER_WAFER,
  DIE_W,
  HIDDEN_RULES,
  LOT_DEFS,
  LotDef,
  PRODUCT,
  ROUTE,
  SITES,
  TODAY,
  WAFERS_PER_LOT,
  WAFER_RADIUS,
  addDays,
  gauss,
  rng,
} from "./core";

export interface StepRecord {
  tool: string;
  chamber: string;
  date: string;
}

export interface Wafer {
  id: string; // N3B417.07
  lotId: string;
  slot: number;
  route: Record<string, StepRecord>; // 仅含已完成的工序
  bins: Uint8Array | null; // 未 CP 时为 null
  yield: number | null;
}

export interface Lot {
  id: string;
  product: string;
  start: string;
  cpDate: string | null;
  status: "CP 完成" | "在制";
  currentStep: string; // 最近完成的工序
  wafers: Wafer[];
  yield: number | null;
  binCounts: Record<BinId, number> | null;
}

function smoothstep(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function inWindow(date: string, from: string, to?: string) {
  return date >= from && (!to || date <= to);
}

const BASE_SPLIT: [BinId, number][] = [
  [3, 0.14],
  [4, 0.16],
  [5, 0.18],
  [6, 0.27],
  [7, 0.13],
  [8, 0.12],
];

function pickWeighted(r: number, weights: [BinId, number][]): BinId {
  const total = weights.reduce((s, [, w]) => s + w, 0);
  let acc = 0;
  for (const [b, w] of weights) {
    acc += w / total;
    if (r <= acc) return b;
  }
  return weights[weights.length - 1][0];
}

function generateBins(w: Omit<Wafer, "bins" | "yield">): Uint8Array {
  const rand = rng(`bins:${w.id}`);
  const q = Math.exp(0.22 * gauss(rand));
  const etch = w.route["5100"];
  const cmp = w.route["4200"];
  const dep = w.route["5400"];
  const R = HIDDEN_RULES;

  const edgeHit =
    etch && etch.tool === R.etchEdge.tool && etch.chamber === R.etchEdge.chamber && inWindow(etch.date, R.etchEdge.from);
  const scratchHit =
    cmp && cmp.tool === R.cmpScratch.tool && cmp.chamber === R.cmpScratch.chamber && inWindow(cmp.date, R.cmpScratch.from, R.cmpScratch.to);
  const centerHit =
    dep && dep.tool === R.depCenter.tool && dep.chamber === R.depCenter.chamber && inWindow(dep.date, R.depCenter.from, R.depCenter.to);

  // 划伤：每片 2~3 条大曲率弧线
  const arcs: { cx: number; cy: number; rad: number; a0: number; a1: number }[] = [];
  if (scratchHit) {
    // CMP 划伤通常是同心的几条弧：共享同一个旋转中心，半径错开
    const n = 3 + Math.floor(rand() * 2);
    const ang = rand() * Math.PI * 2;
    const dist = 200 + rand() * 80;
    const cx = Math.cos(ang) * dist;
    const cy = Math.sin(ang) * dist;
    let rad = dist - 110 + rand() * 30;
    for (let k = 0; k < n; k++) {
      const mid = ang + Math.PI + (rand() - 0.5) * 0.2;
      const span = 0.28 + rand() * 0.22;
      arcs.push({ cx, cy, rad, a0: mid - span, a1: mid + span });
      rad += 32 + rand() * 30;
    }
  }
  const edgeStrength = edgeHit ? 0.84 + 0.1 * rand() : 0;
  const edgePhase = rand() * Math.PI * 2;
  const centerStrength = centerHit ? 0.72 + 0.12 * rand() : 0;

  const out = new Uint8Array(DIES_PER_WAFER);
  for (let k = 0; k < SITES.length; k++) {
    const s = SITES[k];
    const weights: [BinId, number][] = [];
    const p0 = 0.072 * q * (1 + 1.6 * smoothstep(0.82, 1.0, s.r));
    for (const [b, f] of BASE_SPLIT) weights.push([b, p0 * f]);

    if (edgeStrength) {
      const ring = smoothstep(0.74, 0.87, s.r) * (0.86 + 0.14 * Math.cos(s.theta - edgePhase));
      weights.push([7, edgeStrength * ring]);
      weights.push([6, 0.05 * ring]);
    }
    if (arcs.length) {
      for (const a of arcs) {
        const d = Math.hypot(s.x - a.cx, s.y - a.cy);
        let ang = Math.atan2(s.y - a.cy, s.x - a.cx);
        while (ang < a.a0 - Math.PI) ang += 2 * Math.PI;
        while (ang > a.a0 + Math.PI) ang -= 2 * Math.PI;
        if (Math.abs(d - a.rad) < DIE_W * 0.55 && ang >= a.a0 && ang <= a.a1) {
          weights.push([6, 0.72]);
          weights.push([3, 0.18]);
        }
      }
    }
    if (centerStrength) {
      weights.push([4, centerStrength * (1 - smoothstep(0.26, 0.46, s.r))]);
    }

    const pFail = Math.min(0.97, weights.reduce((t, [, p]) => t + p, 0));
    const u = rand();
    if (u < pFail) {
      out[k] = pickWeighted(rand(), weights);
    } else {
      out[k] = rand() < 0.14 ? 2 : 1;
    }
  }
  return out;
}

function chooseTool(def: LotDef, stepIdx: number, rand: () => number) {
  const step = ROUTE[stepIdx];
  const ov = def.overrides?.[step.id];
  const tool = ov ? step.tools.find((t) => t.id === ov.tool)! : step.tools[Math.floor(rand() * step.tools.length)];
  return { tool, chambers: ov?.chambers ?? tool.chambers };
}

function materialize(def: LotDef): Lot {
  const rand = rng(`route:${def.id}`);
  const routePlan = ROUTE.map((step, idx) => {
    const { tool, chambers } = chooseTool(def, idx, rand);
    const rot = Math.floor(rand() * chambers.length);
    return { step, tool, chambers, rot, date: addDays(def.start, step.offsetDays) };
  });
  const cpDateCandidate = addDays(def.start, CP_OFFSET_DAYS);
  const cpDone = cpDateCandidate <= TODAY;
  const done = routePlan.filter((p) => p.date <= TODAY);
  const currentStep = done.length ? done[done.length - 1].step.id : "投片";

  const wafers: Wafer[] = [];
  for (let slot = 1; slot <= WAFERS_PER_LOT; slot++) {
    const route: Record<string, StepRecord> = {};
    for (const p of done) {
      route[p.step.id] = {
        tool: p.tool.id,
        chamber: p.chambers[(slot - 1 + p.rot) % p.chambers.length],
        date: p.date,
      };
    }
    const base = { id: `${def.id}.${String(slot).padStart(2, "0")}`, lotId: def.id, slot, route };
    const bins = cpDone ? generateBins(base) : null;
    const y = bins ? bins.reduce((t, b) => t + (BINS[b as BinId].pass ? 1 : 0), 0) / bins.length : null;
    wafers.push({ ...base, bins, yield: y });
  }

  let binCounts: Record<BinId, number> | null = null;
  let lotYield: number | null = null;
  if (cpDone) {
    binCounts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0 };
    for (const w of wafers) for (const b of w.bins!) binCounts[b as BinId]++;
    lotYield = (binCounts[1] + binCounts[2]) / (wafers.length * DIES_PER_WAFER);
  }

  return {
    id: def.id,
    product: PRODUCT,
    start: def.start,
    cpDate: cpDone ? cpDateCandidate : null,
    status: cpDone ? "CP 完成" : "在制",
    currentStep,
    wafers,
    yield: lotYield,
    binCounts,
  };
}

const cache = new Map<string, Lot>();

export function getLot(id: string): Lot | null {
  const key = id.trim().toUpperCase();
  const hit = cache.get(key);
  if (hit) return hit;
  const def = LOT_DEFS.find((d) => d.id === key);
  if (!def) return null;
  const lot = materialize(def);
  cache.set(key, lot);
  return lot;
}

export function allLots(): Lot[] {
  return LOT_DEFS.map((d) => getLot(d.id)!);
}

export function testedLots(): Lot[] {
  return allLots().filter((l) => l.cpDate);
}

export function getWafer(waferId: string): Wafer | null {
  const [lotId] = waferId.split(".");
  const lot = getLot(lotId);
  return lot?.wafers.find((w) => w.id === waferId.toUpperCase()) ?? null;
}

export { WAFER_RADIUS };
