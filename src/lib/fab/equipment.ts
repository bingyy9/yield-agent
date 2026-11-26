import { ROUTE, TODAY, addDays, findTool, rng } from "./core";

export type EventType = "PM" | "复机认证" | "告警" | "停机" | "配方变更";

export interface EquipEvent {
  time: string; // YYYY-MM-DD HH:mm
  tool: string;
  chamber: string;
  type: EventType;
  severity: "信息" | "警告" | "严重";
  title: string;
  detail: string;
}

const SCRIPTED: EquipEvent[] = [
  { time: "2026-09-16 09:20", tool: "ETCH-07", chamber: "A", type: "PM", severity: "信息", title: "计划性 PM", detail: "RF 时数 2,400 h 到期，腔体湿法清洁，更换边缘聚焦环。" },
  { time: "2026-09-16 15:05", tool: "ETCH-07", chamber: "A", type: "复机认证", severity: "信息", title: "复机认证通过", detail: "颗粒 9 adders（规格 ≤ 30）；季化 50 片 dummy；边缘 CD 抽检通过。" },
  { time: "2026-09-22 08:40", tool: "ETCH-07", chamber: "B", type: "PM", severity: "信息", title: "计划性 PM", detail: "腔体湿法清洁，静电卡盘表面处理。" },
  { time: "2026-09-22 14:10", tool: "ETCH-07", chamber: "B", type: "复机认证", severity: "信息", title: "复机认证通过", detail: "颗粒 14 adders；季化 50 片 dummy；边缘 CD 抽检通过。" },
  { time: "2026-10-14 08:10", tool: "ETCH-07", chamber: "C", type: "PM", severity: "信息", title: "计划性 PM", detail: "RF 时数 2,400 h 到期：更换边缘聚焦环（focus ring，新批次供应商料号 FR-7C-B2）、静电卡盘清洁、腔体湿法清洁。" },
  { time: "2026-10-14 13:40", tool: "ETCH-07", chamber: "C", type: "复机认证", severity: "警告", title: "复机认证有条件放行", detail: "颗粒 12 adders（规格 ≤ 30）通过；刻蚀速率仅测中心点通过。季化 25 片 dummy（SOP 要求 50 片），因 WIP 积压由值班工程师批准提前放行；未执行边缘 CD 抽检。" },
  { time: "2026-10-15 06:55", tool: "ETCH-07", chamber: "B", type: "停机", severity: "严重", title: "静电卡盘 He 背压泄漏", detail: "He 背压泄漏率超限，腔体 B 停机待料，期间晶圆仅在腔体 A/C 轮转。" },
  { time: "2026-10-17 18:20", tool: "ETCH-07", chamber: "B", type: "复机认证", severity: "信息", title: "更换静电卡盘后复机", detail: "颗粒 11 adders；季化 50 片 dummy；边缘 CD 抽检通过。" },
  { time: "2026-10-21 02:14", tool: "ETCH-07", chamber: "C", type: "告警", severity: "警告", title: "RF 反射功率偏高", detail: "偏置 RF 反射功率 4.8%（告警阈值 4%），自动匹配后恢复。" },
  { time: "2026-11-03 21:37", tool: "ETCH-07", chamber: "C", type: "告警", severity: "警告", title: "RF 反射功率偏高", detail: "偏置 RF 反射功率 5.1%（告警阈值 4%），自动匹配后恢复。" },
  { time: "2026-09-28 10:00", tool: "CMP-03", chamber: "H2", type: "告警", severity: "警告", title: "抛光垫寿命提醒", detail: "抛光垫寿命 92%，计划 10-07 更换。" },
  { time: "2026-09-30 16:42", tool: "CMP-03", chamber: "H2", type: "告警", severity: "警告", title: "保持环压力波动", detail: "保持环压力波动 ±4.1%（阈值 ±3%），持续 6 分钟后回落。" },
  { time: "2026-10-03 04:18", tool: "CMP-03", chamber: "H2", type: "告警", severity: "警告", title: "保持环压力波动", detail: "保持环压力波动 ±4.6%（阈值 ±3%）。" },
  { time: "2026-10-07 09:00", tool: "CMP-03", chamber: "H2", type: "PM", severity: "信息", title: "更换抛光垫与 H2 膜片", detail: "抛光垫寿命 98% 到期更换；H2 膜片发现边缘磨损，一并更换。" },
  { time: "2026-10-13 11:26", tool: "DEP-11", chamber: "B", type: "告警", severity: "警告", title: "前驱体流量偏差", detail: "TiCl4 MFC 读数偏差 +6%（阈值 ±3%），喷淋头压差上升。" },
  { time: "2026-10-16 03:51", tool: "DEP-11", chamber: "B", type: "告警", severity: "警告", title: "前驱体流量偏差", detail: "TiCl4 MFC 读数偏差 +7%。" },
  { time: "2026-10-18 08:30", tool: "DEP-11", chamber: "B", type: "PM", severity: "信息", title: "更换喷淋头", detail: "喷淋头中心区域孔堵塞，更换喷淋头并校准 MFC。" },
];

const ROUTINE_TITLES = [
  ["告警", "信息", "腔体压力瞬时偏差", "压力偏差 1.2%，自动恢复。"],
  ["告警", "信息", "机械手位置校准", "传片位置偏差，自动校准完成。"],
  ["PM", "信息", "例行 PM", "例行检查与部件清洁。"],
  ["告警", "信息", "冷却水温度波动", "温度波动 0.8 °C，在规格内。"],
] as const;

function routine(): EquipEvent[] {
  const out: EquipEvent[] = [];
  for (const step of ROUTE) {
    for (const tool of step.tools) {
      const r = rng(`events:${tool.id}`);
      let d = "2026-09-01";
      while (d <= TODAY) {
        d = addDays(d, 4 + Math.floor(r() * 9));
        if (d > TODAY) break;
        const [type, severity, title, detail] = ROUTINE_TITLES[Math.floor(r() * ROUTINE_TITLES.length)];
        const ch = tool.chambers[Math.floor(r() * tool.chambers.length)];
        const hh = String(Math.floor(r() * 24)).padStart(2, "0");
        const mm = String(Math.floor(r() * 60)).padStart(2, "0");
        out.push({ time: `${d} ${hh}:${mm}`, tool: tool.id, chamber: ch, type, severity, title, detail });
      }
    }
  }
  return out;
}

export const EVENTS: EquipEvent[] = [...SCRIPTED, ...routine()].sort((a, b) => a.time.localeCompare(b.time));

export function queryEvents(toolId: string, chamber?: string, from?: string, to?: string) {
  const t = toolId.toUpperCase();
  if (!findTool(t)) return null;
  return EVENTS.filter(
    (e) =>
      e.tool === t &&
      (!chamber || e.chamber === chamber.toUpperCase()) &&
      (!from || e.time.slice(0, 10) >= from) &&
      (!to || e.time.slice(0, 10) <= to),
  );
}
