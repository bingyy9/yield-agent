"use client";
import { useState, type ReactNode } from "react";
import { BINS, type BinId } from "@/lib/fab/core";
import type { CommonalityRow } from "@/lib/fab/analysis";
import type { EquipEvent } from "@/lib/fab/equipment";
import { PARAM_META, type MetrologyParam, type MetrologyPoint } from "@/lib/fab/metrology";
import { dayNum, fromDayNum, mdShort, pct, sci } from "./format";
import { tipProps, useTip } from "./tooltip";

// ---------- 通用外框：标题 + 图例 + 图表 / 表格切换 ----------

export function Figure({
  title,
  note,
  legend,
  table,
  children,
}: {
  title: string;
  note?: ReactNode;
  legend?: ReactNode;
  table?: ReactNode;
  children: ReactNode;
}) {
  const [asTable, setAsTable] = useState(false);
  return (
    <figure className="min-w-0">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <figcaption className="text-[13px] font-semibold text-ink">{title}</figcaption>
        {table && (
          <button
            type="button"
            onClick={() => setAsTable((v) => !v)}
            className="text-xs text-ink-2 underline decoration-line underline-offset-4 hover:text-ink"
          >
            {asTable ? "看图表" : "看数据表"}
          </button>
        )}
      </div>
      {note && <p className="-mt-1 mb-2 text-xs text-muted">{note}</p>}
      {legend && !asTable && <div className="mb-2.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">{legend}</div>}
      {asTable ? <div className="max-h-72 overflow-auto scroll-thin">{table}</div> : children}
    </figure>
  );
}

export function Swatch({ color, shape = "square" }: { color: string; shape?: "square" | "line" | "tick" | "circle" }) {
  if (shape === "line") return <span className="inline-block h-0.5 w-4 rounded-full align-middle" style={{ background: color }} />;
  if (shape === "tick") return <span className="inline-block h-3 w-0.5 rounded-full align-middle" style={{ background: color }} />;
  return (
    <span
      className={`inline-block size-2.5 align-[-1px] ${shape === "circle" ? "rounded-full" : "rounded-[3px]"}`}
      style={{ background: color }}
    />
  );
}

export function DataTable({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <table className="w-full text-left text-xs num">
      <thead className="sticky top-0 bg-panel text-muted">
        <tr>
          {head.map((h) => (
            <th key={h} className="py-1.5 pr-3 font-medium">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="text-ink-2">
        {rows.map((r, i) => (
          <tr key={i} className="border-t border-line-soft">
            {r.map((c, j) => (
              <td key={j} className="py-1.5 pr-3">
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------- 失效 Bin 柏拉图：本批次条形 + 基线刻度，单轴 ----------

export function BinPareto({ pareto }: { pareto: { bin: BinId; count: number; rate: number; baseline: number }[] }) {
  const t = useTip();
  const max = Math.max(...pareto.map((p) => Math.max(p.rate, p.baseline)), 0.01);
  return (
    <Figure
      title="失效 Bin 柏拉图"
      note="占全部 die 的比例，按本批次失效数排序"
      legend={
        <>
          <span className="flex items-center gap-1.5">
            <Swatch color="#7d8894" /> 本批次（颜色即 Bin）
          </span>
          <span className="flex items-center gap-1.5">
            <Swatch color="#1b2430" shape="tick" /> 近期批次基线
          </span>
        </>
      }
      table={
        <DataTable
          head={["Bin", "失效 die", "本批次", "基线", "倍数"]}
          rows={pareto.map((p) => [BINS[p.bin].name, p.count, pct(p.rate, 2), pct(p.baseline, 2), `${(p.rate / Math.max(p.baseline, 1e-4)).toFixed(1)}×`])}
        />
      }
    >
      <div {...t.root} className="relative space-y-1.5">
        {pareto.map((p) => {
          const ratio = p.rate / Math.max(p.baseline, 1e-4);
          const tip = (
            <>
              <div className="font-medium">{BINS[p.bin].name}</div>
              <div>
                本批次 {pct(p.rate, 2)}（{p.count} 颗），基线 {pct(p.baseline, 2)}
              </div>
              <div className="text-white/70">{ratio.toFixed(1)} 倍于基线</div>
            </>
          );
          return (
            <div key={p.bin} className="grid grid-cols-[5.5rem_minmax(0,1fr)_6.5rem] items-center gap-2 text-xs">
              <span className="truncate text-ink-2">{BINS[p.bin].short}</span>
              <div className="relative h-4 rounded-sm" {...tipProps(t, tip, `${BINS[p.bin].name} 本批次 ${pct(p.rate, 2)}`)}>
                <div
                  className="absolute inset-y-0.5 left-0 rounded-r-[4px]"
                  style={{ width: `${(p.rate / max) * 100}%`, background: BINS[p.bin].color }}
                />
                <div className="absolute -inset-y-0.5 w-0.5 rounded-full bg-ink" style={{ left: `calc(${(p.baseline / max) * 100}% - 1px)` }} />
              </div>
              <span className="text-right text-ink num">
                {pct(p.rate, 2)}
                <span className={`ml-1.5 ${ratio >= 3 ? "font-semibold text-critical" : "text-muted"}`}>{ratio.toFixed(1)}×</span>
              </span>
            </div>
          );
        })}
        {t.layer}
      </div>
    </Figure>
  );
}

// ---------- 径向失效率 ----------

export function RadialProfile({ radial, bin }: { radial: { r: number; rate: number }[]; bin: BinId | null }) {
  const t = useTip();
  const max = Math.max(Math.ceil(Math.max(...radial.map((d) => d.rate)) * 10) / 10, 0.1);
  const color = bin ? BINS[bin].color : "#7d8894";
  const ticks = [0, max / 2, max];
  return (
    <Figure
      title={`径向失效率${bin ? `：${BINS[bin].short}` : ""}`}
      note="按归一化半径分 10 段，0 为晶圆中心，1 为边缘"
      table={<DataTable head={["半径段", "失效率"]} rows={radial.map((d) => [`${(d.r - 0.05).toFixed(1)}–${(d.r + 0.05).toFixed(1)}`, pct(d.rate, 1)])} />}
    >
      <div {...t.root} className="relative grid grid-cols-[2.5rem_minmax(0,1fr)] gap-x-2">
        <div className="relative h-28 text-[11px] text-muted num">
          {ticks.map((v) => (
            <span key={v} className="absolute right-0 -translate-y-1/2" style={{ top: `${(1 - v / max) * 100}%` }}>
              {pct(v, 0)}
            </span>
          ))}
        </div>
        <div className="relative h-28">
          {ticks.map((v) => (
            <div key={v} className="absolute inset-x-0 border-t border-line-soft" style={{ top: `${(1 - v / max) * 100}%` }} />
          ))}
          <div className="absolute inset-0 flex items-end gap-[3px]">
            {radial.map((d) => (
              <div
                key={d.r}
                className="flex h-full flex-1 items-end"
                {...tipProps(t, <>r {(d.r - 0.05).toFixed(1)}–{(d.r + 0.05).toFixed(1)}：失效率 {pct(d.rate, 1)}</>, `半径 ${d.r.toFixed(2)} 失效率 ${pct(d.rate, 1)}`)}
              >
                <div className="w-full rounded-t-[4px]" style={{ height: `${(d.rate / max) * 100}%`, background: color, minHeight: d.rate > 0 ? 2 : 0 }} />
              </div>
            ))}
          </div>
        </div>
        <div />
        <div className="mt-1 flex justify-between text-[11px] text-muted">
          <span>中心</span>
          <span>r = 0.5</span>
          <span>边缘</span>
        </div>
        {t.layer}
      </div>
    </Figure>
  );
}

// ---------- 逐片良率 ----------

export function WaferYieldStrip({ waferYields, baseline }: { waferYields: { slot: number; yield: number }[]; baseline: number }) {
  const t = useTip();
  const lo = 0.4;
  const y = (v: number) => ((Math.max(v, lo) - lo) / (1 - lo)) * 100;
  return (
    <Figure
      title="逐片良率"
      note={`纵轴从 40% 起，横线为基线 ${pct(baseline)}`}
      legend={
        <>
          <span className="flex items-center gap-1.5">
            <Swatch color="#52606d" /> 晶圆良率
          </span>
          <span className="flex items-center gap-1.5">
            <Swatch color="#a3241a" /> 低于基线 10 个百分点以上
          </span>
          <span className="flex items-center gap-1.5">
            <Swatch color="#1b2430" shape="line" /> 基线
          </span>
        </>
      }
      table={<DataTable head={["槽位", "良率"]} rows={waferYields.map((w) => [`#${w.slot}`, pct(w.yield)])} />}
    >
      <div {...t.root} className="relative">
        <div className="relative h-24">
          {[0.4, 0.7, 1].map((v) => (
            <div key={v} className="absolute inset-x-0 border-t border-line-soft" style={{ bottom: `${y(v)}%` }}>
              <span className="absolute -top-2 left-0 bg-panel pr-1 text-[10px] text-muted num">{pct(v, 0)}</span>
            </div>
          ))}
          <div className="absolute inset-0 left-8 flex items-end gap-[2px]">
            {waferYields.map((w) => (
              <div
                key={w.slot}
                className="flex h-full flex-1 items-end"
                {...tipProps(t, <>槽位 #{w.slot}：良率 {pct(w.yield)}</>, `槽位 ${w.slot} 良率 ${pct(w.yield)}`)}
              >
                <div
                  className="w-full rounded-t-[3px]"
                  style={{ height: `${y(w.yield)}%`, background: w.yield < baseline - 0.1 ? "#a3241a" : "#52606d" }}
                />
              </div>
            ))}
          </div>
          <div className="pointer-events-none absolute right-0 left-8 h-0.5 rounded-full bg-ink" style={{ bottom: `${y(baseline)}%` }} />
        </div>
        <div className="mt-1 ml-8 flex justify-between text-[10px] text-muted num">
          <span>#1</span>
          <span>#13</span>
          <span>#25</span>
        </div>
        {t.layer}
      </div>
    </Figure>
  );
}

// ---------- 设备共性排名 ----------

export function CommonalityChart({ rows, criterion, wafers, bad }: { rows: CommonalityRow[]; criterion: string; wafers: number; bad: number }) {
  const t = useTip();
  const show = rows.slice(0, 6);
  return (
    <Figure
      title="设备腔体共性排名"
      note={`坏片定义：${criterion}，共 ${bad}/${wafers} 片。卡方检验 p 值越小，坏片越集中`}
      legend={
        <>
          <span className="flex items-center gap-1.5">
            <Swatch color="#1b2430" /> 经过该腔体的坏片率
          </span>
          <span className="flex items-center gap-1.5">
            <Swatch color="#8693a0" shape="tick" /> 未经过该腔体的坏片率
          </span>
        </>
      }
      table={
        <DataTable
          head={["工序", "腔体", "坏片/总片", "坏片率", "其余", "p 值"]}
          rows={rows.map((r) => [r.stepName, `${r.tool}/${r.chamber}`, `${r.badWafers}/${r.wafers}`, pct(r.badRate), pct(r.othersBadRate), sci(r.pValue)])}
        />
      }
    >
      <div {...t.root} className="relative">
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_4.5rem] gap-x-3 border-b border-line-soft pb-1 text-[11px] text-muted">
          <span>设备腔体</span>
          <span>坏片率</span>
          <span className="text-right">p 值</span>
        </div>
        {show.map((r, i) => {
          const tip = (
            <>
              <div className="font-medium">
                {r.tool} 腔体 {r.chamber}
              </div>
              <div className="text-white/70">{r.stepName}</div>
              <div>
                坏片 {r.badWafers}/{r.wafers}（{pct(r.badRate)}），其余 {pct(r.othersBadRate)}
              </div>
              <div>
                χ² = {r.chi2.toFixed(1)}，p = {sci(r.pValue)}
              </div>
            </>
          );
          return (
            <div
              key={`${r.tool}${r.chamber}${r.stepId}`}
              className={`grid grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_4.5rem] items-center gap-x-3 border-b border-line-soft py-1.5 text-xs ${i === 0 ? "text-ink" : "text-ink-2"}`}
              {...tipProps(t, tip, `${r.tool} 腔体 ${r.chamber}，坏片率 ${pct(r.badRate)}，p 值 ${sci(r.pValue)}`)}
            >
              <div className="min-w-0">
                <div className={`truncate num ${i === 0 ? "font-semibold" : ""}`}>
                  {r.tool} / {r.chamber}
                </div>
                <div className="truncate text-[11px] text-muted">{r.stepName}</div>
              </div>
              <div className="relative h-3.5">
                <div className="absolute inset-y-0.5 left-0 rounded-r-[4px]" style={{ width: `${r.badRate * 100}%`, background: i === 0 ? "#1b2430" : "#a9b7bf" }} />
                <div className="absolute -inset-y-0.5 w-0.5 rounded-full bg-muted" style={{ left: `calc(${r.othersBadRate * 100}% - 1px)` }} />
              </div>
              <span className={`text-right num ${r.pValue < 1e-6 ? "font-semibold" : ""}`}>{sci(r.pValue)}</span>
            </div>
          );
        })}
        <div className="mt-1 grid grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_4.5rem] gap-x-3 text-[10px] text-muted num">
          <span />
          <span className="flex justify-between">
            <span>0%</span>
            <span>50%</span>
            <span>100%</span>
          </span>
          <span />
        </div>
        {t.layer}
      </div>
    </Figure>
  );
}

// ---------- 设备事件时间线 ----------

const SEV: Record<EquipEvent["severity"], { color: string; label: string }> = {
  信息: { color: "#8693a0", label: "信息" },
  警告: { color: "#a8660b", label: "警告" },
  严重: { color: "#a3241a", label: "严重" },
};

function SevIcon({ sev, className = "" }: { sev: EquipEvent["severity"]; className?: string }) {
  const c = SEV[sev].color;
  if (sev === "严重") return <span className={`inline-block size-2.5 rotate-45 rounded-[2px] ${className}`} style={{ background: c }} />;
  if (sev === "警告")
    return <span className={`inline-block size-2.5 ${className}`} style={{ background: c, clipPath: "polygon(50% 0, 100% 100%, 0 100%)" }} />;
  return <span className={`inline-block size-2 rounded-full ${className}`} style={{ background: c }} />;
}

const TYPE_MARK: Record<EquipEvent["type"], string> = { PM: "PM", 复机认证: "复机", 告警: "告警", 停机: "停机", 配方变更: "配方" };

export function EventTimeline({ events, from, to }: { events: EquipEvent[]; from: string | null; to: string | null }) {
  const t = useTip();
  if (!events.length) return <p className="text-xs text-muted">该时间段没有事件记录。</p>;
  const a = from ? dayNum(from) : dayNum(events[0].time);
  const b = Math.max(to ? dayNum(to) + 1 : dayNum(events[events.length - 1].time), a + 1);
  const x = (time: string) => ((dayNum(time) - a) / (b - a)) * 100;
  const span = b - a;
  const step = span > 60 ? 14 : span > 25 ? 7 : span > 10 ? 3 : 1;
  const ticks: number[] = [];
  for (let d = Math.ceil(a); d <= b; d += step) ticks.push(d);
  const notable = events.filter((e) => e.severity !== "信息" || e.type === "PM" || e.type === "复机认证" || e.type === "配方变更");
  // PM / 复机标签：位置相近的合并成一条，避免文字叠在一起
  const marks: { left: number; text: string }[] = [];
  for (const e of events) {
    if (e.type !== "PM" && e.type !== "复机认证") continue;
    const left = x(e.time);
    const prev = marks[marks.length - 1];
    if (prev && left - prev.left < 6) {
      if (!prev.text.includes(TYPE_MARK[e.type])) prev.text += `、${TYPE_MARK[e.type]}`;
    } else marks.push({ left, text: TYPE_MARK[e.type] });
  }

  return (
    <Figure
      title="设备事件时间线"
      legend={
        <>
          {(["信息", "警告", "严重"] as const).map((s) => (
            <span key={s} className="flex items-center gap-1.5">
              <SevIcon sev={s} /> {SEV[s].label}
            </span>
          ))}
        </>
      }
      table={<DataTable head={["时间", "类型", "等级", "事件"]} rows={events.map((e) => [e.time, e.type, e.severity, `${e.chamber} ${e.title}`])} />}
    >
      <div {...t.root} className="relative">
        <div className="relative mx-1 h-12">
          <div className="absolute inset-x-0 top-6 h-px bg-line" />
          {marks.map((m) => (
            <span key={m.left} className="absolute top-0 -translate-x-1/2 text-[10px] font-semibold whitespace-nowrap text-ink" style={{ left: `${m.left}%` }}>
              {m.text}
            </span>
          ))}
          {events.map((e, i) => {
            return (
              <div
                key={i}
                className="absolute top-6 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center p-1.5"
                style={{ left: `${x(e.time)}%` }}
                {...tipProps(
                  t,
                  <>
                    <div className="font-medium">
                      {e.time} {e.type}
                    </div>
                    <div>
                      腔体 {e.chamber}：{e.title}
                    </div>
                  </>,
                  `${e.time} ${e.severity} ${e.title}`,
                )}
              >
                <SevIcon sev={e.severity} className="ring-2 ring-panel" />
              </div>
            );
          })}
        </div>
        <div className="relative mx-1 h-4 text-[10px] text-muted num">
          {ticks.filter((d) => (d - a) / (b - a) < 0.94).map((d) => (
            <span key={d} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${((d - a) / (b - a)) * 100}%` }}>
              {mdShort(fromDayNum(d))}
            </span>
          ))}
        </div>
        {t.layer}
      </div>
      <ul className="mt-3 max-h-56 space-y-1 overflow-auto pr-1 text-xs scroll-thin">
        {notable.map((e, i) => (
          <li key={i} className="grid grid-cols-[6.8rem_minmax(0,1fr)] gap-2 border-t border-line-soft pt-1.5">
            <span className="flex items-start gap-1.5 text-muted num">
              <SevIcon sev={e.severity} className="mt-1 shrink-0" />
              {e.time.slice(5)}
            </span>
            <span className="text-ink-2">
              <span className="text-ink">
                {e.chamber} {e.type}：{e.title}
              </span>
              <span className="block text-muted">{e.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </Figure>
  );
}

// ---------- 在线量测散点 ----------

const DEFAULT_SITE: Record<MetrologyParam, number> = { SN_BOTTOM_CD: 4, CMP_DEFECT: 0, TIN_THICKNESS: 0 };
const CH_SHAPES = ["circle", "square", "diamond", "triangle"] as const;

function Shape({ shape, filled, color, size = 8 }: { shape: (typeof CH_SHAPES)[number]; filled: boolean; color: string; size?: number }) {
  const clip =
    shape === "triangle" ? "polygon(50% 0, 100% 100%, 0 100%)" : shape === "diamond" ? "polygon(50% 0, 100% 50%, 50% 100%, 0 50%)" : undefined;
  return (
    <span
      className={`inline-block ${shape === "circle" ? "rounded-full" : shape === "square" ? "rounded-[2px]" : ""}`}
      style={{
        width: size,
        height: size,
        background: filled || clip ? color : "transparent",
        boxShadow: filled || clip ? undefined : `inset 0 0 0 1.5px ${color}`,
        clipPath: clip,
        opacity: !filled && clip ? 0.5 : 1,
      }}
    />
  );
}

export function MetrologyChart({ param, points, splitDate, tool }: { param: MetrologyParam; points: MetrologyPoint[]; splitDate: string | null; tool: string | null }) {
  const meta = PARAM_META[param];
  const [site, setSite] = useState(DEFAULT_SITE[param]);
  const t = useTip();
  if (!points.length) return <p className="text-xs text-muted">没有量测数据。</p>;

  const groups = [...new Set(points.map((p) => `${p.tool}/${p.chamber}`))].sort();
  const vals = points.map((p) => p.values[site]);
  const lo0 = Math.min(...vals, meta.lsl ?? Infinity);
  const hi0 = Math.max(...vals, meta.usl ?? -Infinity);
  const pad = (hi0 - lo0) * 0.12 || 1;
  const lo = param === "CMP_DEFECT" ? 0 : lo0 - pad;
  const hi = hi0 + pad;
  const a = dayNum(points[0].date) - 1;
  const b = dayNum(points[points.length - 1].date) + 1;
  const px = (d: string) => ((dayNum(d) - a) / (b - a)) * 100;
  const py = (v: number) => (1 - (v - lo) / (hi - lo)) * 100;
  const oos = (v: number) => (meta.lsl != null && v < meta.lsl) || (meta.usl != null && v > meta.usl);
  const nOos = vals.filter(oos).length;
  const yTicks = [lo, (lo + hi) / 2, hi].map((v) => +v.toFixed(param === "CMP_DEFECT" ? 0 : 1));
  const span = b - a;
  const step = span > 50 ? 14 : 7;
  const xTicks: number[] = [];
  for (let d = Math.ceil(a) + 1; d < b; d += step) xTicks.push(d);

  return (
    <Figure
      title={`${meta.name}（${meta.unit}）${tool ? `：${tool}` : ""}`}
      note={`${meta.step}。灰色为规格内，红色实心为超出规格，形状区分腔体`}
      legend={
        <>
          {groups.map((g, i) => (
            <span key={g} className="flex items-center gap-1.5">
              <Shape shape={CH_SHAPES[i % 4]} filled color="#52606d" /> {g}
            </span>
          ))}
          <span className="flex items-center gap-1.5">
            <Swatch color="#a3241a" shape="circle" /> 超规格 {nOos} 片
          </span>
          {splitDate && (
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-3 border-l-2 border-dashed border-ink" /> 分界 {mdShort(splitDate)}
            </span>
          )}
        </>
      }
      table={
        <DataTable
          head={["日期", "腔体", "批次", meta.sites[site], "判定"]}
          rows={points.map((p) => [p.date, `${p.tool}/${p.chamber}`, p.waferId, p.values[site].toFixed(param === "CMP_DEFECT" ? 0 : 2), oos(p.values[site]) ? "超规格" : "正常"])}
        />
      }
    >
      {meta.sites.length > 1 && (
        <div className="mb-3 flex flex-wrap gap-1" role="group" aria-label="量测位置">
          {meta.sites.map((s, i) => (
            <button
              key={s}
              type="button"
              aria-pressed={i === site}
              onClick={() => setSite(i)}
              className={`rounded-full px-2.5 py-0.5 text-xs transition-colors ${i === site ? "bg-ink text-white" : "bg-line-soft text-ink-2 hover:bg-line"}`}
            >
              {s}
            </button>
          ))}
        </div>
      )}
      <div {...t.root} className="relative grid grid-cols-[2.75rem_minmax(0,1fr)] gap-x-2">
        <div className="relative h-44 text-[10px] text-muted num">
          {yTicks.map((v) => (
            <span key={v} className="absolute right-0 -translate-y-1/2" style={{ top: `${py(v)}%` }}>
              {v}
            </span>
          ))}
        </div>
        <div className="relative h-44">
          {yTicks.map((v) => (
            <div key={v} className="absolute inset-x-0 border-t border-line-soft" style={{ top: `${py(v)}%` }} />
          ))}
          {(["lsl", "usl"] as const).map((k) =>
            meta[k] != null ? (
              <div key={k} className="absolute inset-x-0 border-t border-dashed border-critical/70" style={{ top: `${py(meta[k]!)}%` }}>
                <span className="absolute -top-4 right-0 text-[10px] text-critical num">
                  {k.toUpperCase()} {meta[k]}
                </span>
              </div>
            ) : null,
          )}
          {splitDate && (
            <div className="absolute inset-y-0 border-l-2 border-dashed border-ink" style={{ left: `${px(splitDate)}%` }}>
              <span className="absolute top-0 left-1.5 text-[10px] font-semibold whitespace-nowrap text-ink">{mdShort(splitDate)} 之后</span>
            </div>
          )}
          {points.map((p, i) => {
            const v = p.values[site];
            const bad = oos(v);
            const g = groups.indexOf(`${p.tool}/${p.chamber}`);
            return (
              <span
                key={i}
                className="absolute flex size-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center"
                style={{ left: `${px(p.date)}%`, top: `${py(v)}%` }}
                {...tipProps(
                  t,
                  <>
                    <div className="font-medium">
                      {p.waferId}，{p.tool}/{p.chamber}
                    </div>
                    <div>
                      {p.date}　{meta.sites[site]}：{v.toFixed(param === "CMP_DEFECT" ? 0 : 2)} {meta.unit}
                      {bad ? "，超规格" : ""}
                    </div>
                  </>,
                  `${p.waferId} ${meta.sites[site]} ${v.toFixed(2)}`,
                )}
              >
                <Shape shape={CH_SHAPES[g % 4]} filled={bad} color={bad ? "#a3241a" : "#52606d"} size={8} />
              </span>
            );
          })}
        </div>
        <div />
        <div className="relative mt-1 h-4 text-[10px] text-muted num">
          {xTicks.map((d) => (
            <span key={d} className="absolute -translate-x-1/2" style={{ left: `${((d - a) / (b - a)) * 100}%` }}>
              {mdShort(fromDayNum(d))}
            </span>
          ))}
        </div>
        {t.layer}
      </div>
    </Figure>
  );
}
