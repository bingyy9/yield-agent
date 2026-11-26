import Anthropic from "@anthropic-ai/sdk";
import { LIVE_MODEL, runLive } from "@/lib/agent/live";
import { runReplay } from "@/lib/agent/replay";
import type { AgentEvent } from "@/lib/agent/types";

export const maxDuration = 300;

interface Body {
  prompt: string;
  history?: Anthropic.Beta.BetaMessageParam[];
  turn?: number;
  forceReplay?: boolean;
}

function describe(err: unknown) {
  if (err instanceof Anthropic.AuthenticationError) return "API key 无效，请检查 .env.local 中的 ANTHROPIC_API_KEY。";
  if (err instanceof Anthropic.RateLimitError) return "请求过于频繁，被限流了，稍后再试。";
  if (err instanceof Anthropic.NotFoundError) return `模型 ${LIVE_MODEL} 不可用，请检查 CLAUDE_MODEL。`;
  if (err instanceof Anthropic.APIError) return `Claude API 错误（${err.status ?? "网络"}）：${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

export async function POST(request: Request) {
  const body = (await request.json()) as Body;
  const prompt = (body.prompt ?? "").trim();
  if (!prompt) return Response.json({ error: "prompt 不能为空" }, { status: 400 });

  const live = !!process.env.ANTHROPIC_API_KEY && !body.forceReplay;
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
      emit({ type: "mode", mode: live ? "live" : "replay", model: live ? LIVE_MODEL : "离线回放" });
      try {
        if (live) {
          const history = [...(body.history ?? []), { role: "user" as const, content: prompt }];
          await runLive(history, emit, request.signal);
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
