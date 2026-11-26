"use client";
import { memo, useId, useMemo, useRef, useState } from "react";
import { BINS, COLS, DIE_H, DIE_W, ROWS, SITES, WAFER_RADIUS, type BinId } from "@/lib/fab/core";
import { pct } from "./format";

const R = WAFER_RADIUS;
const GAP = 0.7;

// 单色红色顺序色阶（失效密度），从近白到深红
const RAMP = ["#f1f3f4", "#f8d5cf", "#ef9f92", "#dd5e4c", "#b5301f", "#74170d"];

export function rampColor(t: number) {
  const x = Math.min(1, Math.max(0, t)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(x));
  return mix(RAMP[i], RAMP[i + 1], x - i);
}

function mix(a: string, b: string, t: number) {
  const pa = [1, 3, 5].map((k) => parseInt(a.slice(k, k + 2), 16));
  const pb = [1, 3, 5].map((k) => parseInt(b.slice(k, k + 2), 16));
  return "#" + pa.map((v, k) => Math.round(v + (pb[k] - v) * t).toString(16).padStart(2, "0")).join("");
}

export const RAMP_GRADIENT = `linear-gradient(90deg, ${RAMP.join(", ")})`;

// 聚焦模式下的非焦点颜色
const DIM_PASS = "#e4e9eb";
const DIM_FAIL = "#bdc7cd";

const GRID_INDEX = (() => {
  const m = new Int16Array(COLS * ROWS).fill(-1);
  SITES.forEach((s, k) => (m[s.j * COLS + s.i] = k));
  return m;
})();

export function dieColor(bin: number, focus: BinId | null) {
  const def = BINS[bin as BinId];
  if (!def) return DIM_PASS;
  if (focus == null) return def.color;
  if (bin === focus) return def.color;
  return def.pass ? DIM_PASS : DIM_FAIL;
}

export function densityMax(values: number[]) {
  const m = Math.max(...values, 0.05);
  return Math.ceil(m * 10) / 10;
}

type Source = { kind: "bins"; bins: string; focus: BinId | null } | { kind: "density"; values: number[]; max: number };

interface Props {
  source: Source;
  scanning?: boolean;
  label: string;
  className?: string;
}

function colorsFor(source: Source) {
  if (source.kind === "bins") return SITES.map((_, k) => dieColor(Number(source.bins[k]), source.focus));
  return source.values.map((v) => rampColor(v / source.max));
}

function Notch({ bg }: { bg: string }) {
  return <path d={`M -5 ${R + 1} L 0 ${R - 6} L 5 ${R + 1} Z`} fill={bg} />;
}

// 主舞台晶圆图：SVG 逐 die 绘制，事件委托做悬停提示
export function WaferMap({ source, scanning, label, className }: Props) {
  const uid = useId().replace(/:/g, "");
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<{ k: number; px: number; py: number } | null>(null);
  const colors = useMemo(() => colorsFor(source), [source]);

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    const i = Math.floor(p.x / DIE_W + COLS / 2);
    const j = Math.floor(p.y / DIE_H + ROWS / 2);
    const k = i >= 0 && i < COLS && j >= 0 && j < ROWS ? GRID_INDEX[j * COLS + i] : -1;
    if (k < 0) return setHover(null);
    const box = svg.getBoundingClientRect();
    setHover({ k, px: e.clientX - box.left, py: e.clientY - box.top });
  }

  const site = hover ? SITES[hover.k] : null;
  let tip: React.ReactNode = null;
  if (site && hover) {
    const where = `第 ${site.i + 1} 列 第 ${site.j + 1} 行，r = ${site.r.toFixed(2)}`;
    if (source.kind === "bins") {
      const b = BINS[Number(source.bins[hover.k]) as BinId];
      tip = (
        <>
          <div className="font-medium">{b?.name ?? "未测"}</div>
          <div className="text-white/70">{where}</div>
        </>
      );
    } else {
      tip = (
        <>
          <div className="font-medium">该位置失效率 {pct(source.values[hover.k], 0)}</div>
          <div className="text-white/70">{where}</div>
        </>
      );
    }
  }

  return (
    <div className={`relative ${className ?? ""}`}>
      <svg
        ref={svgRef}
        viewBox={`${-R - 4} ${-R - 4} ${2 * R + 8} ${2 * R + 8}`}
        className="block h-full w-full"
        role="img"
        aria-label={label}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <clipPath id={`clip-${uid}`}>
            <circle r={R} />
          </clipPath>
          <linearGradient id={`sweep-${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#f2a900" stopOpacity="0" />
            <stop offset="0.82" stopColor="#f2a900" stopOpacity="0.38" />
            <stop offset="1" stopColor="#f2a900" stopOpacity="0.9" />
          </linearGradient>
        </defs>
        <circle r={R} fill="#fbfcfc" stroke="#c3ccd2" strokeWidth={1} />
        <g>
          {SITES.map((s, k) => (
            <rect
              key={k}
              x={s.x - DIE_W / 2 + GAP / 2}
              y={-s.y - DIE_H / 2 + GAP / 2}
              width={DIE_W - GAP}
              height={DIE_H - GAP}
              rx={0.8}
              fill={colors[k]}
            />
          ))}
        </g>
        {site && (
          <rect
            x={site.x - DIE_W / 2 - 0.4}
            y={-site.y - DIE_H / 2 - 0.4}
            width={DIE_W + 0.8}
            height={DIE_H + 0.8}
            rx={1.2}
            fill="none"
            stroke="#1b2430"
            strokeWidth={1.4}
            pointerEvents="none"
          />
        )}
        {scanning && (
          <g clipPath={`url(#clip-${uid})`} pointerEvents="none">
            <g className="wafer-sweep">
              <rect x={-R} y={-R - 60} width={2 * R} height={56} fill={`url(#sweep-${uid})`} />
              <rect x={-R} y={-R - 5} width={2 * R} height={1.6} fill="#f2a900" />
            </g>
          </g>
        )}
        <Notch bg="#f4f6f7" />
      </svg>
      {tip && hover && (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-30 whitespace-nowrap rounded-md bg-ink px-2.5 py-1.5 text-xs leading-relaxed text-white shadow-lg num"
          style={{ left: hover.px, top: hover.py, transform: "translate(-50%, calc(-100% - 14px))" }}
        >
          {tip}
        </div>
      )}
    </div>
  );
}

// 缩略晶圆：无交互，用于批次看板与图谱画廊
export const MiniWafer = memo(function MiniWafer({
  source,
  bg = "#f4f6f7",
  className,
}: {
  source: Source | null;
  bg?: string;
  className?: string;
}) {
  const colors = useMemo(() => (source ? colorsFor(source) : null), [source]);
  return (
    <svg viewBox={`${-R - 3} ${-R - 3} ${2 * R + 6} ${2 * R + 6}`} className={`block ${className ?? ""}`} aria-hidden>
      <circle r={R} fill={colors ? "#fbfcfc" : "none"} stroke={colors ? "#c9d1d6" : "#aab5bd"} strokeWidth={colors ? 3 : 4} strokeDasharray={colors ? undefined : "10 9"} />
      {colors &&
        SITES.map((s, k) => (
          <rect key={k} x={s.x - DIE_W / 2 + 0.6} y={-s.y - DIE_H / 2 + 0.6} width={DIE_W - 1.2} height={DIE_H - 1.2} fill={colors[k]} />
        ))}
      <path d={`M -9 ${R + 4} L 0 ${R - 9} L 9 ${R + 4} Z`} fill={bg} />
    </svg>
  );
});

// 由 bins 字符串统计各 Bin 数量
export function countBins(bins: string) {
  const c: Record<number, number> = {};
  for (const ch of bins) c[Number(ch)] = (c[Number(ch)] ?? 0) + 1;
  return c;
}
