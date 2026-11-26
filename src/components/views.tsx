"use client";
import { useState } from "react";
import { BINS } from "@/lib/fab/core";
import type { Report8D, ToolView } from "@/lib/agent/types";
import { BinPareto, CommonalityChart, DataTable, EventTimeline, Figure, MetrologyChart, RadialProfile, Swatch, WaferYieldStrip } from "./charts";
import { mdShort, pct } from "./format";
import { MiniWafer } from "./wafer";

export type SelectWafer = (lotId: string, slot: number) => void;

export function ToolViewBody({ view, onSelectWafer, selected }: { view: ToolView; onSelectWafer: SelectWafer; selected: { lotId: string; slot: number } | null }) {
  switch (view.kind) {
    case "lots":
      return <LotsView lots={view.lots} baseline={view.baseline} />;
    case "lotSummary":
      return (
        <div className="grid gap-6 lg:grid-cols-2">
          <BinPareto pareto={view.pareto} />
          <WaferYieldStrip waferYields={view.waferYields} baseline={view.baseline} />
        </div>
      );
    case "waferMaps":
      return (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          <PatternGallery view={view} onSelectWafer={onSelectWafer} selected={selected} />
          <RadialProfile radial={view.radial} bin={view.focusBin} />
        </div>
      );
    case "commonality":
      return <CommonalityChart rows={view.rows} criterion={view.criterion} wafers={view.wafers} bad={view.bad} />;
    case "events":
      return <EventTimeline events={view.events} from={view.from} to={view.to} />;
    case "metrology":
      return <MetrologyChart param={view.param} points={view.points} splitDate={view.splitDate} tool={view.tool} />;
    case "cases":
      return <CasesView cases={view.cases} />;
    case "exposure":
      return <ExposureView view={view} />;
    case "report":
      return <ReportCard report={view.report} />;
  }
}

// ---------- 批次清单 ----------

function LotsView({ lots, baseline }: { lots: Extract<ToolView, { kind: "lots" }>["lots"]; baseline: number }) {
  const tested = lots.filter((l) => l.yield != null);
  return (
    <Figure
      title={`批次清单（${lots.length} 批，已测 ${tested.length} 批）`}
      note={`良率条形从 60% 起，竖线为基线 ${pct(baseline)}`}
      table={<DataTable head={["批次", "状态", "当前工序", "CP 日期", "良率"]} rows={lots.map((l) => [l.id, l.status, l.currentStep, l.cpDate ?? "未测", l.yield == null ? "未测" : pct(l.yield)])} />}
    >
      <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
        {lots.map((l) => {
          const low = l.yield != null && l.yield < baseline - 0.05;
          return (
            <div key={l.id} className="grid grid-cols-[4.2rem_minmax(0,1fr)_3.4rem] items-center gap-2 border-t border-line-soft py-1 text-xs">
              <span className={`num ${low ? "font-semibold text-ink" : "text-ink-2"}`}>{l.id}</span>
              {l.yield != null ? (
                <div className="relative h-2.5">
                  <div className="absolute inset-y-0 left-0 rounded-r-[4px]" style={{ width: `${((Math.max(l.yield, 0.6) - 0.6) / 0.4) * 100}%`, background: low ? "#a3241a" : "#8693a0" }} />
                  <div className="absolute -inset-y-0.5 w-0.5 bg-ink" style={{ left: `${((baseline - 0.6) / 0.4) * 100}%` }} />
                </div>
              ) : (
                <span className="truncate text-muted">在制，{l.currentStep}</span>
              )}
              <span className={`text-right num ${low ? "font-semibold text-critical" : "text-ink-2"}`}>{l.yield != null ? pct(l.yield) : ""}</span>
            </div>
          );
        })}
      </div>
    </Figure>
  );
}

// ---------- 晶圆图画廊：25 片缩略图，点击送到右侧主舞台 ----------

function PatternGallery({
  view,
  onSelectWafer,
  selected,
}: {
  view: Extract<ToolView, { kind: "waferMaps" }>;
  onSelectWafer: SelectWafer;
  selected: { lotId: string; slot: number } | null;
}) {
  const focus = view.focusBin;
  const tally = Object.entries(view.tally).sort((a, b) => b[1] - a[1]);
  return (
    <Figure
      title={`${view.lotId} 逐片晶圆图`}
      note="点击任一片，在右侧放大查看"
      legend={
        <>
          {focus && (
            <span className="flex items-center gap-1.5">
              <Swatch color={BINS[focus].color} /> {BINS[focus].name}
            </span>
          )}
          <span className="flex items-center gap-1.5">
            <Swatch color="#bdc7cd" /> 其他失效
          </span>
          <span className="flex items-center gap-1.5">
            <Swatch color="#e4e9eb" /> 良品
          </span>
        </>
      }
      table={
        <DataTable
          head={["槽位", "良率", "模式", "置信度"]}
          rows={view.wafers.map((w) => [`#${w.slot}`, pct(w.yield), w.kind, w.kind === "无明显模式" ? "" : pct(w.confidence, 0)])}
        />
      }
    >
      <div className="mb-3 flex flex-wrap gap-1.5 text-xs">
        {tally.map(([k, n]) => (
          <span key={k} className={`rounded-full px-2 py-0.5 ${k === "无明显模式" || k === "随机" ? "bg-line-soft text-ink-2" : "bg-ink text-white"}`}>
            {k} <span className="num">{n}</span>
          </span>
        ))}
      </div>
      <div className="grid grid-cols-5 gap-x-1.5 gap-y-2.5">
        {view.wafers.map((w) => {
          const patterned = w.kind !== "无明显模式" && w.kind !== "随机";
          const isSel = selected?.lotId === view.lotId && selected.slot === w.slot;
          return (
            <button
              key={w.slot}
              type="button"
              onClick={() => onSelectWafer(view.lotId, w.slot)}
              aria-pressed={isSel}
              aria-label={`槽位 ${w.slot}，良率 ${pct(w.yield)}，${w.kind}`}
              className={`group flex flex-col items-center rounded-md p-1 transition-colors ${isSel ? "bg-white ring-2 ring-ink" : "hover:bg-white"}`}
            >
              <MiniWafer source={{ kind: "bins", bins: w.bins, focus }} bg={isSel ? "#ffffff" : "#f4f6f7"} className="w-full max-w-20" />
              <span className="mt-1 flex w-full justify-between px-0.5 text-[10px] num">
                <span className="text-muted">#{w.slot}</span>
                <span className={w.yield < 0.8 ? "font-semibold text-critical" : "text-ink-2"}>{pct(w.yield, 0)}</span>
              </span>
              <span className={`w-full truncate px-0.5 text-left text-[10px] ${patterned ? "font-medium text-ink" : "text-muted"}`}>{w.kind}</span>
            </button>
          );
        })}
      </div>
    </Figure>
  );
}

// ---------- FA 案例 ----------

function CasesView({ cases }: { cases: Extract<ToolView, { kind: "cases" }>["cases"] }) {
  if (!cases.length) return <p className="text-xs text-muted">案例库里没有相似案例。</p>;
  return (
    <div className="space-y-3">
      {cases.map((c, i) => (
        <article key={c.id} className={`rounded-lg border px-3.5 py-3 ${i === 0 ? "border-ink/25 bg-white" : "border-line-soft"}`}>
          <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-xs text-muted num">{c.id}</span>
            <h4 className="min-w-0 flex-1 text-[13px] font-semibold text-ink">{c.title}</h4>
            <span className="flex items-center gap-2 text-xs text-ink-2">
              相似度
              <span className="relative inline-block h-1.5 w-14 rounded-full bg-line-soft">
                <span className="absolute inset-y-0 left-0 rounded-full bg-ink" style={{ width: `${Math.min(1, c.relevance) * 100}%` }} />
              </span>
              <span className="num">{pct(Math.min(1, c.relevance), 0)}</span>
            </span>
          </header>
          <p className="mt-1.5 text-xs text-muted">
            {c.date}，{c.module}，{c.pattern}，Bin {c.bins.join("、")}，{c.yieldImpact}
          </p>
          {i === 0 && (
            <dl className="mt-2 grid gap-1.5 text-xs leading-relaxed text-ink-2">
              <div>
                <dt className="inline font-medium text-ink">根因：</dt>
                <dd className="inline">{c.rootCause}</dd>
              </div>
              <div>
                <dt className="inline font-medium text-ink">当时的措施：</dt>
                <dd className="inline">{c.fix}</dd>
              </div>
            </dl>
          )}
        </article>
      ))}
    </div>
  );
}

// ---------- 影响范围 ----------

function ExposureView({ view }: { view: Extract<ToolView, { kind: "exposure" }> }) {
  const wafers = view.lots.reduce((s, l) => s + l.slots.length, 0);
  const wip = view.lots.filter((l) => l.status === "在制");
  const wipWafers = wip.reduce((s, l) => s + l.slots.length, 0);
  return (
    <div>
      <div className="mb-3 grid grid-cols-3 gap-px overflow-hidden rounded-lg bg-line-soft text-center">
        {[
          ["受影响批次", view.lots.length, "批"],
          ["受影响晶圆", wafers, "片"],
          ["在制待拦截", wipWafers, "片"],
        ].map(([k, v, u], i) => (
          <div key={k} className={`px-2 py-2.5 ${i === 2 && wipWafers ? "bg-[#f8e6e3]" : "bg-panel"}`}>
            <div className={`text-xl font-semibold num ${i === 2 && wipWafers ? "text-critical" : "text-ink"}`}>
              {v}
              <span className="ml-0.5 text-xs font-normal text-muted">{u}</span>
            </div>
            <div className="text-[11px] text-ink-2">{k}</div>
          </div>
        ))}
      </div>
      <p className="mb-2 text-xs text-muted">
        {view.tool} 腔体 {view.chamber}，自 {mdShort(view.since)} 起过站的晶圆
      </p>
      <DataTable
        head={["批次", "状态", "当前工序", "过站", "片数", "良率"]}
        rows={view.lots.map((l) => [
          <span key="id" className="font-medium text-ink">
            {l.lotId}
          </span>,
          l.status === "在制" ? (
            <span key="s" className="inline-flex items-center gap-1 font-medium text-critical">
              <span className="size-1.5 rounded-full bg-critical" />
              在制，需拦截
            </span>
          ) : (
            l.status
          ),
          l.currentStep,
          mdShort(l.date),
          l.slots.length,
          l.affectedYield == null ? "未测" : pct(l.affectedYield),
        ])}
      />
    </div>
  );
}

// ---------- 8D 报告 ----------

const SEVERITY: Record<Report8D["severity"], { bg: string; fg: string; label: string }> = {
  高: { bg: "#f8e6e3", fg: "#a3241a", label: "严重度 高" },
  中: { bg: "#f6ecd9", fg: "#8a5208", label: "严重度 中" },
  低: { bg: "#e6ebee", fg: "#52606d", label: "严重度 低" },
};

export function reportMarkdown(r: Report8D) {
  const list = (xs: string[]) => xs.map((x) => `- ${x}`).join("\n");
  return `# ${r.id} ${r.title}

- 严重度：${r.severity}
- 涉及批次：${r.lotIds.join("、")}
- 创建日期：${r.createdAt}
- 根因置信度：${Math.round(r.confidence * 100)}%
- 起草：FAgent（待 FA 工程师复核）

## D2 问题描述
${r.d2Problem}

## D3 临时围堵措施
${list(r.d3Containment)}

## D4 根本原因
${r.d4RootCause}

### 证据链
${r.evidence.map((e, i) => `${i + 1}. ${e}`).join("\n")}

## D5 永久纠正措施
${list(r.d5Corrective)}

## D7 预防再发
${list(r.d7Preventive)}
`;
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Section({ code, title, children }: { code: string; title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-x-4 gap-y-1 border-t border-line-soft py-3.5 sm:grid-cols-[6.5rem_minmax(0,1fr)]">
      <h4 className="text-[13px] font-semibold text-ink">
        <span className="mr-1.5 text-muted num">{code}</span>
        {title}
      </h4>
      <div className="text-[13px] leading-relaxed text-ink-2">{children}</div>
    </section>
  );
}

function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="space-y-1">
      {items.map((x, i) => (
        <li key={i} className="relative pl-3.5 before:absolute before:top-[0.6em] before:left-0 before:size-1.5 before:rounded-full before:bg-line">
          {x}
        </li>
      ))}
    </ul>
  );
}

export function ReportCard({ report: r }: { report: Report8D }) {
  const [copied, setCopied] = useState(false);
  const sev = SEVERITY[r.severity];
  return (
    <article className="overflow-hidden rounded-xl border border-ink/15 bg-white shadow-[0_1px_0_#d3dadf,0_8px_24px_-12px_rgba(27,36,48,0.25)]">
      <header className="border-b border-line-soft px-5 pt-4 pb-3.5">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-semibold text-ink num">{r.id}</span>
          <span className="rounded-full px-2 py-0.5 font-medium" style={{ background: sev.bg, color: sev.fg }}>
            {sev.label}
          </span>
          <span className="text-muted">草稿，待 FA 工程师复核</span>
        </div>
        <h3 className="mt-2 text-lg leading-snug font-semibold text-balance text-ink">{r.title}</h3>
        <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-ink-2">
          <span>
            涉及批次 <span className="font-medium text-ink num">{r.lotIds.join("、")}</span>
          </span>
          <span className="flex items-center gap-2">
            根因置信度
            <span className="relative inline-block h-1.5 w-20 rounded-full bg-line-soft">
              <span className="absolute inset-y-0 left-0 rounded-full bg-ink" style={{ width: `${r.confidence * 100}%` }} />
            </span>
            <span className="font-medium text-ink num">{Math.round(r.confidence * 100)}%</span>
          </span>
          <span className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={async () => {
                await navigator.clipboard.writeText(reportMarkdown(r));
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
              }}
              className="rounded-md border border-line px-2.5 py-1 text-ink-2 hover:border-ink/40 hover:text-ink"
            >
              {copied ? "已复制" : "复制全文"}
            </button>
            <button type="button" onClick={() => download(`${r.id}.md`, reportMarkdown(r))} className="rounded-md bg-ink px-2.5 py-1 font-medium text-white hover:bg-ink/85">
              导出 Markdown
            </button>
          </span>
        </div>
      </header>
      <div className="px-5 pb-2">
        <Section code="D2" title="问题描述">
          {r.d2Problem}
        </Section>
        <Section code="D3" title="临时围堵">
          <Bullets items={r.d3Containment} />
        </Section>
        <Section code="D4" title="根本原因">
          <p className="text-ink">{r.d4RootCause}</p>
          <ol className="mt-2.5 space-y-1.5">
            {r.evidence.map((e, i) => (
              <li key={i} className="grid grid-cols-[1.25rem_minmax(0,1fr)] text-xs leading-relaxed">
                <span className="text-muted num">{i + 1}</span>
                <span>{e}</span>
              </li>
            ))}
          </ol>
        </Section>
        <Section code="D5" title="纠正措施">
          <Bullets items={r.d5Corrective} />
        </Section>
        <Section code="D7" title="预防再发">
          <Bullets items={r.d7Preventive} />
        </Section>
      </div>
    </article>
  );
}
