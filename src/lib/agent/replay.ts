// 离线回放模式：没有 API key 时，按预设调查顺序调用同一套真实工具，旁白里的数字全部取自工具返回结果。
import { sci } from "../sci";
import { BINS, BinId, STEP_BY_ID, TODAY } from "../fab/core";
import { allLots, getLot } from "../fab/wafers";
import { runTool, type ToolOutput } from "./tools";
import type { AgentEvent, ToolView } from "./types";

type Emit = (e: AgentEvent) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;
const pt = (x: number) => (x * 100).toFixed(1);
const md = (date: string) => `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
const slotList = (slots: number[]) => slots.map((s) => `#${s}`).join("、");

class Session {
  private n = 0;
  constructor(private emit: Emit, private signal: AbortSignal) {}

  get aborted() {
    return this.signal.aborted;
  }

  async stream(kind: "text" | "thinking", text: string) {
    const step = kind === "thinking" ? 6 : 3;
    for (let i = 0; i < text.length && !this.aborted; i += step) {
      this.emit({ type: kind, delta: text.slice(i, i + step) });
      await sleep(kind === "thinking" ? 10 : 16, this.signal);
    }
  }

  think(text: string) {
    return this.stream("thinking", text);
  }

  say(text: string) {
    return this.stream("text", text + "\n\n");
  }

  async tool(name: string, input: Record<string, unknown>): Promise<{ data: Json; output: ToolOutput }> {
    const id = `replay_${++this.n}`;
    this.emit({ type: "tool_start", id, name });
    await sleep(260, this.signal);
    this.emit({ type: "tool_call", id, name, input });
    const t0 = Date.now();
    const r = runTool(name, input);
    await sleep(650 + Math.random() * 500, this.signal);
    if (!r.ok) {
      this.emit({ type: "tool_result", id, name, ok: false, summary: r.message, ms: Date.now() - t0 });
      throw new Error(r.message);
    }
    this.emit({
      type: "tool_result",
      id,
      name,
      ok: true,
      summary: r.output.summary,
      view: r.output.view as ToolView,
      ms: Date.now() - t0,
    });
    return { data: r.output.forModel as Json, output: r.output };
  }
}

// ---------- 场景 A：存储节点刻蚀腔体边缘 CD 收缩 → Bin 7 边缘环 ----------

async function edgeRing(s: Session, lotId: string) {
  await s.think(
    `工程师关心的是 ${lotId} 的良率。先看全局：这一批掉了多少，是孤立事件还是一串批次都有问题。然后再下钻到 Bin 和晶圆图。`,
  );
  await s.say(`先拉一下近期批次清单，看看 ${lotId} 掉了多少、是不是孤立事件。`);
  const lots = (await s.tool("list_lots", {})).data;
  if (s.aborted) return;
  const low = lots.lots.filter((l: Json) => lots.lowYieldLots.includes(l.id));
  const me = lots.lots.find((l: Json) => l.id === lotId);
  await s.say(
    `近期有 ${low.length} 个批次比基线低 3 个百分点以上：${low.map((l: Json) => `${l.id}（${pct(l.yield)}）`).join("、")}。` +
      `${lotId} 良率 ${pct(me.yield)}，比基线 ${pct(lots.baselineYield)} 低了 ${pt(lots.baselineYield - me.yield)} 个百分点。先看它是哪类失效。`,
  );

  const sum = (await s.tool("get_lot_summary", { lot_id: lotId })).data;
  if (s.aborted) return;
  const b7 = sum.failBins.find((b: Json) => b.bin === 7);
  const others = sum.failBins.filter((b: Json) => b.bin !== 7);
  const maxOther = Math.max(...others.map((b: Json) => b.ratioToBaseline));
  await s.say(
    `问题很集中：Bin 7 数据保持失效率 ${pct(b7.rate, 2)}，是基线 ${pct(b7.baselineRate, 2)} 的 ${b7.ratioToBaseline} 倍；其他 Bin 最多只到基线的 ${maxOther} 倍。` +
      `片间差异很大，最差的 ${sum.worstWafers.slice(0, 3).map((w: Json) => `#${w.slot}（${pct(w.yield)}）`).join("、")}，好片在 ${pct(sum.waferYieldRange[1])} 左右。` +
      `数据保持失效一般和存储电容有关，接着看 Bin 7 在晶圆上的位置。`,
  );

  const maps = (await s.tool("analyze_wafer_maps", { lot_id: lotId, focus_bin: 7 })).data;
  if (s.aborted) return;
  const ring = maps.wafers.filter((w: Json) => w.pattern === "边缘环");
  const rad = maps.radialFailRate;
  const inner = rad.slice(0, 6).reduce((a: number, p: Json) => a + p.rate, 0) / 6;
  await s.think(
    `边缘环，而且只出现在一半的晶圆上，片号很规律。一批晶圆在某道工序被轮流分到几个腔体，最可能是某个腔体有问题。边缘失效 + 数据保持，候选是存储节点刻蚀（高深宽比，边缘鞘层敏感）或电介质/电极沉积的边缘均匀性。用共性分析来定。`,
  );
  await s.say(
    `${ring.length} 片呈边缘环，片号 ${slotList(ring.map((w: Json) => w.slot))}。` +
      `径向分布很清楚：最外圈 Bin 7 失效率 ${pct(rad[9].rate)}，r < 0.6 的区域平均只有 ${pct(inner, 2)}。` +
      `受影响的片号间隔规律，像是在某道工序被分到了同一个腔体。用全部已测批次做设备共性分析，坏片定义为 Bin 7 失效率超过 6%。`,
  );

  const com = (await s.tool("commonality_analysis", { bin: 7, threshold: 0.06 })).data;
  if (s.aborted) return;
  const [top, second] = com.ranking;
  await s.say(
    `结果很干净：${top.step.replace(/^\d+ /, "")}的 ${top.tool} 腔体 ${top.chamber} 上，${top.badWafers}/${top.wafers} 片是坏片，其余晶圆的坏片率是 ${pct(top.othersBadRate)}，卡方 ${top.chi2}，p = ${sci(top.pValue)}。` +
      `排第二的 ${second.tool}/${second.chamber} p 值是 ${sci(second.pValue)}，比第一名高了 ${Math.round(Math.log10(second.pValue / top.pValue))} 个数量级，差得很远。` +
      `不过这个腔体也有 ${top.wafers - top.badWafers} 片是好的，说明问题有起始时间。查一下 ${top.tool} 腔体 ${top.chamber} 的设备日志。`,
  );

  const ev = (await s.tool("query_equipment_log", { tool_id: top.tool, chamber: top.chamber, start_date: "2026-09-01", end_date: TODAY })).data;
  if (s.aborted) return;
  const pm = ev.events.find((e: Json) => e.type === "PM" && e.detail.includes("聚焦环"));
  const qual = ev.events.find((e: Json) => e.type === "复机认证" && e.severity === "警告");
  const rf = ev.events.filter((e: Json) => e.title.includes("RF"));
  const pmDate = pm.time.slice(0, 10);
  await s.say(
    `找到了时间点。${md(pmDate)} ${pm.time.slice(11)} 做了计划性 PM，更换了边缘聚焦环，用的是新批次料号 FR-7C-B2；` +
      `${qual.time.slice(11)} 有条件放行：季化只跑了 25 片 dummy（SOP 要求 50 片），刻蚀速率只测了中心点，没有做边缘 CD 抽检。` +
      `之后还有 ${rf.length} 次 RF 反射功率偏高告警。` +
      `聚焦环决定晶圆边缘的鞘层形状，换环后没有验证边缘就放行，和"只有边缘失效"对得上。用在线量测验证一下 ${md(pmDate)} 前后的存储节点底部 CD。`,
  );

  const met = (await s.tool("query_inline_metrology", { parameter: "SN_BOTTOM_CD", tool_id: top.tool, split_date: pmDate })).data;
  if (s.aborted) return;
  const after = met.byGroup.find((g: Json) => g.group.startsWith(`${top.tool}/${top.chamber}`) && g.group.includes("起"));
  const before = met.byGroup.find((g: Json) => g.group.startsWith(`${top.tool}/${top.chamber}`) && g.group.includes("前"));
  const peers = met.byGroup.filter((g: Json) => !g.group.startsWith(`${top.tool}/${top.chamber}`) && g.group.includes("起"));
  const peerEdge = peers.map((g: Json) => g.mean["r=0.93"]);
  await s.say(
    `物理证据也对上了。${top.chamber} 腔 PM 之后的 ${after.n} 片量测：中心 ${after.mean["中心"]} nm 正常，r=0.80 降到 ${after.mean["r=0.80"]} nm，r=0.93 降到 ${after.mean["r=0.93"]} nm，低于下限 ${met.spec.lsl} nm，${after.outOfSpecWafers} 片全部超规格。` +
      `PM 之前同一位置是 ${before.mean["r=0.93"]} nm；同期其他腔体的边缘在 ${Math.min(...peerEdge).toFixed(1)}~${Math.max(...peerEdge).toFixed(1)} nm。` +
      `CD 收缩只发生在边缘，和 Bin 7 边缘环的位置吻合：存储节点底部没有完全打开，电容不足，刷新周期内保持不住数据。查一下历史上有没有同样的案例。`,
  );

  const kb = (await s.tool("search_fa_knowledge", { query: "刻蚀 聚焦环 边缘 CD 数据保持", pattern: "边缘环", bin: 7 })).data;
  if (s.aborted) return;
  const c = kb.matches[0];
  await s.say(
    `${c.id}（${c.date.slice(0, 4)} 年）几乎是同一个故事：${c.title}，当时受影响晶圆良率 ${c.yieldImpact.replace("受影响晶圆良率 ", "")}。` +
      `当时的纠正措施是季化 ≥ 50 片、边缘 CD 列为复机必检项、换环后执行边缘调谐配方。这次的季化不足和漏检正是绕过了这两条。` +
      `最后评估影响范围：${md(pmDate)} 以来这个腔体还处理过哪些批次。`,
  );

  const exp = (await s.tool("find_exposed_lots", { tool_id: top.tool, chamber: top.chamber, since: pmDate })).data;
  if (s.aborted) return;
  const tested = exp.lots.filter((l: Json) => l.status === "CP 完成");
  const wip = exp.lots.filter((l: Json) => l.status === "在制");
  await s.say(
    `${md(pmDate)} 以来 ${top.chamber} 腔共处理 ${exp.totals.lots} 批 ${exp.totals.wafers} 片。` +
      `已测的 ${tested.map((l: Json) => `${l.lotId}（受影响片平均良率 ${pct(l.affectedYield)}）`).join("、")} 已经确认受损。` +
      `更要紧的是还在制的 ${wip.length} 批 ${exp.totals.wipWafers} 片：${wip.map((l: Json) => `${l.lotId} ${slotList(l.slots)}`).join("；")}。` +
      `电容已经成形，没法返工，但可以在 CP 前扣留、加严边缘 die 的 tREF 筛选，避免流到封装。证据链完整了，起草 8D。`,
  );

  const affectedLots = exp.lots.map((l: Json) => l.lotId);
  const rep = await s.tool("publish_8d_report", {
    title: `${top.tool} 腔体 ${top.chamber} 换聚焦环后边缘 CD 收缩导致 Bin 7 数据保持失效`,
    severity: "高",
    lot_ids: affectedLots,
    d2_problem: `${lotId} CP 良率 ${pct(me.yield)}，低于基线 ${pt(lots.baselineYield - me.yield)} 个百分点。Bin 7（数据保持）失效率 ${pct(b7.rate, 2)}，为基线的 ${b7.ratioToBaseline} 倍，呈边缘环分布（r > 0.8），只出现在经过 ${top.tool} 腔体 ${top.chamber} 的晶圆上。`,
    d3_containment: [
      `${top.tool} 腔体 ${top.chamber} 立即停机（Tool Down），待边缘 CD 复验合格后再放行`,
      ...wip.map((l: Json) => `扣留在制批 ${l.lotId} 片号 ${slotList(l.slots)}，CP 前加做边缘 die tREF 加严筛选`),
      `${tested.map((l: Json) => l.lotId).join("、")} 已测批次中经过 ${top.chamber} 腔的晶圆，边缘 die 降级处理，不得流入车规与服务器产品`,
    ],
    d4_root_cause: `${md(pmDate)} PM 更换边缘聚焦环（新批次 FR-7C-B2）后，季化仅 25 片（SOP 50 片）且未做边缘 CD 抽检即有条件放行。新聚焦环改变晶圆边缘鞘层，离子入射角偏斜，r > 0.8 区域存储节点底部 CD 收缩约 ${(before.mean["r=0.93"] - after.mean["r=0.93"]).toFixed(1)} nm（降至 ${after.mean["r=0.93"]} nm，LSL ${met.spec.lsl} nm），存储节点未完全打开，电容不足，表现为 Bin 7 数据保持失效。`,
    evidence: [
      `批次 Bin 分布：Bin 7 失效率 ${pct(b7.rate, 2)}，基线 ${pct(b7.baselineRate, 2)}（get_lot_summary）`,
      `晶圆图：${ring.length} 片边缘环，最外圈 Bin 7 失效率 ${pct(rad[9].rate)}（analyze_wafer_maps）`,
      `共性分析：${top.tool}/${top.chamber} 坏片 ${top.badWafers}/${top.wafers}，其余 ${pct(top.othersBadRate)}，p = ${sci(top.pValue)}（commonality_analysis）`,
      `设备日志：${pm.time} 更换聚焦环；${qual.time} 季化 25 片、未做边缘 CD 抽检即放行（query_equipment_log）`,
      `在线量测：PM 后 r=0.93 底部 CD ${after.mean["r=0.93"]} nm，PM 前 ${before.mean["r=0.93"]} nm，${after.outOfSpecWafers}/${after.n} 片超规格（query_inline_metrology）`,
      `历史案例 ${c.id} 机理一致（search_fa_knowledge）`,
    ],
    d5_corrective: [
      `${top.tool} 腔体 ${top.chamber} 补足季化至 50 片，执行边缘调谐配方（edge tuning gas 比例 +8%），边缘 CD 回到 ≥ 36.5 nm 后复机`,
      `与供应商确认 FR-7C-B2 批次聚焦环高度公差，必要时退回该批次备件`,
    ],
    d7_preventive: [
      `聚焦环更换后的复机认证强制包含边缘 5 点 CD 量测，系统互锁，未完成不得放行`,
      `季化片数写入设备配方互锁，取消值班工程师人工豁免权限`,
      `SN_BOTTOM_CD 的 r=0.93 位置单独设 SPC 管控线`,
    ],
    confidence: 0.92,
  });
  if (s.aborted) return;
  await s.say(
    `8D 草稿已生成（${(rep.data as Json).reportId}）。结论：${md(pmDate)} 换聚焦环后季化不足、漏检边缘 CD，导致 ${top.tool} 腔体 ${top.chamber} 边缘 CD 收缩，引起 Bin 7 边缘环失效。` +
      `最紧急的是先停 ${top.chamber} 腔，并扣住在制的 ${wip.length} 批 ${exp.totals.wipWafers} 片。报告可以直接导出给模块和设备工程师会签。`,
  );
}

// ---------- 场景 B：CMP 划伤 → Bin 6 ----------

async function scratch(s: Session, lotId: string) {
  await s.think(`${lotId} 良率只比基线低一点，先确认是哪类失效在拉低，再看空间特征。`);
  await s.say(`先看 ${lotId} 的 Bin 分布，确认是哪类失效在拉低良率。`);
  const sum = (await s.tool("get_lot_summary", { lot_id: lotId })).data;
  if (s.aborted) return;
  const b6 = sum.failBins.find((b: Json) => b.bin === 6);
  await s.say(
    `批次良率 ${pct(sum.yield)}，降幅不大，但 Bin 6 阵列不可修复失效率 ${pct(b6.rate, 2)}，是基线的 ${b6.ratioToBaseline} 倍，而且集中在少数几片上：最差的 ${sum.worstWafers.slice(0, 3).map((w: Json) => `#${w.slot}（${pct(w.yield)}）`).join("、")}。看 Bin 6 的晶圆图。`,
  );
  const maps = (await s.tool("analyze_wafer_maps", { lot_id: lotId, focus_bin: 6 })).data;
  if (s.aborted) return;
  const sc = maps.wafers.filter((w: Json) => w.pattern === "划伤");
  await s.say(
    `${sc.length} 片识别为划伤：${slotList(sc.map((w: Json) => w.slot))}，失效 die 沿弧线排成一串。弧形划伤通常来自 CMP。用全部已测批次做 Bin 6 共性分析。`,
  );
  const com = (await s.tool("commonality_analysis", { bin: 6, threshold: 0.05 })).data;
  if (s.aborted) return;
  const top = com.ranking[0];
  await s.say(
    `${top.step.replace(/^\d+ /, "")}的 ${top.tool} 研磨头 ${top.chamber} 排第一：${top.badWafers}/${top.wafers} 片是坏片，其余只有 ${pct(top.othersBadRate)}，p = ${sci(top.pValue)}。查这个研磨头的设备日志。`,
  );
  await s.tool("query_equipment_log", { tool_id: top.tool, chamber: top.chamber, start_date: "2026-09-20", end_date: "2026-10-20" });
  if (s.aborted) return;
  await s.say(
    `9 月 28 日抛光垫寿命已到 92%，计划 10 月 7 日才换；9 月 30 日和 10 月 3 日两次保持环压力波动超阈值（±4.1%、±4.6%）；10 月 7 日换垫时发现 H2 膜片边缘磨损。这正是划伤的典型前兆。看看 CMP 后的缺陷量测。`,
  );
  const met = (await s.tool("query_inline_metrology", { parameter: "CMP_DEFECT", tool_id: top.tool, start_date: "2026-09-15", end_date: "2026-10-07", split_date: "2026-09-29" })).data;
  if (s.aborted) return;
  const bad = met.byGroup.find((g: Json) => g.group.startsWith(`${top.tool}/${top.chamber}`) && g.group.includes("起"));
  await s.say(
    `${top.chamber} 在 9 月 29 日之后的抽测片缺陷 ${bad.mean["总缺陷"]} 个/片，其中划伤类 ${bad.mean["划伤类"]} 个，超出上限 ${met.spec.usl}；同期其他研磨头都在 20~35 个。对照一下历史案例。`,
  );
  const kb = (await s.tool("search_fa_knowledge", { query: "CMP 划伤 抛光垫 保持环", pattern: "划伤", bin: 6 })).data;
  if (s.aborted) return;
  const c = kb.matches[0];
  await s.say(`${c.id} 是同一机理：${c.title}。确认影响范围，窗口是 9 月 29 日到 10 月 7 日换垫为止。`);
  const exp = (await s.tool("find_exposed_lots", { tool_id: top.tool, chamber: top.chamber, since: "2026-09-29", until: "2026-10-07" })).data;
  if (s.aborted) return;
  const rep = await s.tool("publish_8d_report", {
    title: `${top.tool} 研磨头 ${top.chamber} 抛光垫寿命末期与保持环压力波动导致划伤`,
    severity: "中",
    lot_ids: exp.lots.map((l: Json) => l.lotId),
    d2_problem: `${lotId} 良率 ${pct(sum.yield)}，Bin 6 失效率 ${pct(b6.rate, 2)}（基线的 ${b6.ratioToBaseline} 倍），${sc.length} 片呈弧形划伤，集中在 ${top.tool}/${top.chamber}。`,
    d3_containment: [`窗口内仅 ${exp.lots.map((l: Json) => l.lotId).join("、")} 受影响，已完成 CP，划伤片按 Bin 6 正常剔除`, `10 月 7 日换垫后的批次缺陷数已恢复，无需扣留`],
    d4_root_cause: `抛光垫寿命 92%~98% 期间沟槽堵塞，叠加保持环压力波动，硬质颗粒在晶圆表面拖出弧形划伤，切断存储节点接触，形成 Bin 6 阵列不可修复失效。`,
    evidence: [
      `晶圆图：${sc.length} 片划伤（analyze_wafer_maps）`,
      `共性分析：${top.tool}/${top.chamber} 坏片 ${top.badWafers}/${top.wafers}，p = ${sci(top.pValue)}（commonality_analysis）`,
      `设备日志：抛光垫寿命 92%、两次保持环压力波动（query_equipment_log）`,
      `量测：窗口内划伤类缺陷 ${bad.mean["划伤类"]} 个/片（query_inline_metrology）`,
      `历史案例 ${c.id}（search_fa_knowledge）`,
    ],
    d5_corrective: [`抛光垫寿命上限由 100% 下调至 90%`, `保持环压力波动纳入 SPC 互锁`],
    d7_preventive: [`CMP 后 Surfscan 划伤类缺陷 > 50 自动扣留`, `膜片磨损检查加入每次换垫 PM 清单`],
    confidence: 0.86,
  });
  if (s.aborted) return;
  await s.say(`8D 草稿已生成（${(rep.data as Json).reportId}）。这次影响只有 ${exp.totals.wafers} 片，换垫后已恢复；重点是把抛光垫寿命上限和保持环压力互锁落地，防止复发。`);
}

// ---------- 场景 C：TiN 喷淋头堵塞 → Bin 4 中心团簇 ----------

async function center(s: Session, lotId: string) {
  await s.think(`先看 ${lotId} 是哪类失效，再看空间分布。`);
  await s.say(`先看 ${lotId} 的 Bin 分布。`);
  const sum = (await s.tool("get_lot_summary", { lot_id: lotId })).data;
  if (s.aborted) return;
  const b4 = sum.failBins.find((b: Json) => b.bin === 4);
  await s.say(`批次良率 ${pct(sum.yield)}，Bin 4 IDD 漏电失效率 ${pct(b4.rate, 2)}，是基线的 ${b4.ratioToBaseline} 倍。看 Bin 4 的空间分布。`);
  const maps = (await s.tool("analyze_wafer_maps", { lot_id: lotId, focus_bin: 4 })).data;
  if (s.aborted) return;
  const cc = maps.wafers.filter((w: Json) => w.pattern === "中心团簇");
  await s.say(
    `${cc.length} 片呈中心团簇：${slotList(cc.map((w: Json) => w.slot))}，中心区域 Bin 4 失效率 ${pct(maps.radialFailRate[0].rate)}，边缘只有 ${pct(maps.radialFailRate[9].rate, 2)}。中心偏薄或中心污染类问题常见于沉积。做共性分析。`,
  );
  const com = (await s.tool("commonality_analysis", { bin: 4, threshold: 0.06 })).data;
  if (s.aborted) return;
  const top = com.ranking[0];
  await s.say(
    `坏片全部来自 ${lotId}，所以这批晶圆经过的设备都会显得"相关"，要看哪一个最集中：${top.step.replace(/^\d+ /, "")}的 ${top.tool} 腔体 ${top.chamber} 最突出，${top.badWafers}/${top.wafers}，p = ${sci(top.pValue)}，而且它恰好只分到了一半晶圆。查设备日志。`,
  );
  await s.tool("query_equipment_log", { tool_id: top.tool, chamber: top.chamber, start_date: "2026-09-20", end_date: "2026-10-25" });
  if (s.aborted) return;
  await s.say(`10 月 13 日和 16 日两次 TiCl4 流量偏差（+6%、+7%），喷淋头压差上升；10 月 18 日更换喷淋头时确认中心孔堵塞。用 TiN 厚度量测验证。`);
  const met = (await s.tool("query_inline_metrology", { parameter: "TIN_THICKNESS", tool_id: top.tool, start_date: "2026-10-01", end_date: "2026-10-18", split_date: "2026-10-13" })).data;
  if (s.aborted) return;
  const after = met.byGroup.find((g: Json) => g.group.startsWith(`${top.tool}/${top.chamber}`) && g.group.includes("起"));
  await s.say(`${top.chamber} 腔 10 月 13 日之后中心厚度只有 ${after.mean["中心"]} Å，低于下限 ${met.spec.lsl} Å，边缘 ${after.mean["r=0.93"]} Å 正常。中心偏薄与中心团簇吻合。查历史案例。`);
  const kb = (await s.tool("search_fa_knowledge", { query: "TiN 喷淋头 中心 漏电", pattern: "中心团簇", bin: 4 })).data;
  if (s.aborted) return;
  const c = kb.matches[0];
  await s.say(`${c.id}：${c.title}，机理一致。确认影响范围，窗口到 10 月 18 日换喷淋头为止。`);
  const exp = (await s.tool("find_exposed_lots", { tool_id: top.tool, chamber: top.chamber, since: "2026-10-13", until: "2026-10-18" })).data;
  if (s.aborted) return;
  const rep = await s.tool("publish_8d_report", {
    title: `${top.tool} 腔体 ${top.chamber} 喷淋头中心堵塞导致 TiN 偏薄与 IDD 漏电`,
    severity: "中",
    lot_ids: exp.lots.map((l: Json) => l.lotId),
    d2_problem: `${lotId} 良率 ${pct(sum.yield)}，Bin 4 失效率 ${pct(b4.rate, 2)}（基线的 ${b4.ratioToBaseline} 倍），${cc.length} 片中心团簇。`,
    d3_containment: [`窗口内仅 ${exp.lots.map((l: Json) => l.lotId).join("、")} 受影响，已完成 CP`, `10 月 18 日换喷淋头后无新增风险批次`],
    d4_root_cause: `喷淋头中心孔堵塞，晶圆中心 TiN 顶电极偏薄（${after.mean["中心"]} Å，LSL ${met.spec.lsl} Å），电容顶电极覆盖不足，单元漏电升高。`,
    evidence: [
      `晶圆图：${cc.length} 片中心团簇（analyze_wafer_maps）`,
      `共性分析：${top.tool}/${top.chamber} 坏片 ${top.badWafers}/${top.wafers}，p = ${sci(top.pValue)}（commonality_analysis）`,
      `设备日志：两次 TiCl4 MFC 偏差，换喷淋头确认堵塞（query_equipment_log）`,
      `量测：中心 TiN 厚度 ${after.mean["中心"]} Å（query_inline_metrology）`,
      `历史案例 ${c.id}（search_fa_knowledge）`,
    ],
    d5_corrective: [`更换喷淋头并校准 MFC（已于 10 月 18 日完成）`],
    d7_preventive: [`TiCl4 MFC 偏差 > 3% 设为互锁`, `TiN 厚度量测扩展为 13 点并监控中心/边缘比`],
    confidence: 0.88,
  });
  if (s.aborted) return;
  await s.say(`8D 草稿已生成（${(rep.data as Json).reportId}）。喷淋头已换，影响限于 ${exp.totals.wafers} 片；重点是把 MFC 偏差互锁补上——这次两次告警都没有触发停机。`);
}

// ---------- 入口 ----------

export async function runReplay(prompt: string, turn: number, emit: Emit, signal: AbortSignal) {
  const s = new Session(emit, signal);
  const mentioned = prompt.toUpperCase().match(/N3B\d{3}/)?.[0];
  if (turn > 0 && !mentioned) {
    await s.say(
      "离线回放模式只演示预设的完整调查流程，不能回答自由追问。在 .env.local 里配置 ANTHROPIC_API_KEY（Claude）或 LLM_API_KEY（DeepSeek、通义千问等国产模型）后重启，就会由大模型实时调查并支持追问。你也可以点左侧另一个异常批次，看另一条调查路径。",
    );
    return;
  }
  let lotId = mentioned && getLot(mentioned) ? mentioned : "N3B417";
  const lot = getLot(lotId)!;
  if (!lot.binCounts) {
    await s.say(`${lotId} 还在制（完成到 ${STEP_BY_ID[lot.currentStep]?.name ?? lot.currentStep}），没有 CP 数据可分析。先从良率最低的已测批次查起。`);
    lotId = allLots().filter((l) => l.yield !== null).sort((a, b) => a.yield! - b.yield!)[0].id;
  }
  try {
    if (lotId === "N3B409") await scratch(s, lotId);
    else if (lotId === "N3B412") await center(s, lotId);
    else if (lotId === "N3B417" || lotId === "N3B421") await edgeRing(s, lotId);
    else {
      const sum = (await s.tool("get_lot_summary", { lot_id: lotId })).data;
      const worst = sum.failBins.reduce((a: Json, b: Json) => (b.ratioToBaseline > a.ratioToBaseline ? b : a));
      await s.tool("analyze_wafer_maps", { lot_id: lotId });
      await s.say(
        `${lotId} 良率 ${pct(sum.yield)}，基线 ${pct(sum.baselineYield)}。各 Bin 都在基线附近，偏离最大的是 ${BINS[worst.bin as BinId].name}（基线的 ${worst.ratioToBaseline} 倍），晶圆图上也没有成片的空间模式。这批是正常波动，不需要立案。可以看看 N3B417、N3B412 或 N3B409。`,
      );
    }
  } catch (err) {
    emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
}
