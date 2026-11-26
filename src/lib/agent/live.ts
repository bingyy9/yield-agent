// 在线模式：Claude 手写工具循环（流式 + 自适应思考 + 服务端降级）。
import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "./prompt";
import { runTool, toolDefinitions } from "./tools";
import type { AgentEvent } from "./types";

type Msg = Anthropic.Beta.BetaMessageParam;
type Emit = (e: AgentEvent) => void;

export const LIVE_MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-5";
const MAX_TURNS = 24;

function isToolJsonError(err: unknown) {
  return (
    err instanceof Anthropic.AnthropicError &&
    !(err instanceof Anthropic.APIError) &&
    err.message.startsWith("Unable to parse tool parameter JSON")
  );
}

export async function runLive(history: Msg[], emit: Emit, signal: AbortSignal) {
  const client = new Anthropic();
  const messages: Msg[] = [...history];
  const tools = toolDefinitions();

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let message: Anthropic.Beta.BetaMessage | null = null;
    for (let attempt = 0; attempt < 3 && !message; attempt++) {
      try {
        const stream = client.beta.messages.stream(
          {
            model: LIVE_MODEL,
            max_tokens: 64000,
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
            thinking: { type: "adaptive", display: "summarized" },
            system: SYSTEM_PROMPT,
            tools,
            messages,
          },
          { signal },
        );
        stream.on("thinking", (delta) => emit({ type: "thinking", delta }));
        stream.on("text", (delta) => emit({ type: "text", delta }));
        stream.on("streamEvent", (event) => {
          if (event.type !== "content_block_start") return;
          const block = event.content_block;
          if (block.type === "tool_use") emit({ type: "tool_start", id: block.id, name: block.name });
          if (block.type === "fallback") emit({ type: "fallback", from: block.from.model, to: block.to.model });
        });
        message = await stream.finalMessage();
      } catch (err) {
        // 只有工具参数 JSON 无法解析时才重试；API 类错误（鉴权、限流等）直接抛出
        if (!isToolJsonError(err) || attempt === 2) throw err;
      }
    }
    if (!message) return;

    messages.push({ role: "assistant", content: message.content });
    const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");

    if (message.stop_reason === "pause_turn") continue;
    if (message.stop_reason === "refusal") {
      emit({ type: "error", message: "模型拒绝继续这次请求。" });
      break;
    }
    if (message.stop_reason === "max_tokens" && toolUses.length) {
      emit({ type: "error", message: "输出达到 max_tokens 上限，工具参数可能不完整，已停止。" });
      break;
    }
    if (!toolUses.length) break;

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      emit({ type: "tool_call", id: tu.id, name: tu.name, input: tu.input });
      const t0 = Date.now();
      const r = runTool(tu.name, tu.input);
      const ms = Date.now() - t0;
      if (r.ok) {
        emit({ type: "tool_result", id: tu.id, name: tu.name, ok: true, summary: r.output.summary, view: r.output.view, ms });
        results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(r.output.forModel) });
      } else {
        emit({ type: "tool_result", id: tu.id, name: tu.name, ok: false, summary: r.message, ms });
        const content =
          r.code === "INVALID_INPUT"
            ? JSON.stringify({ INVALID_JSON: JSON.stringify(tu.input), error: r.message })
            : r.message;
        results.push({ type: "tool_result", tool_use_id: tu.id, content, is_error: true });
      }
    }
    messages.push({ role: "user", content: results });
  }

  emit({ type: "history", messages });
}
