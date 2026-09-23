/** État global du module IA : réglages, détection, conversations (une par
 * onglet), patchs en relecture et historique des modifications. Petit store
 * externe + `useSyncExternalStore`, pour que le dock, le panneau de diff et
 * les réglages partagent le même état sans remonter dans `App`. */

import { useSyncExternalStore } from "react";
import { aiApi } from "./client";
import type {
  AiPatch,
  AiSettings,
  AiStatus,
  Conversation,
  Detection,
  HistoryEntry,
  ProviderId,
  UiMessage,
} from "./types";

export const PROVIDERS: { id: ProviderId; label: string; kind: "codex" | "key" | "local" }[] = [
  { id: "codex", label: "Codex (ChatGPT)", kind: "codex" },
  { id: "openai", label: "OpenAI", kind: "key" },
  { id: "anthropic", label: "Anthropic", kind: "key" },
  { id: "mistral", label: "Mistral", kind: "key" },
  { id: "openrouter", label: "OpenRouter", kind: "key" },
  { id: "ollama", label: "Ollama", kind: "local" },
  { id: "lmstudio", label: "LM Studio", kind: "local" },
];

export const providerLabel = (id: ProviderId | null | undefined) =>
  PROVIDERS.find((p) => p.id === id)?.label ?? "—";

export const isLocalProvider = (id: ProviderId | null | undefined) =>
  id === "ollama" || id === "lmstudio";

export const DEFAULT_MODELS: Partial<Record<ProviderId, string>> = {
  codex: "default",
  anthropic: "claude-opus-5",
  openai: "gpt-5",
  mistral: "mistral-medium-latest",
};

export const DEFAULT_SETTINGS: AiSettings = {
  version: 1,
  activeProvider: null,
  models: {},
  baseUrls: {},
  contextWindows: {},
  consent: {},
  autocomplete: { enabled: false, provider: null, model: "" },
  benchmarks: {},
  dockWidth: 400,
};

const PROVIDER_IDS = new Set<string>(PROVIDERS.map((p) => p.id));
const isProvider = (v: unknown): v is ProviderId => typeof v === "string" && PROVIDER_IDS.has(v);

function pickRecord<T>(v: unknown, check: (x: unknown) => x is T): Partial<Record<ProviderId, T>> {
  const out: Partial<Record<ProviderId, T>> = {};
  if (!v || typeof v !== "object") return out;
  for (const [k, x] of Object.entries(v)) {
    if (isProvider(k) && check(x)) out[k] = x;
  }
  return out;
}
const isStr = (x: unknown): x is string => typeof x === "string";
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isBool = (x: unknown): x is boolean => typeof x === "boolean";

export function normalizeSettings(value: unknown): AiSettings {
  if (!value || typeof value !== "object") return DEFAULT_SETTINGS;
  const s = value as Record<string, unknown>;
  const ac = (s.autocomplete ?? {}) as Record<string, unknown>;
  const benchmarks: AiSettings["benchmarks"] = {};
  if (s.benchmarks && typeof s.benchmarks === "object") {
    for (const [k, b] of Object.entries(s.benchmarks as Record<string, unknown>)) {
      const r = b as Record<string, unknown>;
      if (r && isNum(r.ttftMs) && isNum(r.tokensPerSec) && isNum(r.at)) {
        benchmarks[k] = { ttftMs: r.ttftMs, tokensPerSec: r.tokensPerSec, at: r.at };
      }
    }
  }
  return {
    version: 1,
    activeProvider: isProvider(s.activeProvider) ? s.activeProvider : null,
    models: pickRecord(s.models, isStr),
    baseUrls: pickRecord(s.baseUrls, isStr),
    contextWindows: pickRecord(s.contextWindows, isNum),
    consent: pickRecord(s.consent, isBool),
    autocomplete: {
      enabled: ac.enabled === true,
      provider: isProvider(ac.provider) ? ac.provider : null,
      model: isStr(ac.model) ? ac.model : "",
    },
    benchmarks,
    dockWidth: isNum(s.dockWidth) ? Math.min(900, Math.max(300, s.dockWidth)) : 400,
  };
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

export type AiStore = {
  status: AiStatus;
  settings: AiSettings;
  keys: string[];
  detection: Detection | null;
  detecting: boolean;
  /** Clé = identifiant d'onglet. */
  conversations: Record<string, Conversation>;
  patches: Record<string, AiPatch>;
  history: HistoryEntry[];
  undoBanner: { entryId: string; until: number } | null;
  notice: { text: string; kind: "info" | "error" } | null;
  /** Requête en cours par onglet (pour le bouton Stop). */
  running: Record<string, { cancel: () => void } | undefined>;
  /** Consentement demandé avant le premier envoi à un fournisseur distant. */
  consentAsk: { provider: ProviderId; summary: string } | null;
  /** Incrémenté pour donner le focus au champ de saisie du dock. */
  focusTick: number;
  /** Téléchargement Ollama en cours : global pour survivre à la fermeture de
   * l'écran de configuration ou au changement d'onglet. */
  pull: { tag: string; status: string; ratio: number | null } | null;
  /** Modèle en cours de mesure (premier token, débit). */
  benching: string | null;
};

let state: AiStore = {
  status: "off",
  settings: DEFAULT_SETTINGS,
  keys: [],
  detection: null,
  detecting: false,
  conversations: {},
  patches: {},
  history: [],
  undoBanner: null,
  notice: null,
  running: {},
  consentAsk: null,
  focusTick: 0,
  pull: null,
  benching: null,
};

const listeners = new Set<() => void>();

export function getAi(): AiStore {
  return state;
}

export function setAi(update: Partial<AiStore> | ((s: AiStore) => Partial<AiStore>)) {
  const patch = typeof update === "function" ? update(state) : update;
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function subscribeAi(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAi<T>(selector: (s: AiStore) => T): T {
  return useSyncExternalStore(subscribeAi, () => selector(state));
}

/* ------------------------------------------------------------------ */
/* Réglages                                                            */
/* ------------------------------------------------------------------ */

let saveTimer: number | null = null;

export function updateSettings(update: (s: AiSettings) => AiSettings) {
  const settings = update(state.settings);
  setAi({ settings });
  if (saveTimer != null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    void aiApi.setSettings(state.settings).catch((e) => notify(`Réglages non enregistrés : ${e}`, "error"));
  }, 250);
}

export function activeModel(settings: AiSettings, provider = settings.activeProvider): string {
  if (!provider) return "";
  return settings.models[provider] ?? DEFAULT_MODELS[provider] ?? "";
}

export function benchKey(p: ProviderId, model: string) {
  return `${p}:${model}`;
}

/** Au-delà de ce délai avant le premier token, l'autocomplétion n'est
 * proposée qu'à la demande (Ctrl+Espace). */
export const AUTO_TTFT_MS = 300;

let noticeTimer: number | null = null;
export function notify(text: string, kind: "info" | "error" = "info") {
  setAi({ notice: { text, kind } });
  if (noticeTimer != null) window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => setAi({ notice: null }), kind === "error" ? 7000 : 3500);
}

/* ------------------------------------------------------------------ */
/* Conversations                                                       */
/* ------------------------------------------------------------------ */

export const newId = (prefix: string) =>
  `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export function getConversation(tabId: string, tabPath?: string): Conversation {
  const existing = state.conversations[tabId];
  if (existing) return existing;
  const conv: Conversation = { id: newId("c"), tabId, tabPath, messages: [] };
  setAi((s) => ({ conversations: { ...s.conversations, [tabId]: conv } }));
  return conv;
}

export function updateConversation(tabId: string, update: (c: Conversation) => Conversation) {
  setAi((s) => {
    const conv = s.conversations[tabId];
    if (!conv) return {};
    return { conversations: { ...s.conversations, [tabId]: update(conv) } };
  });
}

export function updateMessage(tabId: string, messageId: string, update: (m: UiMessage) => UiMessage) {
  updateConversation(tabId, (c) => ({
    ...c,
    messages: c.messages.map((m) => (m.id === messageId ? update(m) : m)),
  }));
}

export function clearConversation(tabId: string) {
  setAi((s) => {
    const conv = s.conversations[tabId];
    if (!conv) return {};
    return {
      conversations: { ...s.conversations, [tabId]: { ...conv, id: newId("c"), messages: [] } },
    };
  });
}

/** Persiste la dernière conversation active (sans les images, trop lourdes). */
export function persistConversation(tabId: string) {
  const conv = state.conversations[tabId];
  if (!conv) return;
  const light = {
    ...conv,
    messages: conv.messages.map((m) => ({
      ...m,
      images: undefined,
      status: m.status === "streaming" ? "cancelled" : m.status,
    })),
  };
  void aiApi.setConversation({ savedAt: Date.now(), conversation: light }).catch(() => {});
}

/** Rattache la conversation persistée à l'onglet ouvert sur le même fichier. */
export async function restoreConversation(tabs: { id: string; path?: string }[]) {
  try {
    const saved = (await aiApi.getConversation()) as { conversation?: Conversation } | null;
    const conv = saved?.conversation;
    if (!conv || !Array.isArray(conv.messages) || !conv.tabPath) return;
    const tab = tabs.find((t) => t.path === conv.tabPath);
    if (!tab || state.conversations[tab.id]?.messages.length) return;
    setAi((s) => ({
      conversations: {
        ...s.conversations,
        [tab.id]: { ...conv, tabId: tab.id, messages: conv.messages.filter((m) => m && m.id) },
      },
    }));
  } catch {
    // Conversation illisible : on repart de zéro.
  }
}

/* ------------------------------------------------------------------ */
/* Patchs et historique                                                */
/* ------------------------------------------------------------------ */

export function putPatch(patch: AiPatch) {
  setAi((s) => ({ patches: { ...s.patches, [patch.id]: patch } }));
}

export function updatePatch(id: string, update: (p: AiPatch) => AiPatch) {
  setAi((s) => {
    const p = s.patches[id];
    return p ? { patches: { ...s.patches, [id]: update(p) } } : {};
  });
}

export function pushHistory(entry: HistoryEntry) {
  setAi((s) => ({ history: [entry, ...s.history].slice(0, 200) }));
}
