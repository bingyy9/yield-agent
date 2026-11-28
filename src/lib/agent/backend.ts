import { COMPAT } from "./compat";
import { LIVE_MODEL } from "./live";

/** 在线模式用哪家模型：配了 ANTHROPIC_API_KEY 用 Claude，否则配了 LLM_API_KEY 用国产模型，都没有返回 null（只能离线回放）。 */
export function liveBackend() {
  if (process.env.ANTHROPIC_API_KEY) return { kind: "claude" as const, model: LIVE_MODEL };
  if (COMPAT) return { kind: "compat" as const, model: COMPAT.model };
  return null;
}
