/** Types du module IA. Ce fichier ne contient que des types : `App` peut
 * l'importer sans charger le chunk IA. */

export type ProviderId =
  | "codex"
  | "claude"
  | "openai"
  | "anthropic"
  | "mistral"
  | "openrouter"
  | "ollama"
  | "lmstudio";

/** `off` : rien d'affiché ni chargé. `setup` : un fournisseur est choisi mais
 * n'a pas (encore) répondu. `ready` : utilisable. */
export type AiStatus = "off" | "setup" | "ready";

export type AiSettings = {
  version: 1;
  activeProvider: ProviderId | null;
  models: Partial<Record<ProviderId, string>>;
  baseUrls: Partial<Record<ProviderId, string>>;
  /** Fenêtre de contexte forcée (tokens), quand l'utilisateur la connaît mieux que nous. */
  contextWindows: Partial<Record<ProviderId, number>>;
  /** Consentement explicite à l'envoi de documents, mémorisé par fournisseur. */
  consent: Partial<Record<ProviderId, boolean>>;
  autocomplete: {
    enabled: boolean;
    provider: ProviderId | null;
    model: string;
  };
  /** Mesures réelles, clé `fournisseur:modèle`. */
  benchmarks: Record<string, Benchmark>;
  dockWidth: number;
};

export type Benchmark = {
  ttftMs: number;
  tokensPerSec: number;
  outputTokens?: number;
  warmupMs?: number;
  at: number;
};

/** Réponse de `ai_status` (lecture locale uniquement). */
export type AiBootInfo = {
  compiled: boolean;
  settings?: unknown;
  keys?: string[];
};

export type Detection = {
  codex: {
    installed: boolean;
    version?: string | null;
    loggedIn?: boolean;
    loginDetail?: string | null;
  };
  claude: {
    installed: boolean;
    version?: string | null;
    loggedIn?: boolean;
    /** `claude.ai` (abonnement) ou `console` (compte API). */
    authMethod?: string | null;
    /** `pro`, `max`… */
    subscription?: string | null;
    path?: string;
  };
  ollama: { installed: boolean; running: boolean; models: { name: string; size?: number }[] };
  lmstudio: { running: boolean; models: { name: string }[] };
  keys: string[];
};

/* ------------------------------------------------------------------ */
/* Flux                                                                */
/* ------------------------------------------------------------------ */

export type ChatMode = "chat" | "edit" | "complete";

export type WireImage = { mime: string; data: string };

export type WireMessage = {
  role: "user" | "assistant";
  content: string;
  images?: WireImage[];
};

export type ChatRequest = {
  provider: ProviderId;
  model: string;
  system?: string;
  messages: WireMessage[];
  conversationId?: string;
  mode?: ChatMode;
  document?: { name: string; content: string };
  maxTokens?: number;
  stop?: string[];
  /** Autocomplétion : texte brut à prolonger (continuation sans gabarit de chat). */
  rawPrefix?: string;
};

export type Usage = { inputTokens?: number | null; outputTokens?: number | null };

export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "toolStart"; label: string }
  | { type: "editResult"; content: string }
  | { type: "done"; usage: Usage | null; cancelled: boolean }
  | { type: "error"; message: string };

export type PullEvent =
  | { type: "progress"; status: string; completed?: number | null; total?: number | null }
  | { type: "done" }
  | { type: "error"; message: string };

/* ------------------------------------------------------------------ */
/* Contexte                                                            */
/* ------------------------------------------------------------------ */

export type ContextFile = { path: string; content: string };

export type ContextItem =
  | { id: string; kind: "document"; tabId: string }
  | { id: string; kind: "selection"; tabId: string; markdown: string }
  | { id: string; kind: "tab"; tabId: string; name: string }
  | {
      id: string;
      kind: "files";
      name: string;
      path: string;
      folder: boolean;
      files: ContextFile[];
      totalChars: number;
      skipped: number;
      truncated: boolean;
    }
  | { id: string; kind: "image"; name: string; mime: string; data: string };

/* ------------------------------------------------------------------ */
/* Conversation                                                        */
/* ------------------------------------------------------------------ */

export type UiMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  mode: ChatMode;
  reasoning?: string;
  tools?: string[];
  images?: { name: string; mime: string; data: string }[];
  /** Résumé du contexte joint (« Document, 2 fichiers… »). */
  contextLabel?: string;
  /** Contexte tronqué explicitement avant envoi. */
  truncation?: string;
  status?: "streaming" | "done" | "error" | "cancelled";
  error?: string;
  usage?: Usage | null;
  provider?: ProviderId;
  model?: string;
  patchId?: string;
  /** Quand la réponse vise un passage précis (action rapide). */
  target?: { tabId: string; start: number; end: number; base: string; kind: QuickActionKind };
};

export type Conversation = {
  id: string;
  tabId: string;
  tabPath?: string;
  messages: UiMessage[];
};

/* ------------------------------------------------------------------ */
/* Modifications                                                       */
/* ------------------------------------------------------------------ */

export type WordSeg = { text: string; changed: boolean };

export type HunkLine = {
  kind: "ctx" | "del" | "add";
  text: string;
  /** Numéro de ligne (0-indexé) côté ancien / nouveau. */
  oldNo?: number;
  newNo?: number;
  words?: WordSeg[];
};

export type HunkStatus = "pending" | "accepted" | "rejected" | "obsolete";

export type Hunk = {
  id: string;
  /** Première ligne (0-indexée) couverte côté ancien texte. */
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: HunkLine[];
  status: HunkStatus;
};

export type AiPatch = {
  id: string;
  tabId: string;
  /** Empreinte du markdown au moment de la génération. */
  baseHash: string;
  baseContent: string;
  nextContent: string;
  label: string;
  hunks: Hunk[];
  createdAt: number;
  state: "review" | "applied" | "discarded";
};

export type HistoryEntry = {
  id: string;
  tabId: string;
  label: string;
  at: number;
  /** Contenu avant / après application, pour le patch inverse. */
  before: string;
  after: string;
  reverted?: boolean;
};

export type QuickActionKind =
  | "rephrase"
  | "fix"
  | "shorten"
  | "translate"
  | "continue";

export type SlashAiKind = "ask" | "continue" | "summary";

/* ------------------------------------------------------------------ */
/* Pont avec l'application                                             */
/* ------------------------------------------------------------------ */

export type EditorSelection = {
  tabId: string;
  markdown: string;
  text: string;
};

export type EditorRoot = { kind: "wysiwyg" | "source"; el: HTMLElement; tabId: string };

/** Ce que l'application expose au module IA. Toutes les écritures passent
 * par `applyTabContent`, la seule route sûre vis-à-vis du contentEditable. */
export type AiBridge = {
  getTabs: () => { id: string; name: string; path?: string }[];
  getActiveTabId: () => string;
  isEditMode: () => boolean;
  /** Markdown réel de l'onglet (état de l'éditeur, pas le dernier flush). */
  getTabMarkdown: (tabId: string) => string | null;
  /** Remplace le contenu d'un onglet ; un seul Ctrl+Z l'annule. Renvoie
   * le markdown effectivement retenu par l'éditeur (après normalisation). */
  applyTabContent: (tabId: string, content: string) => string;
  /** Insère du markdown au dernier caret connu. `false` si impossible. */
  insertAtCaret: (markdown: string) => boolean;
  /** Sélection courante dans l'éditeur actif (`null` si vide ou ailleurs). */
  readEditorSelection: () => EditorSelection | null;
  /** Offset du caret dans le markdown de l'onglet actif. */
  getCaretOffset: () => { tabId: string; offset: number; markdown: string } | null;
  getEditorRoot: () => EditorRoot | null;
  openDiff: (patchId: string, tabId: string) => void;
  closeDiff: () => void;
  revealLine: (tabId: string, line: number) => void;
  setStatus: (status: AiStatus) => void;
  openSetup: () => void;
  openDock: () => void;
};
