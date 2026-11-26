import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { COMPAT, runCompat } from "@/lib/agent/compat";
import { LIVE_MODEL, runLive } from "@/lib/agent/live";
import { runReplay } from "@/lib/agent/replay";
import type { AgentEvent } from "@/lib/agent/types";

export const maxDuration = 300;

interface Body {
  prompt: string;
  history?: unknown[];
  turn?: number;
  forceReplay?: boolean;
}

function describe(err: unknown) {
  if (err instanceof Anthropic.AuthenticationError) return "API key 无效，请检查 .env.local 中的 ANTHROPIC_API_KEY。";
  if (err instanceof Anthropic.RateLimitError) return "请求过于频繁，被限流了，稍后再试。";
  if (err instanceof Anthropic.NotFoundError) return `模型 ${LIVE_MODEL} 不可用，请检查 CLAUDE_MODEL。`;
  if (err instanceof Anthropic.APIError) return `Claude API 错误（${err.status ?? "网络"}）：${err.message}`;
  if (err instanceof OpenAI.AuthenticationError) return "API key 无效，请检查 .env.local 中的 LLM_API_KEY。";
  if (err instanceof OpenAI.RateLimitError) return "请求过于频繁或额度不足，稍后再试，或到模型控制台检查余额。";
  if (err instanceof OpenAI.NotFoundError) return `模型 ${COMPAT?.model} 不可用，请检查 LLM_MODEL 和 LLM_BASE_URL。`;
  if (err instanceof OpenAI.APIError) return `模型 API 错误（${err.status ?? "网络"}）：${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

// 选后端：配了 ANTHROPIC_API_KEY 用 Claude；否则配了 LLM_API_KEY 用国产模型；都没有就离线回放
function backend(forceReplay?: boolean) {
  if (forceReplay) return { kind: "replay" as const, model: "离线回放" };
  if (process.env.ANTHROPIC_API_KEY) return { kind: "claude" as const, model: LIVE_MODEL };
  if (COMPAT) return { kind: "compat" as const, model: COMPAT.model };
  return { kind: "replay" as const, model: "离线回放" };
}

export async function POST(request: Request) {
  const body = (await request.json()) as Body;
  const prompt = (body.prompt ?? "").trim();
  if (!prompt) return Response.json({ error: "prompt 不能为空" }, { status: 400 });

  const be = backend(body.forceReplay);
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: AgentEvent) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
        } catch {
          // 客户端已断开
        }
      };
      emit({ type: "mode", mode: be.kind === "replay" ? "replay" : "live", model: be.model });
      try {
        if (be.kind === "claude") {
          const history = [...((body.history ?? []) as Anthropic.Beta.BetaMessageParam[]), { role: "user" as const, content: prompt }];
          await runLive(history, emit, request.signal);
        } else if (be.kind === "compat") {
          const history = [...((body.history ?? []) as OpenAI.Chat.Completions.ChatCompletionMessageParam[]), { role: "user" as const, content: prompt }];
          await runCompat(history, emit, request.signal);
        } else {
          await runReplay(prompt, body.turn ?? 0, emit, request.signal);
        }
      } catch (err) {
        if (!request.signal.aborted) emit({ type: "error", message: describe(err) });
      }
      emit({ type: "done" });
      try {
        controller.close();
      } catch {}
    },
  });

  return new Response(stream, {
    // X-Accel-Buffering: 让 Nginx 反向代理不要攒着整段响应再发，否则流式效果会消失
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
}
