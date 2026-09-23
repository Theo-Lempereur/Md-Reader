/** Appels au backend IA. Tout le réseau est côté Rust : le webview ne voit
 * jamais une clé API, seulement des flux d'événements. */

import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  AiSettings,
  Benchmark,
  ChatRequest,
  Detection,
  ProviderId,
  PullEvent,
  StreamEvent,
  Usage,
} from "./types";

let seq = 0;
const newRequestId = () => `r${Date.now().toString(36)}-${(seq++).toString(36)}`;

export type StreamHandlers = {
  onDelta?: (text: string) => void;
  onReasoning?: (text: string) => void;
  onTool?: (label: string) => void;
  onEditResult?: (content: string) => void;
};

export type StreamResult = {
  usage: Usage | null;
  cancelled: boolean;
};

export type StreamHandle = {
  requestId: string;
  cancel: () => void;
  done: Promise<StreamResult>;
};

/** Lance une requête en streaming. `done` se résout à la fin (ou à
 * l'annulation) et se rejette sur erreur. */
export function streamChat(req: ChatRequest, handlers: StreamHandlers = {}): StreamHandle {
  const requestId = newRequestId();
  let settle!: { resolve: (r: StreamResult) => void; reject: (e: Error) => void };
  const done = new Promise<StreamResult>((resolve, reject) => {
    settle = { resolve, reject };
  });
  let finished = false;
  const channel = new Channel<StreamEvent>();
  channel.onmessage = (ev) => {
    if (finished) return;
    switch (ev.type) {
      case "delta":
        handlers.onDelta?.(ev.text);
        break;
      case "reasoning":
        handlers.onReasoning?.(ev.text);
        break;
      case "toolStart":
        handlers.onTool?.(ev.label);
        break;
      case "editResult":
        handlers.onEditResult?.(ev.content);
        break;
      case "done":
        finished = true;
        settle.resolve({ usage: ev.usage, cancelled: ev.cancelled });
        break;
      case "error":
        finished = true;
        settle.reject(new Error(ev.message));
        break;
    }
  };
  invoke("ai_chat", { requestId, request: req, onEvent: channel }).catch((e) => {
    if (finished) return;
    finished = true;
    settle.reject(new Error(String(e)));
  });
  return {
    requestId,
    done,
    cancel: () => {
      void invoke("ai_cancel", { requestId }).catch(() => {});
    },
  };
}

/** Variante sans streaming : renvoie le texte complet. */
export async function completeText(
  req: ChatRequest,
  signal?: AbortSignal,
): Promise<string> {
  let text = "";
  const h = streamChat(req, { onDelta: (t) => (text += t) });
  const onAbort = () => h.cancel();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await h.done;
    if (res.cancelled || signal?.aborted) throw new DOMException("Annulé", "AbortError");
    return text;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

export const aiApi = {
  detect: () => invoke<Detection>("ai_detect_providers"),
  saveKey: (provider: ProviderId, key: string) => invoke<void>("ai_save_key", { provider, key }),
  deleteKey: (provider: ProviderId) => invoke<void>("ai_delete_key", { provider }),
  getSettings: () => invoke<unknown | null>("ai_settings_get"),
  setSettings: (settings: AiSettings) => invoke<void>("ai_settings_set", { settings }),
  getConversation: () => invoke<unknown | null>("ai_conversation_get"),
  setConversation: (conversation: unknown) =>
    invoke<void>("ai_conversation_set", { conversation }),
  listModels: (provider: ProviderId) => invoke<string[]>("ai_list_models", { provider }),
  readContextPath: (path: string) => invoke<ContextPathResult>("ai_read_context_path", { path }),
  hardware: () => invoke<HardwareInfo>("ai_hardware_scan"),
  catalog: () => invoke<Catalog>("ai_catalog"),
  benchmark: (provider: ProviderId, model: string) =>
    invoke<Omit<Benchmark, "at">>("ai_benchmark", { provider, model }),
  cancel: (requestId: string) => invoke<void>("ai_cancel", { requestId }),
  ollamaResidency: (model: string, load: boolean) =>
    invoke<void>("ai_ollama_residency", { model, load }),
  pull: (model: string, onEvent: (ev: PullEvent) => void) => {
    const requestId = newRequestId();
    const channel = new Channel<PullEvent>();
    channel.onmessage = onEvent;
    void invoke("ai_ollama_pull", { requestId, model, onEvent: channel }).catch((e) =>
      onEvent({ type: "error", message: String(e) }),
    );
    return () => void invoke("ai_cancel", { requestId }).catch(() => {});
  },
};

export type ContextPathResult =
  | {
      kind: "file" | "folder";
      name: string;
      path: string;
      files: { path: string; content: string }[];
      totalChars: number;
      skipped: number;
      truncated: boolean;
    }
  | { kind: "image"; name: string; path: string; mime: string; data: string };

export type HardwareInfo = {
  totalRam: number;
  availableRam: number;
  cpuCores: number | null;
  cpuThreads: number;
  cpuBrand: string;
  gpus: { name: string; vendor: string; vram: number; sharedMemory: number }[];
  freeDisk: number | null;
};

export type CatalogModel = {
  id: string;
  label: string;
  roles: ("chat" | "complete")[];
  vision: boolean;
  contextWindow: number;
  notes?: string;
  variants: { quant: string; tag: string; sizeGb: number }[];
};

export type Catalog = { version: number; gpuHeadroomGb: number; models: CatalogModel[] };
