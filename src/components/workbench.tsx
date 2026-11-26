"use client";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { ALL_BINS, BASELINE_YIELD, BINS, PRODUCT, TODAY, type BinId } from "@/lib/fab/core";
import { TOOL_LABELS } from "@/lib/agent/labels";
import type { AgentEvent, ToolView } from "@/lib/agent/types";
import { pct } from "./format";
import { RAMP_GRADIENT, MiniWafer, WaferMap, countBins, densityMax } from "./wafer";
import { ReportCard, ToolViewBody } from "./views";

export interface LotCard {
  id: string;
  status: "CP 完成" | "在制";
  start: string;
  cpDate: string | null;
  currentStep: string;
  yield: number | null;
  density: number[] | null;
}

type MapsView = Extract<ToolView, { kind: "waferMaps" }>;
type SummaryView = Extract<ToolView, { kind: "lotSummary" }>;

// ---------- 调查日志状态 ----------

type Item =
  | { key: number; kind: "user"; text: string }
  | { key: number; kind: "text"; text: string }
  | { key: number; kind: "thinking"; text: string }
  | { key: number; kind: "tool"; id: string; name: string; input?: unknown; status: "running" | "ok" | "error"; summary?: string; view?: ToolView; ms?: number }
  | { key: number; kind: "notice"; text: string; tone: "info" | "error" };

interface LogState {
  items: Item[];
  next: number;
}

type Action = AgentEvent | { type: "user"; text: string } | { type: "reset" } | { type: "aborted" };

function reduce(s: LogState, a: Action): LogState {
  type NewItem = Item extends infer T ? (T extends Item ? Omit<T, "key"> : never) : never;
  const push = (item: NewItem) => ({ items: [...s.items, { ...item, key: s.next } as Item], next: s.next + 1 });
  const last = s.items[s.items.length - 1];
  switch (a.type) {
    case "reset":
      return { items: [], next: s.next };
    case "user":
      return push({ kind: "user", text: a.text });
    case "text":
    case "thinking": {
      if (last && last.kind === a.type) {
        return { ...s, items: [...s.items.slice(0, -1), { ...last, text: last.text + a.delta }] };
      }
      return push({ kind: a.type, text: a.delta.replace(/^\n+/, "") });
    }
    case "tool_start":
      return push({ kind: "tool", id: a.id, name: a.name, status: "running" });
    case "tool_call":
    case "tool_result": {
      const idx = s.items.findLastIndex((x) => x.kind === "tool" && x.id === a.id);
      if (idx < 0) return s;
      const cur = s.items[idx] as Extract<Item, { kind: "tool" }>;
      const upd =
        a.type === "tool_call"
          ? { ...cur, input: a.input }
          : { ...cur, status: a.ok ? ("ok" as const) : ("error" as const), summary: a.summary, view: a.view, ms: a.ms };
      const items = s.items.slice();
      items[idx] = upd;
      return { ...s, items };
    }
    case "fallback":
      return push({ kind: "notice", tone: "info", text: `主模型 ${a.from} 暂时不可用，已切换到 ${a.to} 继续。` });
    case "error":
      return push({ kind: "notice", tone: "error", text: a.message });
    case "aborted":
      return {
        ...s,
        items: [
          ...s.items.map((x) => (x.kind === "tool" && x.status === "running" ? { ...x, status: "error" as const, summary: "已停止" } : x)),
          { key: s.next, kind: "notice", tone: "info", text: "调查已停止。可以修改问题后重新开始。" },
        ],
        next: s.next + 1,
      };
    default:
      return s;
  }
}

// ---------- 调查步骤（工具 → 方法论步骤） ----------

const STEPS: { label: string; tools: string[] }[] = [
  { label: "锁定异常批次", tools: ["list_lots", "get_lot_summary"] },
  { label: "晶圆图空间模式", tools: ["analyze_wafer_maps"] },
  { label: "设备共性分析", tools: ["commonality_analysis"] },
  { label: "核对设备日志", tools: ["query_equipment_log"] },
  { label: "在线量测佐证", tools: ["query_inline_metrology"] },
  { label: "比对历史案例", tools: ["search_fa_knowledge"] },
  { label: "评估影响范围", tools: ["find_exposed_lots"] },
  { label: "起草 8D 报告", tools: ["publish_8d_report"] },
];

const SCENARIOS = [
  { lot: "N3B417", prompt: "N3B417 良率掉到 80% 以下了，帮我查一下根因，出一份 8D", hint: "数据保持失效集中在晶圆边缘" },
  { lot: "N3B409", prompt: "N3B409 阵列不可修复的失效偏多，是不是 CMP 划伤？", hint: "少数晶圆上有弧线状失效" },
  { lot: "N3B412", prompt: "N3B412 中心区域漏电多，查一下是哪道工序", hint: "IDD 漏电在晶圆中心成团" },
];

// ---------- 主界面 ----------

export function Workbench({ lots, liveAvailable }: { lots: LotCard[]; liveAvailable: boolean }) {
  const [log, dispatch] = useReducer(reduce, { items: [], next: 1 });
  const [running, setRunning] = useState(false);
  const [mode, setMode] = useState<{ mode: "live" | "replay"; model: string } | null>(null);
  const [forceReplay, setForceReplay] = useState(false);
  const [input, setInput] = useState("");
  const [stageLot, setStageLot] = useState("N3B417");
  const [maps, setMaps] = useState<Record<string, MapsView>>({});
  const [summaries, setSummaries] = useState<Record<string, SummaryView>>({});
  const [wafer, setWafer] = useState<{ lotId: string; slot: number } | null>(null);
  const [focusOverride, setFocusOverride] = useState<BinId | null | undefined>(undefined);
  const historyRef = useRef<unknown[]>([]);
  const turnRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const scanning = running && log.items.some((x) => x.kind === "tool" && x.status === "running");

  const onEvent = useCallback((e: AgentEvent) => {
    if (e.type === "mode") return setMode({ mode: e.mode, model: e.model });
    if (e.type === "history") {
      historyRef.current = e.messages;
      return;
    }
    if (e.type === "done") return;
    if (e.type === "tool_result" && e.view) {
      const v = e.view;
      if (v.kind === "waferMaps") {
        setMaps((m) => ({ ...m, [v.lotId]: v }));
        setStageLot(v.lotId);
        setWafer(null);
        setFocusOverride(undefined);
      } else if (v.kind === "lotSummary") {
        setSummaries((m) => ({ ...m, [v.lotId]: v }));
        setStageLot(v.lotId);
        setWafer(null);
      }
    }
    dispatch(e);
  }, []);

  const run = useCallback(
    async (prompt: string) => {
      const text = prompt.trim();
      if (!text || running) return;
      setInput("");
      setRunning(true);
      stickRef.current = true;
      dispatch({ type: "user", text });
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        const res = await fetch("/api/agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: text, history: historyRef.current, turn: turnRef.current, forceReplay }),
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) throw new Error(`服务端返回 ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line) onEvent(JSON.parse(line) as AgentEvent);
          }
        }
        turnRef.current += 1;
      } catch (err) {
        if (ctrl.signal.aborted) dispatch({ type: "aborted" });
        else dispatch({ type: "error", message: `连接中断：${err instanceof Error ? err.message : String(err)}` });
      } finally {
        abortRef.current = null;
        setRunning(false);
      }
    },
    [running, forceReplay, onEvent],
  );

  const reset = () => {
    abortRef.current?.abort();
    dispatch({ type: "reset" });
    historyRef.current = [];
    turnRef.current = 0;
    setMaps({});
    setSummaries({});
    setWafer(null);
    setFocusOverride(undefined);
    setMode(null);
    inputRef.current?.focus();
  };

  // 流式输出时跟随到底部；用户主动上滚则停止跟随
  useEffect(() => {
    const el = scrollRef.current;
    if (running && stickRef.current && el) el.scrollTop = el.scrollHeight;
  }, [log.items, running]);

  const selectWafer = useCallback((lotId: string, slot: number) => {
    setStageLot(lotId);
    setWafer({ lotId, slot });
  }, []);

  const pickLot = (l: LotCard) => {
    setStageLot(l.id);
    setWafer(null);
    setFocusOverride(undefined);
    if (!running) {
      setInput(l.status === "在制" ? `${l.id} 还在制，前段工艺有没有风险？` : `${l.id} 良率异常，帮我查一下根因`);
      inputRef.current?.focus();
    }
  };

  const doneTools = useMemo(() => {
    const set = new Map<string, "running" | "ok" | "error">();
    for (const x of log.items) if (x.kind === "tool") set.set(x.name, x.status === "error" && set.get(x.name) === "ok" ? "ok" : x.status);
    return set;
  }, [log.items]);

  const modeLabel = mode ? (mode.mode === "live" ? `在线模式，${mode.model}` : "离线回放") : liveAvailable && !forceReplay ? "在线模式" : "离线回放";
  const isLive = mode ? mode.mode === "live" : liveAvailable && !forceReplay;

  return (
    <div className="flex min-h-dvh flex-col xl:h-dvh">
      <Header modeLabel={modeLabel} isLive={isLive} liveAvailable={liveAvailable} forceReplay={forceReplay} setForceReplay={setForceReplay} running={running} canReset={log.items.length > 0} onReset={reset} />
      <div className="relative h-0.5 overflow-hidden bg-transparent" aria-hidden>
        {running && <div className="agent-bar absolute inset-y-0 w-1/3 bg-amber" />}
      </div>
      <main className="grid flex-1 grid-cols-[minmax(0,1fr)] gap-3 p-3 xl:min-h-0 xl:grid-cols-[16.5rem_minmax(0,1fr)_25rem]">
        <LotBoard lots={lots} stageLot={stageLot} onPick={pickLot} className="order-3 xl:order-1" />
        <section className="order-2 flex min-h-[70vh] min-w-0 flex-col rounded-xl bg-panel xl:order-2 xl:min-h-0" aria-label="调查日志">
          <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto px-4 pt-5 pb-4 scroll-thin sm:px-7"
            onWheel={(e) => {
              if (e.deltaY < 0) stickRef.current = false;
              const el = e.currentTarget;
              if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) stickRef.current = true;
            }}
          >
            {log.items.length === 0 ? (
              <EmptyState lots={lots} onRun={run} />
            ) : (
              <Log items={log.items} running={running} onSelectWafer={selectWafer} selected={wafer} />
            )}
          </div>
          <Composer
            inputRef={inputRef}
            value={input}
            onChange={setInput}
            onSubmit={() => run(input)}
            onStop={() => abortRef.current?.abort()}
            running={running}
            started={log.items.length > 0}
          />
        </section>
        <Stage
          className="order-1 xl:order-3"
          lot={lots.find((l) => l.id === stageLot)!}
          maps={maps[stageLot]}
          summary={summaries[stageLot]}
          wafer={wafer?.lotId === stageLot ? wafer.slot : null}
          setWafer={(slot) => setWafer(slot == null ? null : { lotId: stageLot, slot })}
          focusOverride={focusOverride}
          setFocusOverride={setFocusOverride}
          scanning={scanning}
          steps={doneTools}
        />
      </main>
    </div>
  );
}

// ---------- 顶栏 ----------

function Header({
  modeLabel,
  isLive,
  liveAvailable,
  forceReplay,
  setForceReplay,
  running,
  canReset,
  onReset,
}: {
  modeLabel: string;
  isLive: boolean;
  liveAvailable: boolean;
  forceReplay: boolean;
  setForceReplay: (v: boolean) => void;
  running: boolean;
  canReset: boolean;
  onReset: () => void;
}) {
  return (
    <header className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 pt-3 pb-2.5 sm:px-5">
      <div className="flex items-center gap-2.5">
        <svg viewBox="0 0 32 32" className="size-7" aria-hidden>
          <circle cx="16" cy="16" r="14" fill="#1b2430" />
          <path d="M13 30.5 L16 26 L19 30.5 Z" fill="#e6eaec" />
          {[-6, 0, 6].map((x) => [-6, 0, 6].map((y) => <rect key={`${x}${y}`} x={16 + x - 2.2} y={15 + y - 2.2} width="4.4" height="4.4" rx="0.8" fill={x === 6 && y === -6 ? "#f2a900" : "#e6eaec"} opacity={x === 6 && y === -6 ? 1 : 0.85} />))}
        </svg>
        <div className="leading-tight">
          <div className="text-[17px] font-bold tracking-tight text-ink">FAgent</div>
          <div className="text-xs text-ink-2">良率与失效分析</div>
        </div>
      </div>
      <div className="hidden h-8 w-px bg-line sm:block" />
      <dl className="flex gap-5 text-xs">
        <div>
          <dt className="text-muted">产品</dt>
          <dd className="font-medium text-ink">{PRODUCT}</dd>
        </div>
        <div>
          <dt className="text-muted">良率基线</dt>
          <dd className="font-medium text-ink num">{pct(BASELINE_YIELD)}</dd>
        </div>
        <div className="hidden sm:block">
          <dt className="text-muted">数据截至</dt>
          <dd className="font-medium text-ink num">{TODAY}</dd>
        </div>
      </dl>
      <div className="ml-auto flex items-center gap-2">
        {liveAvailable && (
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-ink-2">
            <input type="checkbox" className="accent-ink" checked={forceReplay} disabled={running} onChange={(e) => setForceReplay(e.target.checked)} />
            用离线回放
          </label>
        )}
        <span
          className="flex items-center gap-1.5 rounded-full border border-line bg-panel px-2.5 py-1 text-xs text-ink-2"
          title={isLive ? "调用 Claude API，由模型自主决定调用哪些工具" : "未配置 ANTHROPIC_API_KEY：按预置调查路线调用同一套真实工具，结果都由数据算出"}
        >
          <span className={`size-1.5 rounded-full ${isLive ? "bg-[#199e70]" : "bg-muted"}`} />
          {modeLabel}
        </span>
        {canReset && (
          <button type="button" onClick={onReset} className="rounded-md px-2.5 py-1 text-xs text-ink-2 hover:bg-panel hover:text-ink">
            新调查
          </button>
        )}
      </div>
    </header>
  );
}

// ---------- 左侧批次看板 ----------

function LotBoard({ lots, stageLot, onPick, className }: { lots: LotCard[]; stageLot: string; onPick: (l: LotCard) => void; className?: string }) {
  const tested = lots.filter((l) => l.status === "CP 完成").sort((a, b) => (a.yield ?? 1) - (b.yield ?? 1));
  const wip = lots.filter((l) => l.status === "在制");
  const group = (title: string, items: LotCard[]) => (
    <div>
      <h2 className="px-1 pb-1.5 text-xs font-medium text-muted">{title}</h2>
      <ul className="flex gap-1 overflow-x-auto pb-1 scroll-thin xl:block xl:space-y-0.5 xl:overflow-visible">
        {items.map((l) => {
          const sel = l.id === stageLot;
          const low = l.yield != null && l.yield < BASELINE_YIELD - 0.05;
          return (
            <li key={l.id} className="shrink-0">
              <button
                type="button"
                onClick={() => onPick(l)}
                aria-pressed={sel}
                className={`flex w-44 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors xl:w-full ${sel ? "bg-white shadow-[0_0_0_1.5px_#1b2430]" : "hover:bg-white/70"}`}
              >
                <MiniWafer source={l.density ? { kind: "density", values: l.density, max: 0.6 } : null} bg={sel ? "#ffffff" : "#f4f6f7"} className="size-10 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="text-[13px] font-semibold text-ink num">{l.id}</span>
                    {l.yield != null && <span className={`text-[13px] num ${low ? "font-semibold text-critical" : "text-ink-2"}`}>{pct(l.yield)}</span>}
                  </span>
                  <span className="block truncate text-[11px] text-muted">
                    {l.status === "在制" ? `在制，${l.currentStep}` : low ? `低于基线 ${((BASELINE_YIELD - l.yield!) * 100).toFixed(1)} 个百分点` : `CP ${l.cpDate?.slice(5)}`}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
  return (
    <aside className={`min-w-0 rounded-xl bg-panel p-2.5 xl:overflow-y-auto xl:scroll-thin ${className ?? ""}`} aria-label="批次看板">
      <div className="flex items-baseline justify-between px-1 pt-1 pb-3">
        <h2 className="text-sm font-semibold text-ink">批次看板</h2>
        <span className="text-xs text-muted num">{lots.length} 批</span>
      </div>
      <div className="space-y-4">
        {group(`已完成 CP，按良率升序`, tested)}
        {group("在制", wip)}
      </div>
    </aside>
  );
}

// ---------- 右侧晶圆主舞台 ----------

function Stage({
  lot,
  maps,
  summary,
  wafer,
  setWafer,
  focusOverride,
  setFocusOverride,
  scanning,
  steps,
  className,
}: {
  lot: LotCard;
  maps?: MapsView;
  summary?: SummaryView;
  wafer: number | null;
  setWafer: (slot: number | null) => void;
  focusOverride: BinId | null | undefined;
  setFocusOverride: (b: BinId | null | undefined) => void;
  scanning: boolean;
  steps: Map<string, "running" | "ok" | "error">;
  className?: string;
}) {
  const w = maps && wafer != null ? maps.wafers.find((x) => x.slot === wafer) : undefined;
  const focus = focusOverride !== undefined ? focusOverride : (maps?.focusBin ?? null);

  const source = useMemo(() => {
    if (w) return { kind: "bins" as const, bins: w.bins, focus };
    if (maps) return { kind: "density" as const, values: maps.stacked, max: densityMax(maps.stacked) };
    if (lot.density) return { kind: "density" as const, values: lot.density, max: densityMax(lot.density) };
    return null;
  }, [w, maps, lot.density, focus]);

  const title = w ? `${lot.id} 槽位 #${w.slot}` : lot.id;
  const sub = w
    ? `单片 Bin 图，良率 ${pct(w.yield)}，${w.kind}`
    : maps?.focusBin
      ? `25 片叠加：${BINS[maps.focusBin].name}失效密度`
      : lot.density
        ? "25 片叠加：全部失效 Bin 的密度"
        : `在制，当前 ${lot.currentStep}，尚无 CP 数据`;

  const slots = maps?.wafers.map((x) => x.slot) ?? [];
  const stepSlot = (d: number) => {
    if (!slots.length) return;
    const i = wafer == null ? (d > 0 ? -1 : 0) : slots.indexOf(wafer);
    setWafer(slots[(i + d + slots.length) % slots.length]);
  };

  return (
    <aside className={`flex min-w-0 flex-col gap-3 xl:min-h-0 xl:overflow-y-auto xl:scroll-thin ${className ?? ""}`} aria-label="晶圆主舞台">
      <div className="rounded-xl bg-panel p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-ink num">{title}</h2>
            <p className="truncate text-xs text-ink-2">{sub}</p>
          </div>
          {maps && (
            <div className="flex shrink-0 items-center gap-1 text-xs">
              <button type="button" className={segCls(wafer == null)} onClick={() => setWafer(null)}>
                叠加
              </button>
              <button type="button" className={segCls(false)} onClick={() => stepSlot(-1)} aria-label="上一片">
                ‹
              </button>
              <button type="button" className={segCls(wafer != null)} onClick={() => (wafer == null ? stepSlot(1) : undefined)}>
                {wafer == null ? "单片" : `#${wafer}`}
              </button>
              <button type="button" className={segCls(false)} onClick={() => stepSlot(1)} aria-label="下一片">
                ›
              </button>
            </div>
          )}
        </div>

        <div className="relative mx-auto mt-2 aspect-square w-full max-w-[19.5rem] max-xl:max-w-[18rem]">
          {source ? (
            <WaferMap source={source} scanning={scanning} label={`${title} ${sub}`} className="size-full" />
          ) : (
            <div className="flex size-full items-center justify-center">
              <MiniWafer source={null} className="size-full opacity-70" />
              <span className="absolute text-xs text-muted">尚未进行 CP 测试</span>
            </div>
          )}
          {scanning && (
            <span className="absolute top-0 right-0 flex items-center gap-1.5 rounded-full bg-amber-soft px-2 py-0.5 text-[11px] text-ink">
              <span className="agent-pulse size-1.5 rounded-full bg-amber" />
              Agent 取数中
            </span>
          )}
        </div>

        {source?.kind === "density" && (
          <div className="mt-3">
            <div className="h-2 rounded-full" style={{ background: RAMP_GRADIENT }} />
            <div className="mt-1 flex justify-between text-[11px] text-muted num">
              <span>0%</span>
              <span>同一位置失效的晶圆比例</span>
              <span>{pct(source.max, 0)}</span>
            </div>
          </div>
        )}
        {source?.kind === "bins" && w && <BinLegend bins={w.bins} focus={focus} setFocus={(b) => setFocusOverride(b)} />}
      </div>

      <div className="rounded-xl bg-panel p-4">
        <LotStats lot={lot} summary={summary} maps={maps} />
      </div>

      <div className="rounded-xl bg-panel p-4 max-xl:hidden">
        <h3 className="mb-2 text-[13px] font-semibold text-ink">调查进度</h3>
        <ol className="grid grid-cols-2 gap-x-3 gap-y-1">
          {STEPS.map((s, i) => {
            const st = s.tools.map((t) => steps.get(t)).find((x) => x === "running") ?? s.tools.map((t) => steps.get(t)).find(Boolean);
            return (
              <li key={s.label} className="flex items-center gap-2.5 py-0.5 text-xs">
                <span
                  className={`flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold num ${
                    st === "ok" ? "bg-ink text-white" : st === "running" ? "bg-amber text-ink" : st === "error" ? "bg-[#f8e6e3] text-critical" : "bg-line-soft text-muted"
                  }`}
                >
                  {st === "ok" ? <Check /> : i + 1}
                </span>
                <span className={st ? "text-ink" : "text-muted"}>{s.label}</span>
              </li>
            );
          })}
        </ol>
      </div>
    </aside>
  );
}

const segCls = (on: boolean) => `rounded-md px-2 py-1 transition-colors ${on ? "bg-ink text-white" : "text-ink-2 hover:bg-line-soft"}`;

function Check() {
  return (
    <svg viewBox="0 0 12 12" className="size-3" aria-hidden>
      <path d="M2.5 6.2 L5 8.5 L9.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function BinLegend({ bins, focus, setFocus }: { bins: string; focus: BinId | null; setFocus: (b: BinId | null) => void }) {
  const counts = countBins(bins);
  const total = bins.length;
  return (
    <div className="mt-3">
      <div className="mb-1.5 flex items-baseline justify-between text-[11px] text-muted">
        <span>点击 Bin 单独查看，再点一次取消</span>
        {focus != null && (
          <button type="button" className="text-ink-2 underline underline-offset-2" onClick={() => setFocus(null)}>
            显示全部
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
        {ALL_BINS.map((b) => {
          const on = focus === b;
          const dim = focus != null && !on;
          return (
            <button
              key={b}
              type="button"
              aria-pressed={on}
              onClick={() => setFocus(on ? null : b)}
              className={`flex items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs transition-colors ${on ? "bg-white shadow-[0_0_0_1px_#1b2430]" : "hover:bg-white/70"} ${dim ? "opacity-55" : ""}`}
            >
              <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: BINS[b].color }} />
              <span className="min-w-0 flex-1 truncate text-ink-2">{BINS[b].short}</span>
              <span className="text-ink num">{counts[b] ?? 0}</span>
              <span className="w-10 text-right text-muted num">{pct((counts[b] ?? 0) / total)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function LotStats({ lot, summary, maps }: { lot: LotCard; summary?: SummaryView; maps?: MapsView }) {
  if (lot.yield == null)
    return (
      <p className="text-xs leading-relaxed text-ink-2">
        {lot.id} 于 {lot.start} 投片，目前在 {lot.currentStep}。在制批次没有 CP 数据，可以让 Agent 评估它是否经过了可疑设备。
      </p>
    );
  const delta = lot.yield - BASELINE_YIELD;
  const top = summary?.pareto[0];
  const patterned = maps ? Object.entries(maps.tally).filter(([k]) => k !== "无明显模式" && k !== "随机").sort((a, b) => b[1] - a[1])[0] : undefined;
  const cells: [string, ReactNode, string?][] = [
    ["批次良率", pct(lot.yield), delta < -0.05 ? "critical" : undefined],
    ["较基线", `${delta >= 0 ? "+" : "−"}${Math.abs(delta * 100).toFixed(1)} pt`, delta < -0.05 ? "critical" : undefined],
    ["主要失效", top ? `${BINS[top.bin].short} ${(top.rate / Math.max(top.baseline, 1e-4)).toFixed(1)}×` : "待分析"],
    ["空间模式", patterned ? `${patterned[0]} ${patterned[1]} 片` : maps ? "无明显模式" : "待分析"],
  ];
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
      {cells.map(([k, v, tone]) => (
        <div key={k}>
          <dt className="text-[11px] text-muted">{k}</dt>
          <dd className={`text-[15px] font-semibold num ${tone ? "text-critical" : v === "待分析" ? "font-normal text-muted" : "text-ink"}`}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

// ---------- 空状态 ----------

function EmptyState({ lots, onRun }: { lots: LotCard[]; onRun: (p: string) => void }) {
  return (
    <div className="mx-auto max-w-2xl py-6 sm:py-12">
      <h1 className="text-2xl leading-tight font-semibold text-balance text-ink sm:text-[28px]">从一个良率异常开始调查</h1>
      <p className="mt-3 max-w-xl text-sm leading-relaxed text-ink-2">
        FAgent 按失效分析工程师的路数工作：先看 Bin 分布和晶圆图的空间模式，再做设备共性分析，翻设备日志和在线量测找证据，比对历史案例，最后圈出受影响批次并起草 8D 报告。
      </p>
      <p className="mt-2 text-xs text-muted">数据为模拟的 {PRODUCT} 产线，18 个批次，每批 25 片，每片 626 颗 die。</p>
      <h2 className="mt-8 mb-2 text-xs font-medium text-muted">试试这三个异常</h2>
      <ul className="divide-y divide-line-soft border-y border-line-soft">
        {SCENARIOS.map((s) => {
          const lot = lots.find((l) => l.id === s.lot);
          return (
            <li key={s.lot}>
              <button type="button" onClick={() => onRun(s.prompt)} className="group flex w-full items-center gap-4 px-1 py-3.5 text-left">
                <MiniWafer source={lot?.density ? { kind: "density", values: lot.density, max: 0.6 } : null} className="size-14 shrink-0 transition-transform group-hover:scale-105 motion-reduce:transition-none" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-ink group-hover:underline group-hover:decoration-line group-hover:underline-offset-4">{s.prompt}</span>
                  <span className="mt-0.5 block text-xs text-muted">
                    {s.hint}，批次良率 {lot?.yield != null ? pct(lot.yield) : ""}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------- 调查日志 ----------

function Log({ items, running, onSelectWafer, selected }: { items: Item[]; running: boolean; onSelectWafer: (lotId: string, slot: number) => void; selected: { lotId: string; slot: number } | null }) {
  const steps = new Map<number, number>();
  for (const it of items) if (it.kind === "tool") steps.set(it.key, steps.size + 1);
  return (
    <div className="mx-auto max-w-[52rem] space-y-4">
      {items.map((it, idx) => {
        const lastOne = idx === items.length - 1;
        switch (it.kind) {
          case "user":
            return (
              <div key={it.key} className={`flex justify-end ${idx > 0 ? "pt-4" : ""}`}>
                <p className="max-w-[85%] rounded-2xl rounded-br-md bg-ink px-4 py-2.5 text-sm leading-relaxed text-white">{it.text}</p>
              </div>
            );
          case "thinking":
            return <Thinking key={it.key} text={it.text} live={running && lastOne} />;
          case "text":
            return <Prose key={it.key} text={it.text} streaming={running && lastOne} />;
          case "notice":
            return (
              <p
                key={it.key}
                role={it.tone === "error" ? "alert" : undefined}
                className={`rounded-lg px-3.5 py-2.5 text-xs leading-relaxed ${it.tone === "error" ? "bg-[#f8e6e3] text-critical" : "bg-line-soft text-ink-2"}`}
              >
                {it.text}
              </p>
            );
          case "tool":
            return <ToolCard key={it.key} item={it} step={steps.get(it.key)!} onSelectWafer={onSelectWafer} selected={selected} />;
        }
      })}
    </div>
  );
}

function Thinking({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  const show = open || live;
  return (
    <div className="text-xs">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={show} className="flex items-center gap-1.5 text-muted hover:text-ink-2">
        <span className={`size-1.5 rounded-full ${live ? "agent-pulse bg-amber" : "bg-line"}`} />
        {live ? "思考中" : "思考过程"}
        <span className={`transition-transform ${show ? "rotate-90" : ""}`}>›</span>
      </button>
      {show && <p className="mt-1.5 border-l-2 border-line pl-3 leading-relaxed whitespace-pre-wrap text-ink-2">{text.trim()}</p>}
    </div>
  );
}

// 轻量 Markdown：段落、列表、加粗、行内代码
function inline(s: string): ReactNode[] {
  return s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={i} className="font-semibold text-ink">{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={i} className="rounded bg-line-soft px-1 text-[0.92em]">{part.slice(1, -1)}</code>;
    return part;
  });
}

function Prose({ text, streaming }: { text: string; streaming: boolean }) {
  const blocks = text.trim().split(/\n{2,}/);
  return (
    <div className="space-y-2.5 text-[14.5px] leading-[1.75] text-ink">
      {blocks.map((b, i) => {
        const caret = streaming && i === blocks.length - 1 ? "caret" : "";
        const lines = b.split("\n");
        if (lines.every((l) => /^\s*([-*]|\d+\.)\s/.test(l))) {
          const ordered = /^\s*\d+\./.test(lines[0]);
          const L = ordered ? "ol" : "ul";
          return (
            <L key={i} className={`space-y-1 pl-5 ${ordered ? "list-decimal" : "list-disc"} marker:text-muted ${caret}`}>
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(/^\s*([-*]|\d+\.)\s/, ""))}</li>
              ))}
            </L>
          );
        }
        if (/^#{1,4}\s/.test(b)) return <h3 key={i} className={`pt-1 text-[15px] font-semibold ${caret}`}>{inline(b.replace(/^#+\s/, ""))}</h3>;
        return (
          <p key={i} className={`whitespace-pre-wrap ${caret}`}>
            {inline(b)}
          </p>
        );
      })}
    </div>
  );
}

function fmtArg(v: unknown): string {
  if (Array.isArray(v)) return v.join("、");
  if (typeof v === "object" && v) return JSON.stringify(v);
  return String(v);
}

const ARG_LABELS: Record<string, string> = {
  lot_id: "批次",
  lot_ids: "批次",
  bin: "Bin",
  focus_bin: "Bin",
  threshold: "阈值",
  tool_id: "设备",
  chamber: "腔体",
  start_date: "起",
  end_date: "止",
  parameter: "参数",
  split_date: "分界",
  since: "起",
  until: "止",
  query: "检索",
  pattern: "模式",
  status: "状态",
};

function ToolCard({
  item,
  step,
  onSelectWafer,
  selected,
}: {
  item: Extract<Item, { kind: "tool" }>;
  step: number;
  onSelectWafer: (lotId: string, slot: number) => void;
  selected: { lotId: string; slot: number } | null;
}) {
  const [open, setOpen] = useState(true);
  const [showArgs, setShowArgs] = useState(false);
  const label = TOOL_LABELS[item.name] ?? item.name;
  const args =
    item.input && typeof item.input === "object" && item.name !== "publish_8d_report"
      ? Object.entries(item.input as Record<string, unknown>).filter(([, v]) => v !== undefined && v !== null && String(v).length < 60)
      : [];
  const isReport = item.view?.kind === "report";
  const running = item.status === "running";

  return (
    <div className={`relative rounded-xl border bg-paper transition-colors ${running ? "border-amber shadow-[0_0_0_3px_#fcefc7]" : "border-line-soft"}`}>
      <div className="flex items-start gap-3 px-3.5 py-2.5">
        <span
          className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold num ${
            running ? "bg-amber text-ink" : item.status === "error" ? "bg-[#f8e6e3] text-critical" : "bg-line-soft text-ink-2"
          }`}
          aria-label={running ? "执行中" : item.status === "error" ? "失败" : "完成"}
        >
          {running ? <span className="agent-pulse">{step}</span> : step}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <span className="text-[13px] font-semibold text-ink">{label}</span>
            {args.map(([k, v]) => (
              <span key={k} className="text-xs text-muted">
                {ARG_LABELS[k] ?? k} <span className="text-ink-2 num">{fmtArg(v)}</span>
              </span>
            ))}
          </div>
          <p className={`mt-0.5 text-xs leading-relaxed ${item.status === "error" ? "text-critical" : "text-ink-2"}`}>
            {running ? (item.input ? "正在取数和计算" : "正在准备调用参数") : item.summary}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-[11px] text-muted">
          {item.ms != null && <span className="num">{item.ms < 1000 ? `${item.ms} ms` : `${(item.ms / 1000).toFixed(1)} s`}</span>}
          {item.view && !isReport && (
            <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="rounded px-1.5 py-0.5 text-ink-2 hover:bg-line-soft">
              {open ? "收起" : "展开"}
            </button>
          )}
        </div>
      </div>
      {running && (
        <div className="relative mx-3.5 mb-3 h-0.5 overflow-hidden rounded-full bg-amber-soft" aria-hidden>
          <div className="agent-bar absolute inset-y-0 w-1/3 rounded-full bg-amber" />
        </div>
      )}
      {item.view && open && !isReport && (
        <div className="border-t border-line-soft bg-panel/60 px-3.5 pt-3.5 pb-4">
          <ToolViewBody view={item.view} onSelectWafer={onSelectWafer} selected={selected} />
          {item.input != null && (
            <div className="mt-3">
              <button type="button" onClick={() => setShowArgs((v) => !v)} className="text-[11px] text-muted underline decoration-line underline-offset-2 hover:text-ink-2">
                {showArgs ? "隐藏调用参数" : "查看调用参数"}
              </button>
              {showArgs && (
                <pre className="mt-1.5 overflow-x-auto rounded-md bg-line-soft p-2.5 text-[11px] leading-relaxed text-ink-2 scroll-thin">{JSON.stringify(item.input, null, 2)}</pre>
              )}
            </div>
          )}
        </div>
      )}
      {isReport && item.view?.kind === "report" && (
        <div className="px-2 pb-2">
          <ReportCard report={item.view.report} />
        </div>
      )}
    </div>
  );
}

// ---------- 输入框 ----------

function Composer({
  inputRef,
  value,
  onChange,
  onSubmit,
  onStop,
  running,
  started,
}: {
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  running: boolean;
  started: boolean;
}) {
  return (
    <form
      className="sticky bottom-0 border-t border-line-soft bg-panel px-4 pt-3 pb-4 sm:px-7"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <div className="mx-auto flex max-w-[52rem] items-end gap-2 rounded-xl border border-line bg-white p-1.5 pl-3.5 focus-within:border-ink/50">
        <label htmlFor="prompt" className="sr-only">
          描述良率问题
        </label>
        <textarea
          id="prompt"
          ref={inputRef}
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onSubmit();
            }
          }}
          placeholder={started ? "继续追问，比如：在制批次怎么处理？" : "描述良率问题，比如：N3B417 良率掉了，帮我查根因"}
          className="max-h-40 min-h-9 flex-1 resize-none bg-transparent py-1.5 text-sm text-ink outline-none placeholder:text-muted field-sizing-content"
          style={{ outline: "none" }}
        />
        {running ? (
          <button type="button" onClick={onStop} className="h-9 shrink-0 rounded-lg border border-line px-3.5 text-sm text-ink hover:bg-panel">
            停止
          </button>
        ) : (
          <button type="submit" disabled={!value.trim()} className="h-9 shrink-0 rounded-lg bg-ink px-3.5 text-sm font-medium text-white hover:bg-ink/85 disabled:bg-line disabled:text-muted">
            {started ? "发送" : "开始调查"}
          </button>
        )}
      </div>
      <p className="mx-auto mt-1.5 max-w-[52rem] text-[11px] text-muted">Enter 发送，Shift + Enter 换行。结论为草稿，需 FA 工程师复核。</p>
    </form>
  );
}
