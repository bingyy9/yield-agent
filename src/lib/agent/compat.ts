// 在线模式（国产模型）：OpenAI 兼容协议的手写工具循环，适用于 DeepSeek、通义千问、智谱 GLM、腾讯混元等。
// 发出的事件和 live.ts 完全一样，界面不需要区分用的是哪家模型。
import OpenAI from "openai";
import { SYSTEM_PROMPT } from "./prompt";
import { runTool, toolDefinitions } from "./tools";
import type { AgentEvent } from "./types";

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type Emit = (e: AgentEvent) => void;

// 部分厂商（DeepSeek 思考模式、通义千问、GLM）会在标准字段之外返回思考过程 reasoning_content
type AssistantMsg = OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam & { reasoning_content?: string };
type Call = { id: string; name: string; args: string };

const MAX_TURNS = 24;

// 各家的默认接口地址和模型。模型名以各家控制台为准，可以用 LLM_MODEL 覆盖。
// 通义千问的兼容接口不支持「工具 + 流式」同时使用，所以默认关闭流式。
const PRESETS: Record<string, { baseURL: string; model: string; stream: boolean }> = {
  deepseek: { baseURL: "https://api.deepseek.com", model: "deepseek-chat", stream: true },
  qwen: { baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", stream: false },
  glm: { baseURL: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.6", stream: true },
  hunyuan: { baseURL: "https://api.hunyuan.cloud.tencent.com/v1", model: "hunyuan-turbos-latest", stream: true },
};

function loadConfig() {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) return null;
  const provider = (process.env.LLM_PROVIDER ?? "deepseek").toLowerCase();
  const preset = PRESETS[provider];
  const baseURL = process.env.LLM_BASE_URL ?? preset?.baseURL;
  const model = process.env.LLM_MODEL ?? preset?.model;
  if (!baseURL || !model) {
    console.error(`LLM_PROVIDER=${provider} 没有预设，请同时配置 LLM_BASE_URL 和 LLM_MODEL。已退回离线回放。`);
    return null;
  }
  const stream = process.env.LLM_STREAM ? process.env.LLM_STREAM !== "false" : (preset?.stream ?? true);
  const maxTokens = Number(process.env.LLM_MAX_TOKENS ?? 8192);
  return { provider, apiKey, baseURL, model, stream, maxTokens };
}

export const COMPAT = loadConfig();

function openaiTools(): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return toolDefinitions().map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

/** 调一次模型，返回这一步的完整回复；流式时边收边发 text / thinking / tool_start 事件。 */
async function step(client: OpenAI, messages: Msg[], emit: Emit, signal: AbortSignal) {
  const cfg = COMPAT!;
  const body = {
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    messages: [{ role: "system" as const, content: SYSTEM_PROMPT }, ...messages],
    tools: openaiTools(),
  };
  let text = "";
  let reasoning = "";
  const calls: Call[] = [];
  let finish: string | null = null;

  if (!cfg.stream) {
    const res = await client.chat.completions.create({ ...body, stream: false }, { signal });
    const choice = res.choices[0];
    const msg = choice.message as typeof choice.message & { reasoning_content?: string };
    reasoning = msg.reasoning_content ?? "";
    text = msg.content ?? "";
    if (reasoning) emit({ type: "thinking", delta: reasoning });
    if (text) emit({ type: "text", delta: text });
    for (const tc of msg.tool_calls ?? []) {
      if (tc.type !== "function") continue;
      calls.push({ id: tc.id, name: tc.function.name, args: tc.function.arguments });
      emit({ type: "tool_start", id: tc.id, name: tc.function.name });
    }
    finish = choice.finish_reason;
  } else {
    const stream = await client.chat.completions.create({ ...body, stream: true }, { signal });
    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;
      const delta = choice.delta as typeof choice.delta & { reasoning_content?: string };
      if (delta.reasoning_content) {
        reasoning += delta.reasoning_content;
        emit({ type: "thinking", delta: delta.reasoning_content });
      }
      if (delta.content) {
        text += delta.content;
        emit({ type: "text", delta: delta.content });
      }
      // 工具调用按 index 分片到达：第一片带 id 和工具名，后面的片只补 arguments
      for (const tc of delta.tool_calls ?? []) {
        const i = tc.index ?? calls.length;
        if (!calls[i]) {
          calls[i] = { id: tc.id ?? `call_${Date.now()}_${i}`, name: tc.function?.name ?? "", args: "" };
          if (calls[i].name) emit({ type: "tool_start", id: calls[i].id, name: calls[i].name });
        } else if (!calls[i].name && tc.function?.name) {
          calls[i].name = tc.function.name;
          emit({ type: "tool_start", id: calls[i].id, name: calls[i].name });
        }
        calls[i].args += tc.function?.arguments ?? "";
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  }
  return { text, reasoning, calls: calls.filter(Boolean), finish };
}

export async function runCompat(history: Msg[], emit: Emit, signal: AbortSignal) {
  const cfg = COMPAT!;
  const client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL });
  const messages: Msg[] = [...history];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const { text, reasoning, calls, finish } = await step(client, messages, emit, signal);

    const assistant: AssistantMsg = { role: "assistant", content: text || null };
    if (calls.length) {
      assistant.tool_calls = calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args || "{}" } }));
    }
    // DeepSeek 思考模式要求：同一轮工具调用过程中，把 reasoning_content 原样带回
    if (reasoning) assistant.reasoning_content = reasoning;
    messages.push(assistant);

    if (!calls.length) break;
    if (finish === "length") {
      emit({ type: "error", message: "输出达到 max_tokens 上限，工具参数可能不完整，已停止。可以调大 LLM_MAX_TOKENS。" });
      break;
    }

    for (const c of calls) {
      let input: unknown;
      try {
        input = c.args.trim() ? JSON.parse(c.args) : {};
      } catch {
        // 参数不是合法 JSON：把原文和错误还给模型，让它自己重发
        emit({ type: "tool_call", id: c.id, name: c.name, input: c.args });
        emit({ type: "tool_result", id: c.id, name: c.name, ok: false, summary: "参数不是合法 JSON", ms: 0 });
        messages.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify({ INVALID_JSON: c.args, error: "参数不是合法 JSON，请重新调用" }) });
        continue;
      }
      emit({ type: "tool_call", id: c.id, name: c.name, input });
      const t0 = Date.now();
      const r = runTool(c.name, input);
      const ms = Date.now() - t0;
      if (r.ok) {
        emit({ type: "tool_result", id: c.id, name: c.name, ok: true, summary: r.output.summary, view: r.output.view, ms });
        messages.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(r.output.forModel) });
      } else {
        emit({ type: "tool_result", id: c.id, name: c.name, ok: false, summary: r.message, ms });
        messages.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify({ error: r.message }) });
      }
    }
  }

  // 这一轮结束：思考过程不再需要，去掉后再交给浏览器保管（DeepSeek 不接受新一轮里带旧的 reasoning_content）
  const clean = messages.map((m) => {
    if (m.role !== "assistant" || !("reasoning_content" in m)) return m;
    const { reasoning_content: _drop, ...rest } = m as AssistantMsg;
    void _drop;
    return rest;
  });
  emit({ type: "history", messages: clean });
}
