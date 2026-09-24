import { setAiStatusFlag } from "./boot";
import { aiApi } from "./client";
import { getAi, setAi } from "./useAi";
import type { AiStatus, Detection, ProviderId } from "./types";
import { getBridge } from "./actions";

export function providerAvailable(det: Detection | null, keys: string[], p: ProviderId): boolean {
  switch (p) {
    case "codex":
      return !!det?.codex.installed && !!det.codex.loggedIn;
    case "claude":
      return !!det?.claude?.installed && !!det.claude.loggedIn;
    case "ollama":
      return !!det?.ollama.running;
    case "lmstudio":
      return !!det?.lmstudio.running;
    default:
      return keys.includes(p);
  }
}

function publish(status: AiStatus) {
  setAi({ status });
  setAiStatusFlag(status);
  getBridge().setStatus(status);
}

/** Relance la détection (en parallèle côté Rust) et recalcule le statut. */
export async function refreshDetection(): Promise<Detection | null> {
  setAi({ detecting: true });
  try {
    const det = await aiApi.detect();
    setAi({ detection: det, keys: det.keys });
    recomputeStatus();
    return det;
  } catch {
    recomputeStatus();
    return null;
  } finally {
    setAi({ detecting: false });
  }
}

export function recomputeStatus() {
  const { settings, detection, keys } = getAi();
  const p = settings.activeProvider;
  if (!p) return publish("off");
  publish(providerAvailable(detection, keys, p) ? "ready" : "setup");
}
