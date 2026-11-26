// 分析算法：空间模式分类、叠加图、径向分布、共性分析。都是对数据的真实计算，不读取隐藏规则。
import { BINS, BinId, COLS, FAIL_BINS, ROUTE, ROWS, SITES } from "./core";
import { Lot, Wafer, getLot } from "./wafers";

export type PatternKind = "边缘环" | "边缘局部" | "中心团簇" | "划伤" | "局部团簇" | "随机" | "无明显模式";

export interface PatternResult {
  waferId: string;
  slot: number;
  yield: number;
  kind: PatternKind;
  confidence: number;
  focusRate: number; // 关注 Bin 的失效率
  features: { center: number; mid: number; edge: number; octantsHit: number; cluster: number; elongation: number };
}

function isFail(b: number, focus?: BinId) {
  return focus ? b === focus : !BINS[b as BinId].pass;
}

const ZONE = (r: number) => (r < 0.4 ? "center" : r < 0.78 ? "mid" : "edge");
const zoneSize = { center: 0, mid: 0, edge: 0 };
for (const s of SITES) zoneSize[ZONE(s.r)]++;

const indexByCell = new Map<number, number>();
SITES.forEach((s, k) => indexByCell.set(s.j * COLS + s.i, k));

function clusters(fails: boolean[]) {
  const seen = new Uint8Array(fails.length);
  const all: number[][] = [];
  for (let k = 0; k < fails.length; k++) {
    if (!fails[k] || seen[k]) continue;
    const comp: number[] = [];
    const stack = [k];
    seen[k] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      comp.push(c);
      const { i, j } = SITES[c];
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const n = indexByCell.get((j + dj) * COLS + (i + di));
          if (n !== undefined && fails[n] && !seen[n]) {
            seen[n] = 1;
            stack.push(n);
          }
        }
    }
    all.push(comp);
  }
  return all.sort((a, b) => b.length - a.length);
}

// 主成分长短轴比
function shape(best: number[]) {
  if (best.length < 3) return { size: best.length, elongation: 1, meanR: 0 };
  const xs = best.map((k) => SITES[k].x);
  const ys = best.map((k) => SITES[k].y);
  const mx = xs.reduce((a, b) => a + b) / xs.length;
  const my = ys.reduce((a, b) => a + b) / ys.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (let t = 0; t < xs.length; t++) {
    sxx += (xs[t] - mx) ** 2;
    syy += (ys[t] - my) ** 2;
    sxy += (xs[t] - mx) * (ys[t] - my);
  }
  const tr = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const l1 = tr / 2 + Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l2 = tr / 2 - Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const meanR = best.reduce((a, k) => a + SITES[k].r, 0) / best.length;
  return { size: best.length, elongation: Math.sqrt(l1 / Math.max(l2, 1e-6)), meanR };
}

export function classifyWafer(w: Wafer, focus?: BinId): PatternResult {
  const bins = w.bins!;
  const fails = Array.from(bins, (b) => isFail(b, focus));
  const cnt = { center: 0, mid: 0, edge: 0 };
  const oct = new Array(8).fill(0);
  const octTotal = new Array(8).fill(0);
  SITES.forEach((s, k) => {
    const z = ZONE(s.r);
    if (z === "edge") octTotal[Math.floor(((s.theta + Math.PI) / (2 * Math.PI)) * 8) % 8]++;
    if (!fails[k]) return;
    cnt[z]++;
    if (z === "edge") oct[Math.floor(((s.theta + Math.PI) / (2 * Math.PI)) * 8) % 8]++;
  });
  const total = fails.filter(Boolean).length;
  const rate = total / SITES.length;
  const center = cnt.center / zoneSize.center;
  const mid = cnt.mid / zoneSize.mid;
  const edge = cnt.edge / zoneSize.edge;
  const octantsHit = oct.filter((c, idx) => c / octTotal[idx] > Math.max(0.18, rate * 1.8)).length;
  const comps = clusters(fails);
  const cl = shape(comps[0] ?? []);
  const linear = comps.filter((c) => c.length >= 6).map(shape).filter((x) => x.elongation > 3.2);
  const longest = linear.sort((a, b) => b.size - a.size)[0];

  let kind: PatternKind = "随机";
  let confidence = 0.6;
  const inner = Math.max(mid, 0.01);
  if (rate < (focus ? 0.012 : 0.05)) {
    kind = "无明显模式";
    confidence = 0.8;
  } else if (edge / inner > 3 && edge > 0.22 && octantsHit >= 6) {
    kind = "边缘环";
    confidence = Math.min(0.97, 0.7 + (octantsHit - 5) * 0.06 + Math.min(0.1, edge / inner / 60));
  } else if (edge / inner > 2.5 && edge > 0.15) {
    kind = "边缘局部";
    confidence = 0.72;
  } else if (longest && longest.size >= 7) {
    kind = "划伤";
    confidence = Math.min(0.93, 0.6 + linear.length * 0.08 + longest.elongation / 40);
  } else if (center / Math.max(mid, 0.01) > 3 && center > 0.2) {
    kind = "中心团簇";
    confidence = Math.min(0.95, 0.72 + center / 3);
  } else if (cl.size >= 10) {
    kind = "局部团簇";
    confidence = 0.66;
  }
  return {
    waferId: w.id,
    slot: w.slot,
    yield: w.yield!,
    kind,
    confidence: Math.round(confidence * 100) / 100,
    focusRate: rate,
    features: {
      center: +center.toFixed(3),
      mid: +mid.toFixed(3),
      edge: +edge.toFixed(3),
      octantsHit,
      cluster: cl.size,
      elongation: +(longest ?? cl).elongation.toFixed(1),
    },
  };
}

// 叠加图：每个 die 位置在一组晶圆上的失效频率
export function stackedMap(wafers: Wafer[], focus?: BinId): number[] {
  const acc = new Array(SITES.length).fill(0);
  const tested = wafers.filter((w) => w.bins);
  for (const w of tested) w.bins!.forEach((b, k) => (acc[k] += isFail(b, focus) ? 1 : 0));
  return acc.map((v) => (tested.length ? v / tested.length : 0));
}

// 径向分布：10 个半径分段的失效率
export function radialProfile(wafers: Wafer[], focus?: BinId) {
  const N = 10;
  const fail = new Array(N).fill(0);
  const tot = new Array(N).fill(0);
  for (const w of wafers) {
    if (!w.bins) continue;
    SITES.forEach((s, k) => {
      const b = Math.min(N - 1, Math.floor(s.r * N));
      tot[b]++;
      if (isFail(w.bins![k], focus)) fail[b]++;
    });
  }
  return fail.map((f, i) => ({ r: (i + 0.5) / N, rate: tot[i] ? f / tot[i] : 0 }));
}

export function binPareto(lot: Lot) {
  const counts = lot.binCounts!;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return FAIL_BINS.map((b) => ({ bin: b, count: counts[b], rate: counts[b] / total }))
    .sort((a, b) => b.count - a.count);
}

// 基线：近期所有已测批次（排除自身）的 Bin 失效率中位数
export function baselineBinRates(exclude: string[], lots: Lot[]) {
  const pool = lots.filter((l) => l.binCounts && !exclude.includes(l.id));
  const out = {} as Record<BinId, number>;
  for (const b of FAIL_BINS) {
    const rates = pool
      .map((l) => l.binCounts![b] / Object.values(l.binCounts!).reduce((x, y) => x + y, 0))
      .sort((x, y) => x - y);
    out[b] = rates.length ? rates[Math.floor(rates.length / 2)] : 0;
  }
  return out;
}

// ---------- 共性分析 ----------

export interface CommonalityRow {
  stepId: string;
  stepName: string;
  tool: string;
  chamber: string;
  wafers: number;
  badWafers: number;
  badRate: number;
  meanYield: number;
  othersBadRate: number;
  chi2: number;
  pValue: number;
}

function erfc(x: number) {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r =
    t *
    Math.exp(
      -z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? r : 2 - r;
}

export function commonality(lotIds: string[], isBad: (w: Wafer) => boolean) {
  const wafers = lotIds.flatMap((id) => getLot(id)?.wafers ?? []).filter((w) => w.bins);
  const totalBad = wafers.filter(isBad).length;
  const rows: CommonalityRow[] = [];
  for (const step of ROUTE) {
    const groups = new Map<string, Wafer[]>();
    for (const w of wafers) {
      const rec = w.route[step.id];
      if (!rec) continue;
      const key = `${rec.tool}|${rec.chamber}`;
      groups.set(key, [...(groups.get(key) ?? []), w]);
    }
    for (const [key, ws] of groups) {
      const [tool, chamber] = key.split("|");
      const bad = ws.filter(isBad).length;
      const others = wafers.length - ws.length;
      const othersBad = totalBad - bad;
      // 2x2 列联表卡方检验
      const a = bad, b = ws.length - bad, c = othersBad, d = others - othersBad;
      const n = a + b + c + d;
      const denom = (a + b) * (c + d) * (a + c) * (b + d);
      const chi2 = denom ? (n * (a * d - b * c) ** 2) / denom : 0;
      const pValue = erfc(Math.sqrt(chi2 / 2));
      rows.push({
        stepId: step.id,
        stepName: step.name,
        tool,
        chamber,
        wafers: ws.length,
        badWafers: bad,
        badRate: bad / ws.length,
        meanYield: ws.reduce((s, w) => s + w.yield!, 0) / ws.length,
        othersBadRate: others ? othersBad / others : 0,
        chi2,
        pValue,
      });
    }
  }
  // 只有“集中”才算可疑：坏片率高于其他组
  rows.sort((x, y) => {
    const sx = x.badRate > x.othersBadRate ? x.chi2 : -1;
    const sy = y.badRate > y.othersBadRate ? y.chi2 : -1;
    return sy - sx;
  });
  return { wafers: wafers.length, badWafers: totalBad, rows };
}

export const GRID = { COLS, ROWS };
