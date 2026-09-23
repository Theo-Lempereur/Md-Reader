/** Présence des modèles Ollama en VRAM. Ollama charge un modèle à la première
 * requête et le garde quelques minutes après la dernière ; on l'aide dans les
 * deux sens :
 *  - préchargement à l'ouverture du dock et à l'activation de l'autocomplétion,
 *    pour que la première réponse ne paie pas le chargement ;
 *  - libération immédiate (`keep_alive: 0`) d'un modèle que ni l'assistant ni
 *    l'autocomplétion n'utilisent plus (désactivation, changement de modèle).
 * LM Studio n'est pas concerné : l'utilisateur y charge ses modèles lui-même. */

import { aiApi } from "./client";
import { activeModel, getAi, subscribeAi } from "./useAi";
import type { AiSettings, ProviderId } from "./types";

export type LocalUse = { provider: ProviderId; model: string };

/** Modèles réellement utilisés par l'assistant et l'autocomplétion (la
 * résolution de cette dernière sert aussi au texte fantôme). */
export function modelsInUse(settings: AiSettings): { chat: LocalUse | null; complete: LocalUse | null } {
  const active = settings.activeProvider;
  const chat = active ? { provider: active, model: activeModel(settings) } : null;
  const ac = settings.autocomplete;
  let complete: LocalUse | null = null;
  if (ac.enabled) {
    const provider = ac.provider ?? (active && active !== "codex" ? active : null);
    if (provider && provider !== "codex") {
      complete = { provider, model: ac.model || activeModel(settings, provider) };
    }
  }
  return { chat, complete };
}

export function preloadLocal(use: LocalUse | null) {
  if (use?.provider !== "ollama" || !use.model.trim()) return;
  aiApi.ollamaResidency(use.model, true).catch(() => {});
}

function wantedOllama(settings: AiSettings): Set<string> {
  const { chat, complete } = modelsInUse(settings);
  const set = new Set<string>();
  for (const u of [chat, complete]) if (u?.provider === "ollama" && u.model.trim()) set.add(u.model.trim());
  return set;
}

// Laisse retomber la saisie d'un nom de modèle avant de décharger quoi que ce soit.
const SETTLE_MS = 1500;

/** Surveille les réglages ; à appeler une fois, réglages chargés. */
export function watchResidency(): () => void {
  let loaded = wantedOllama(getAi().settings);
  let lastSettings = getAi().settings;
  let timer: number | null = null;
  const check = () => {
    timer = null;
    const now = wantedOllama(getAi().settings);
    for (const m of loaded) {
      if (!now.has(m)) aiApi.ollamaResidency(m, false).catch(() => {});
    }
    loaded = now;
  };
  const off = subscribeAi(() => {
    const s = getAi().settings;
    if (s === lastSettings) return;
    lastSettings = s;
    if (timer != null) window.clearTimeout(timer);
    timer = window.setTimeout(check, SETTLE_MS);
  });
  return () => {
    off();
    if (timer != null) window.clearTimeout(timer);
  };
}
