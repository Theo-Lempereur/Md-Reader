/** Amorce du module IA, seule partie chargée au démarrage.
 *
 * Elle lit l'état LOCAL (`ai_status` : fichier de réglages + présence des
 * clés, aucune requête réseau) et expose un petit bus d'événements pour que
 * l'application parle au chunk IA sans l'importer. Le reste du module est
 * chargé à la demande (`lazy(() => import("./ai"))`). */

import { invoke } from "@tauri-apps/api/core";
import type {
  AiBootInfo,
  AiStatus,
  QuickActionKind,
  SlashAiKind,
} from "./types";

export async function loadAiBoot(): Promise<AiBootInfo> {
  try {
    return await invoke<AiBootInfo>("ai_status");
  } catch {
    // Hors Tauri (dev navigateur) ou module absent.
    return { compiled: false };
  }
}

/** Statut initial : `off` tant que l'utilisateur n'a choisi aucun fournisseur. */
export function initialStatus(boot: AiBootInfo): AiStatus {
  if (!boot.compiled) return "off";
  const s = boot.settings as { activeProvider?: unknown } | null | undefined;
  return s && typeof s.activeProvider === "string" ? "setup" : "off";
}

/* ------------------------------------------------------------------ */
/* Bus                                                                 */
/* ------------------------------------------------------------------ */

export type AiBusEvents = {
  "quick-action": { kind: QuickActionKind };
  slash: { kind: SlashAiKind };
  "open-dock": Record<string, never>;
};

const bus = new EventTarget();
let currentStatus: AiStatus = "off";

export function emitAi<K extends keyof AiBusEvents>(type: K, detail: AiBusEvents[K]) {
  bus.dispatchEvent(new CustomEvent(type, { detail }));
}

export function onAi<K extends keyof AiBusEvents>(
  type: K,
  handler: (detail: AiBusEvents[K]) => void,
): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<AiBusEvents[K]>).detail);
  bus.addEventListener(type, listener);
  return () => bus.removeEventListener(type, listener);
}

/** Lu par les commandes slash (`isEnabled`) sans dépendre de React. */
export function setAiStatusFlag(status: AiStatus) {
  currentStatus = status;
}

export function isAiReady(): boolean {
  return currentStatus === "ready";
}
