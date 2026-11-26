import type { CommonalityRow, PatternKind } from "../fab/analysis";
import type { BinId } from "../fab/core";
import type { EquipEvent } from "../fab/equipment";
import type { FaCase } from "../fab/knowledge";
import type { MetrologyParam, MetrologyPoint } from "../fab/metrology";

export interface LotRow {
  id: string;
  status: string;
  start: string;
  cpDate: string | null;
  currentStep: string;
  yield: number | null;
}

export interface Report8D {
  id: string;
  title: string;
  severity: "高" | "中" | "低";
  lotIds: string[];
  createdAt: string;
  d2Problem: string;
  d3Containment: string[];
  d4RootCause: string;
  evidence: string[];
  d5Corrective: string[];
  d7Preventive: string[];
  confidence: number;
}

export type ToolView =
  | { kind: "lots"; lots: LotRow[]; baseline: number }
  | {
      kind: "lotSummary";
      lotId: string;
      yield: number;
      baseline: number;
      pareto: { bin: BinId; count: number; rate: number; baseline: number }[];
      waferYields: { slot: number; yield: number }[];
    }
  | {
      kind: "waferMaps";
      lotId: string;
      focusBin: BinId | null;
      wafers: { slot: number; waferId: string; yield: number; kind: PatternKind; confidence: number; bins: string }[];
      stacked: number[];
      radial: { r: number; rate: number }[];
      tally: Record<string, number>;
    }
  | { kind: "commonality"; criterion: string; wafers: number; bad: number; rows: CommonalityRow[] }
  | { kind: "events"; tool: string; chamber: string | null; from: string | null; to: string | null; events: EquipEvent[] }
  | {
      kind: "metrology";
      param: MetrologyParam;
      tool: string | null;
      splitDate: string | null;
      points: MetrologyPoint[];
    }
  | { kind: "cases"; query: string; cases: (FaCase & { relevance: number })[] }
  | {
      kind: "exposure";
      tool: string;
      chamber: string;
      since: string;
      lots: { lotId: string; status: string; currentStep: string; date: string; slots: number[]; affectedYield: number | null }[];
    }
  | { kind: "report"; report: Report8D };

export type AgentEvent =
  | { type: "mode"; mode: "live" | "replay"; model: string }
  | { type: "thinking"; delta: string }
  | { type: "text"; delta: string }
  | { type: "tool_start"; id: string; name: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; ok: boolean; summary: string; view?: ToolView; ms: number }
  | { type: "fallback"; from: string; to: string }
  | { type: "history"; messages: unknown[] }
  | { type: "error"; message: string }
  | { type: "done" };
