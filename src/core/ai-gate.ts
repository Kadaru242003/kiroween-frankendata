/**
 * Gates the two AI providers behind the session "AI: Off (fully local)" switch.
 * When the switch is off the gate throws BEFORE delegating, so the real
 * provider (and therefore `fetch`) is never reached: no request to `/api/ai`
 * or `/api/sql`. Callers already treat a provider failure as "fall back to
 * rules" (stitching) or "AI unavailable" (Ask), so nothing else changes.
 */
import type { AiProvider } from "./stitching/types.js";
import type { SqlProvider } from "./chat/types.js";

export interface AiGateState {
  isOn(): boolean;
}

/** The message matches the controller's "unavailable" heuristic. */
export const AI_OFF_ERROR_MESSAGE = "AI is off (unavailable): fully local mode";

export function gateAiProvider(provider: AiProvider, gate: AiGateState): AiProvider {
  return {
    async refine(input) {
      if (!gate.isOn()) throw new Error(AI_OFF_ERROR_MESSAGE);
      return provider.refine(input);
    },
  };
}

export function gateSqlProvider(provider: SqlProvider, gate: AiGateState): SqlProvider {
  return {
    async ask(req) {
      if (!gate.isOn()) throw new Error(AI_OFF_ERROR_MESSAGE);
      return provider.ask(req);
    },
  };
}
