import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import "katex/dist/katex.min.css";
import "./App.css";

import {
  readTime,
  wordCount,
  renderMarkdown,
  renderMarkdownBlocks,
  parseBlockBounds,
  type BlockInfo,
} from "./markdown/render";
import { normalizeMarkdown } from "./markdown/normalize";
import { WELCOME_MD } from "./welcome";
import { tokenizeLine, marginIcon } from "./markdown/source";
import { Icon } from "./components/Icons";
import { SourceView, type SourceViewHandle } from "./components/SourceView";
import {
  Toolbar,
  type ToolbarAction,
} from "./components/Toolbar";
import { FloatingToolbar } from "./components/FloatingToolbar";
import {
  WysiwygEditor,
  type WysiwygEditorHandle,
} from "./components/WysiwygEditor";
import { TweaksPanel } from "./components/TweaksPanel";
import {
  TweakRadio,
  TweakSection,
  TweakSelect,
  TweakSlider,
  TweakToggle,
} from "./components/Tweaks";
import { FileMenu } from "./components/FileMenu";
import { PdfExportModal } from "./components/PdfExportModal";
import { WindowControls } from "./components/WindowControls";
import {
  basename,
  exportEmbeddedMarkdownDialog,
  exportPdfDialog,
  openFileDialog,
  saveAsDialog,
  writeToPath,
  type OpenedFile,
} from "./lib/fileIo";
import { useUpdater } from "./lib/useUpdater";
import type {
  Density,
  FontVariant,
  MdFile,
  Palette,
  PersistedSession,
  PersistedUiState,
  SearchHit,
  TabStyle,
  Theme,
  ToolbarPos,
  Tweaks,
  ViewMode,
} from "./types";

const TEXT_WIDTH_MIN = 560;
const TEXT_WIDTH_MAX = 3200;
const TEXT_WIDTH_LEGACY_MIGRATION_MAX = 1040;
const TEXT_WIDTH_VIEWPORT_RATIO = 0.8;
const TEXT_WIDTH_WHEEL_STEP = 20;
const TEXT_WIDTH_WHEEL_THRESHOLD = 60;
const LEGACY_TEXT_WIDTH_MIN = 30;
const LEGACY_TEXT_WIDTH_MAX = 100;

const DEFAULT_TWEAKS: Tweaks = {
  theme: "light",
  palette: "graphite",
  font: "sans",
  density: "aere",
  tabStyle: "pastille",
  toolbarPos: "floating",
  autoSave: false,
  textWidth: 760,
  syncScroll: true,
  pdfPageFormat: "a4",
  pdfColorMode: "bw",
};

const TWEAKS_STORAGE_KEY = "md-reader:tweaks";

const TWEAK_OPTIONS = {
  theme: ["light", "dark"],
  palette: ["graphite", "encre", "sepia", "foret"],
  font: ["sans", "serif", "mono"],
  density: ["aere", "compact"],
  tabStyle: ["browser", "vscode", "pastille"],
  toolbarPos: ["top", "floating"],
  pdfPageFormat: ["a4", "letter"],
  pdfColorMode: ["bw", "palette-light", "palette-exact"],
} satisfies {
  [K in keyof Tweaks as Tweaks[K] extends string ? K : never]: Tweaks[K][];
};

function isStringTweakValue<K extends keyof typeof TWEAK_OPTIONS>(
  key: K,
  value: unknown,
): value is Tweaks[K] {
  return (
    typeof value === "string" &&
    (TWEAK_OPTIONS[key] as readonly string[]).includes(value)
  );
}

function readStringTweak<K extends keyof typeof TWEAK_OPTIONS>(
  saved: Partial<Record<keyof Tweaks, unknown>>,
  key: K,
): Tweaks[K] {
  const value = saved[key];
  return isStringTweakValue(key, value) ? value : DEFAULT_TWEAKS[key];
}

function clampTextWidth(value: number): number {
  return Math.min(TEXT_WIDTH_MAX, Math.max(TEXT_WIDTH_MIN, value));
}

function getViewportTextWidthMax(): number {
  if (typeof window === "undefined") return TEXT_WIDTH_MAX;
  const viewportMax =
    Math.floor((window.innerWidth * TEXT_WIDTH_VIEWPORT_RATIO) / 10) * 10;
  return Math.min(TEXT_WIDTH_MAX, Math.max(TEXT_WIDTH_MIN, viewportMax));
}

function normalizeTextWidth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_TWEAKS.textWidth;
  }

  if (value >= TEXT_WIDTH_MIN && value <= TEXT_WIDTH_MAX) {
    return clampTextWidth(value);
  }

  if (value >= LEGACY_TEXT_WIDTH_MIN && value <= LEGACY_TEXT_WIDTH_MAX) {
    const ratio =
      (value - LEGACY_TEXT_WIDTH_MIN) /
      (LEGACY_TEXT_WIDTH_MAX - LEGACY_TEXT_WIDTH_MIN);
    const migrated =
      TEXT_WIDTH_MIN + ratio * (TEXT_WIDTH_LEGACY_MIGRATION_MAX - TEXT_WIDTH_MIN);
    return Math.round(migrated / 10) * 10;
  }

  return DEFAULT_TWEAKS.textWidth;
}

function normalizeTweaks(value: unknown): Tweaks {
  if (!value || typeof value !== "object") return DEFAULT_TWEAKS;

  const s = value as Partial<Record<keyof Tweaks, unknown>>;
  return {
    theme: readStringTweak(s, "theme"),
    palette: readStringTweak(s, "palette"),
    font: readStringTweak(s, "font"),
    density: readStringTweak(s, "density"),
    tabStyle: readStringTweak(s, "tabStyle"),
    toolbarPos: readStringTweak(s, "toolbarPos"),
    autoSave: typeof s.autoSave === "boolean" ? s.autoSave : DEFAULT_TWEAKS.autoSave,
    textWidth: normalizeTextWidth(s.textWidth),
    syncScroll:
      typeof s.syncScroll === "boolean" ? s.syncScroll : DEFAULT_TWEAKS.syncScroll,
    pdfPageFormat: readStringTweak(s, "pdfPageFormat"),
    pdfColorMode: readStringTweak(s, "pdfColorMode"),
  };
}

function loadTweaks(): Tweaks {
  if (typeof window === "undefined") return DEFAULT_TWEAKS;

  try {
    const saved = window.localStorage.getItem(TWEAKS_STORAGE_KEY);
    if (!saved) return DEFAULT_TWEAKS;

    const parsed = JSON.parse(saved);
    return normalizeTweaks(parsed);
  } catch {
    return DEFAULT_TWEAKS;
  }
}

async function loadPersistedTweaks(): Promise<Tweaks | null> {
  try {
    const saved = await invoke<unknown | null>("read_tweaks");
    return saved ? normalizeTweaks(saved) : null;
  } catch {
    return null;
  }
}

async function savePersistedTweaks(tweaks: Tweaks): Promise<void> {
  try {
    await invoke("write_tweaks", { tweaks });
  } catch {
    // Browser/dev fallback: localStorage already has the same data.
  }
}

const SESSION_STORAGE_KEY = "md-reader:session";
const MAX_RECENT_PATHS = 10;
const WELCOME_TAB_ID = "welcome";
const EMPTY_SESSION: PersistedSession = {
  openPaths: [],
  activePath: null,
  perFile: {},
  recentPaths: [],
  firstRunDone: false,
};

function normalizeSession(value: unknown): PersistedSession {
  if (!value || typeof value !== "object") return EMPTY_SESSION;
  const s = value as Record<string, unknown>;
  const openPaths = Array.isArray(s.openPaths)
    ? s.openPaths.filter((p): p is string => typeof p === "string")
    : [];
  const activePath =
    typeof s.activePath === "string" && openPaths.includes(s.activePath)
      ? s.activePath
      : null;
  const rawPerFile =
    s.perFile && typeof s.perFile === "object"
      ? (s.perFile as Record<string, unknown>)
      : {};
  const perFile: Record<string, PersistedUiState> = {};
  for (const [path, ui] of Object.entries(rawPerFile)) {
    if (typeof path !== "string" || !ui || typeof ui !== "object") continue;
    const entry = ui as Record<string, unknown>;
    const result: PersistedUiState = {};
    const src = entry.source as Record<string, unknown> | undefined;
    if (src && typeof src === "object") {
      const out: PersistedUiState["source"] = {};
      const caret = src.caret as Record<string, unknown> | undefined;
      if (
        caret &&
        typeof caret.line === "number" &&
        typeof caret.column === "number"
      ) {
        out.caret = { line: caret.line, column: caret.column };
      }
      if (typeof src.scrollTop === "number") out.scrollTop = src.scrollTop;
      if (out.caret || out.scrollTop != null) result.source = out;
    }
    const pv = entry.preview as Record<string, unknown> | undefined;
    if (pv && typeof pv === "object") {
      const out: PersistedUiState["preview"] = {};
      const caret = pv.caret as Record<string, unknown> | undefined;
      if (caret && typeof caret.offset === "number") {
        out.caret = { offset: caret.offset };
      }
      if (typeof pv.scrollTop === "number") out.scrollTop = pv.scrollTop;
      if (out.caret || out.scrollTop != null) result.preview = out;
    }
    if (result.source || result.preview) perFile[path] = result;
  }
  // Récents : dédup, clamp à MAX_RECENT_PATHS.
  const rawRecent = Array.isArray(s.recentPaths)
    ? s.recentPaths.filter((p): p is string => typeof p === "string")
    : [];
  const seen = new Set<string>();
  const recentPaths: string[] = [];
  for (const p of rawRecent) {
    if (seen.has(p)) continue;
    seen.add(p);
    recentPaths.push(p);
    if (recentPaths.length >= MAX_RECENT_PATHS) break;
  }
  const firstRunDone = s.firstRunDone === true;
  return { openPaths, activePath, perFile, recentPaths, firstRunDone };
}

function loadSession(): PersistedSession {
  if (typeof window === "undefined") return EMPTY_SESSION;
  try {
    const saved = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (!saved) return EMPTY_SESSION;
    return normalizeSession(JSON.parse(saved));
  } catch {
    return EMPTY_SESSION;
  }
}

async function loadPersistedSession(): Promise<PersistedSession | null> {
  try {
    const saved = await invoke<unknown | null>("read_session");
    return saved ? normalizeSession(saved) : null;
  } catch {
    return null;
  }
}

async function savePersistedSession(session: PersistedSession): Promise<void> {
  try {
    await invoke("write_session", { session });
  } catch {
    // localStorage fait office de fallback.
  }
}

type SidePanel =
  | { mode: "block"; block: BlockInfo }
  | { mode: "full"; initialBlock: BlockInfo; nonce: number }
  | null;

function centerOnEl(container: HTMLElement, el: HTMLElement) {
  container.scrollTop =
    el.offsetTop - container.clientHeight / 2 + el.offsetHeight / 2;
}

function SourceMini({
  content,
  startLine = 0,
  lineEls,
  currentSyncLine,
  lineToBlock,
  highlightedBlock,
  onJumpToBlock,
}: {
  content: string;
  startLine?: number;
  lineEls?: React.MutableRefObject<Map<number, HTMLDivElement>>;
  currentSyncLine?: number | null;
  /** Map ligne → blockKey, pour afficher le bouton de saut sur n'importe quelle ligne du bloc. */
  lineToBlock?: Map<number, number>;
  /** Bloc actuellement surligné (toutes ses lignes prennent la classe `jump-highlight`). */
  highlightedBlock?: number | null;
  onJumpToBlock?: (blockKey: number) => void;
}) {
  const lines = normalizeMarkdown(content).split("\n");
  return (
    <div className="source source-mini">
      {lines.map((line, i) => {
        const absIdx = startLine + i;
        const mi = marginIcon(line);
        const blockKey = lineToBlock?.get(absIdx);
        const hasJump = blockKey != null && !!onJumpToBlock;
        const isHighlighted =
          blockKey != null && highlightedBlock != null && blockKey === highlightedBlock;
        return (
          <div
            key={i}
            className={`src-line${currentSyncLine === absIdx ? " sync-current" : ""}${hasJump ? " src-line-has-jump" : ""}${isHighlighted ? " jump-highlight" : ""}`}
            ref={
              lineEls
                ? (el) => {
                    if (el) lineEls.current.set(absIdx, el as HTMLDivElement);
                    else lineEls.current.delete(absIdx);
                  }
                : undefined
            }
          >
            <div className="ln">{absIdx + 1}</div>
            <div className={`margin-icon ${mi ? mi.cls : ""}`}>
              {mi ? mi.label : ""}
            </div>
            <div className="src-content">
              {line ? tokenizeLine(line, i) : <span>&#8203;</span>}
            </div>
            {hasJump && (
              <div className="src-line-tools">
                <button
                  type="button"
                  className="src-line-btn"
                  title="Aligner la preview sur ce bloc"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onJumpToBlock!(blockKey!);
                  }}
                >
                  <Icon.PanelLeft />
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function normalizeTabContent(tab: MdFile): MdFile {
  const content = normalizeMarkdown(tab.content);
  return content === tab.content ? tab : { ...tab, content };
}

function App() {
  const [tweaks, setTweaks] = useState<Tweaks>(loadTweaks);
  const setTweak = <K extends keyof Tweaks>(key: K, value: Tweaks[K]) =>
    setTweaks((t) => ({ ...t, [key]: value }));
  const persistedTweaksReadyRef = useRef(false);
  const lastSavedTweaksRef = useRef<string | null>(null);
  const [textWidthMax, setTextWidthMax] = useState(getViewportTextWidthMax);

  const [tabs, setTabs] = useState<MdFile[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const tabsRef = useRef<MdFile[]>([]);
  const persistedSessionReadyRef = useRef(false);
  const lastSavedSessionRef = useRef<string | null>(null);
  /** État UI mémorisé par fichier (caret + scroll, par vue). Clé = path. */
  const uiStateByPathRef = useRef<Map<string, PersistedUiState>>(new Map());
  /** Historique des fichiers ouverts, plus récent en tête, max MAX_RECENT_PATHS. */
  const [recentPaths, setRecentPaths] = useState<string[]>([]);
  /** Vrai dès qu'on a déjà affiché l'onglet Bienvenue au moins une fois. */
  const firstRunDoneRef = useRef(false);
  const [editMode, setEditMode] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("preview");
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [pdfModalOpen, setPdfModalOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const updater = useUpdater();
  const [searchQ, setSearchQ] = useState("");
  const [currentHit] = useState<SearchHit | null>(null);
  const [floatPos, setFloatPos] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [tweaksOpen, setTweaksOpen] = useState(false);
  const [sidePanel, setSidePanel] = useState<SidePanel>(null);
  const [syncLine, setSyncLine] = useState<number | null>(null);
  // Bloc surligné des deux côtés (preview + source) pour ne pas le perdre de vue
  // après le re-centrage automatique. Persiste jusqu'au prochain clic ou changement d'onglet.
  const [highlightedBlock, setHighlightedBlock] = useState<number | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const readingPaneRef = useRef<HTMLDivElement | null>(null);
  const sideBodyRef = useRef<HTMLDivElement | null>(null);
  const blockEls = useRef<
    Map<number, { el: HTMLDivElement; lineStart: number; lineEnd: number }>
  >(new Map());
  const lineEls = useRef<Map<number, HTMLDivElement>>(new Map());
  const syncingRef = useRef(false);
  const textWidthWheelDeltaRef = useRef(0);
  const wysiwygHandles = useRef<Map<string, WysiwygEditorHandle | null>>(
    new Map(),
  );
  const sourceRef = useRef<SourceViewHandle | null>(null);
  const sourceScrollerRef = useRef<HTMLDivElement | null>(null);

  const active = tabs.find((t) => t.id === activeId) || tabs[0];
  const sourceVisible = !!active && editMode && viewMode === "source";
  const sliderTextWidth = Math.min(tweaks.textWidth, textWidthMax);

  const sidePanelMode = sidePanel?.mode ?? null;
  // Map ligne → blockKey pour TOUTES les lignes de chaque bloc, pas seulement le début.
  const fullSourceLineToBlock = useMemo(() => {
    if (sidePanelMode !== "full" || !active) return undefined;
    const map = new Map<number, number>();
    parseBlockBounds(active.content).forEach((b, idx) => {
      for (let ln = b.lineStart; ln <= b.lineEnd; ln++) map.set(ln, idx);
    });
    return map;
  }, [sidePanelMode, active?.content]);

  const getActiveMarkdown = useCallback((): string | null => {
    if (sourceVisible) return sourceRef.current?.getMarkdown() ?? null;
    return wysiwygHandles.current.get(activeId)?.getMarkdown() ?? null;
  }, [sourceVisible, activeId]);

  const markDirty = useCallback((id: string) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === id && !t.dirty ? { ...t, dirty: true } : t)),
    );
  }, []);

  const toggleTaskAtLine = useCallback(
    (tabId: string, lineIndex: number, checked: boolean) => {
      setTabs((prev) =>
        prev.map((tab) => {
          if (tab.id !== tabId) return tab;
          const lines = tab.content.split("\n");
          const line = lines[lineIndex];
          if (line == null) return tab;
          const nextLine = line.replace(
            /^([-*]\s+\[)([ xX])(\](?:\s+.*)?)$/,
            `$1${checked ? "x" : " "}$3`,
          );
          if (nextLine === line) return tab;
          lines[lineIndex] = nextLine;
          const content = normalizeMarkdown(lines.join("\n"));
          wysiwygHandles.current.get(tabId)?.refreshFromContent(content);
          return { ...tab, content, dirty: true };
        }),
      );
    },
    [],
  );

  // Capture/restauration caret + scroll par fichier (clé = path).
  // Seuls les onglets avec path sont persistés sur disque ; les autres sont
  // mémorisés en RAM mais perdus au redémarrage (cohérent avec la décision
  // de ne sauvegarder que les chemins).
  const captureUiState = useCallback(
    (tabId: string, mode: "source" | "preview") => {
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (!tab?.path) return;
      const prev = uiStateByPathRef.current.get(tab.path) ?? {};
      if (mode === "source") {
        const caret = sourceRef.current?.getCaret() ?? null;
        const scrollTop = sourceRef.current?.getScrollTop() ?? null;
        if (caret == null && scrollTop == null) return;
        uiStateByPathRef.current.set(tab.path, {
          ...prev,
          source: {
            ...(caret ? { caret } : prev.source?.caret ? { caret: prev.source.caret } : {}),
            ...(scrollTop != null
              ? { scrollTop }
              : prev.source?.scrollTop != null
                ? { scrollTop: prev.source.scrollTop }
                : {}),
          },
        });
      } else {
        const handle = wysiwygHandles.current.get(tabId);
        const caret = handle?.getCaret() ?? null;
        const scrollTop = readingPaneRef.current?.scrollTop ?? null;
        if (caret == null && scrollTop == null) return;
        uiStateByPathRef.current.set(tab.path, {
          ...prev,
          preview: {
            ...(caret ? { caret } : prev.preview?.caret ? { caret: prev.preview.caret } : {}),
            ...(scrollTop != null
              ? { scrollTop }
              : prev.preview?.scrollTop != null
                ? { scrollTop: prev.preview.scrollTop }
                : {}),
          },
        });
      }
      setUiStateTick((t) => t + 1);
    },
    [],
  );

  const restoreUiState = useCallback(
    (tabId: string, mode: "source" | "preview", editing: boolean) => {
      const tab = tabsRef.current.find((t) => t.id === tabId);
      // Pas de path = onglet synthétique (welcome, "Nouveau"). Pas de
      // restauration disque-persistée, mais le caret-au-début s'applique quand
      // même si on entre en mode édition.
      const ui = tab?.path
        ? uiStateByPathRef.current.get(tab.path)
        : undefined;
      if (mode === "source") {
        const src = ui?.source;
        if (src?.caret) {
          sourceRef.current?.setCaret(src.caret);
        } else {
          // Première visite de la vue source → caret au tout début, focus.
          sourceRef.current?.setCaret({ line: 0, column: 0 });
          sourceRef.current?.focus();
        }
        if (src?.scrollTop != null) {
          sourceRef.current?.setScrollTop(src.scrollTop);
        }
      } else {
        const pv = ui?.preview;
        const handle = wysiwygHandles.current.get(tabId);
        if (pv?.caret) {
          handle?.setCaret(pv.caret);
        } else if (editing && handle) {
          // Première visite en édition WYSIWYG → caret au début, focus.
          handle.setCaret({ offset: 0 });
          handle.focus();
        }
        if (pv?.scrollTop != null && readingPaneRef.current) {
          readingPaneRef.current.scrollTop = pv.scrollTop;
        }
      }
    },
    [],
  );

  // Vue actuellement active (utilisée pour savoir quoi capturer avant un switch).
  const activeViewRef = useRef<"source" | "preview">("preview");
  useEffect(() => {
    activeViewRef.current = sourceVisible ? "source" : "preview";
  }, [sourceVisible]);

  // Avant fermeture : capture finale de la vue courante + écriture immédiate en
  // localStorage (le debounce du Tauri store ne suffit pas si l'app est tuée).
  useEffect(() => {
    const flush = () => {
      if (!activeId) return;
      captureUiState(activeId, sourceVisible ? "source" : "preview");
      const openPaths = tabsRef.current
        .map((t) => t.path)
        .filter((p): p is string => typeof p === "string");
      const activeTab = tabsRef.current.find((t) => t.id === activeId);
      const activePath = activeTab?.path ?? null;
      const perFile: Record<string, PersistedUiState> = {};
      for (const path of openPaths) {
        const ui = uiStateByPathRef.current.get(path);
        if (ui) perFile[path] = ui;
      }
      const session: PersistedSession = {
        openPaths,
        activePath,
        perFile,
        recentPaths,
        firstRunDone: firstRunDoneRef.current,
      };
      try {
        window.localStorage.setItem(
          SESSION_STORAGE_KEY,
          JSON.stringify(session),
        );
      } catch {
        // localStorage plein : on tente quand même Tauri en synchrone.
      }
      void savePersistedSession(session);
    };
    window.addEventListener("beforeunload", flush);
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      window.removeEventListener("pagehide", flush);
    };
  }, [activeId, sourceVisible, captureUiState, recentPaths]);

  // Capture en continu (caret + scroll) pendant que l'utilisateur travaille.
  // Cheap : on écrit dans la ref uniquement, sans re-render.
  useEffect(() => {
    if (!activeId) return;
    const tab = tabsRef.current.find((t) => t.id === activeId);
    if (!tab?.path) return;

    const onSelection = () => {
      if (sourceVisible) {
        const caret = sourceRef.current?.getCaret();
        if (caret) {
          const prev = uiStateByPathRef.current.get(tab.path!) ?? {};
          uiStateByPathRef.current.set(tab.path!, {
            ...prev,
            source: { ...prev.source, caret },
          });
        }
      } else if (editMode) {
        const caret = wysiwygHandles.current.get(activeId)?.getCaret();
        if (caret) {
          const prev = uiStateByPathRef.current.get(tab.path!) ?? {};
          uiStateByPathRef.current.set(tab.path!, {
            ...prev,
            preview: { ...prev.preview, caret },
          });
        }
      }
    };
    document.addEventListener("selectionchange", onSelection);
    return () => document.removeEventListener("selectionchange", onSelection);
  }, [activeId, sourceVisible, editMode]);

  // Capture scroll preview (un seul scroller partagé entre tous les onglets WYSIWYG).
  useEffect(() => {
    const pane = readingPaneRef.current;
    if (!pane) return;
    const onScroll = () => {
      if (!activeId) return;
      const tab = tabsRef.current.find((t) => t.id === activeId);
      if (!tab?.path) return;
      const prev = uiStateByPathRef.current.get(tab.path) ?? {};
      uiStateByPathRef.current.set(tab.path, {
        ...prev,
        preview: { ...prev.preview, scrollTop: pane.scrollTop },
      });
    };
    pane.addEventListener("scroll", onScroll, { passive: true });
    return () => pane.removeEventListener("scroll", onScroll);
  }, [activeId, sourceVisible]);

  // Capture scroll source (le scroller est le wrapper monté seulement en mode source).
  useEffect(() => {
    if (!sourceVisible) return;
    const pane = sourceScrollerRef.current;
    if (!pane) return;
    const onScroll = () => {
      if (!activeId) return;
      const tab = tabsRef.current.find((t) => t.id === activeId);
      if (!tab?.path) return;
      const prev = uiStateByPathRef.current.get(tab.path) ?? {};
      uiStateByPathRef.current.set(tab.path, {
        ...prev,
        source: { ...prev.source, scrollTop: pane.scrollTop },
      });
    };
    pane.addEventListener("scroll", onScroll, { passive: true });
    return () => pane.removeEventListener("scroll", onScroll);
  }, [activeId, sourceVisible]);

  // Restauration caret + scroll après chaque changement d'onglet / vue.
  // Double rAF : le premier laisse React commit le DOM, le second laisse le
  // navigateur appliquer le layout (notamment pour passer display:none → block
  // sur les WysiwygEditor non actifs et pour le remount du SourceView).
  useEffect(() => {
    if (!activeId) return;
    let raf2 = 0;
    const raf = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        restoreUiState(
          activeId,
          sourceVisible ? "source" : "preview",
          editMode,
        );
      });
    });
    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(raf2);
    };
  }, [activeId, sourceVisible, editMode, restoreUiState]);

  const handleAction = useCallback(
    (action: ToolbarAction) => {
      if (sourceVisible) {
        sourceRef.current?.executeCommand(action);
      } else {
        wysiwygHandles.current.get(activeId)?.executeCommand(action);
      }
    },
    [sourceVisible, activeId],
  );

  // viewMode / editMode transitions need a flush between WYSIWYG ↔ Source.
  const switchViewMode = useCallback(
    (newMode: ViewMode) => {
      if (newMode === viewMode) return;
      // Snapshot caret + scroll de la vue qui se ferme.
      captureUiState(activeId, viewMode === "source" ? "source" : "preview");
      if (viewMode === "preview" && newMode === "source") {
        const md = wysiwygHandles.current.get(activeId)?.getMarkdown();
        if (md != null) {
          const content = normalizeMarkdown(md);
          setTabs((prev) =>
            prev.map((t) => (t.id === activeId ? { ...t, content } : t)),
          );
        }
      } else {
        const md = sourceRef.current?.getMarkdown();
        if (md != null) {
          const content = normalizeMarkdown(md);
          setTabs((prev) =>
            prev.map((t) => (t.id === activeId ? { ...t, content } : t)),
          );
          // WYSIWYG-active reste monté (key stable). On rafraîchit son DOM.
          wysiwygHandles.current.get(activeId)?.refreshFromContent(content);
        }
      }
      setViewMode(newMode);
    },
    [viewMode, activeId, captureUiState],
  );

  const toggleEditMode = useCallback(() => {
    // Snapshot caret + scroll de la vue qui se ferme avant de basculer.
    captureUiState(activeId, sourceVisible ? "source" : "preview");
    if (editMode) {
      // Quitter l'édition : flush le contenu vers l'état (pour que ReadPreview soit à jour).
      if (sourceVisible) {
        const md = sourceRef.current?.getMarkdown();
        if (md != null) {
          const content = normalizeMarkdown(md);
          setTabs((prev) =>
            prev.map((t) => (t.id === activeId ? { ...t, content } : t)),
          );
          wysiwygHandles.current.get(activeId)?.refreshFromContent(content);
        }
      } else {
        const md = wysiwygHandles.current.get(activeId)?.getMarkdown();
        if (md != null) {
          const content = normalizeMarkdown(md);
          setTabs((prev) =>
            prev.map((t) => (t.id === activeId ? { ...t, content } : t)),
          );
        }
      }
    } else {
      // Activer l'édition : synchronise le WYSIWYG avec le contenu courant.
      const tab = tabsRef.current.find((t) => t.id === activeId);
      if (tab)
        wysiwygHandles.current
          .get(activeId)
          ?.refreshFromContent(normalizeMarkdown(tab.content));
    }
    setSidePanel(null);
    setHighlightedBlock(null);
    setEditMode((v) => !v);
  }, [editMode, sourceVisible, activeId, captureUiState]);

  const switchTab = useCallback(
    (newId: string) => {
      if (newId === activeId) return;
      // Snapshot caret + scroll de l'onglet sortant pour la vue courante.
      captureUiState(activeId, sourceVisible ? "source" : "preview");
      // Si on est en source view, on flushe avant changement d'onglet (source view
      // n'est mountée que pour l'onglet actif et va être démontée).
      if (sourceVisible) {
        const md = sourceRef.current?.getMarkdown();
        if (md != null) {
          const content = normalizeMarkdown(md);
          setTabs((prev) =>
            prev.map((t) => (t.id === activeId ? { ...t, content } : t)),
          );
          wysiwygHandles.current.get(activeId)?.refreshFromContent(content);
        }
      }
      setActiveId(newId);
    },
    [sourceVisible, activeId, captureUiState],
  );

  useEffect(() => {
    let cancelled = false;

    loadPersistedTweaks()
      .then((saved) => {
        if (!cancelled && saved) setTweaks(saved);
      })
      .finally(() => {
        if (!cancelled) persistedTweaksReadyRef.current = true;
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const serialized = JSON.stringify(tweaks);
    window.localStorage.setItem(TWEAKS_STORAGE_KEY, serialized);

    if (!persistedTweaksReadyRef.current) return;
    if (lastSavedTweaksRef.current === serialized) return;

    lastSavedTweaksRef.current = serialized;
    void savePersistedTweaks(tweaks);
  }, [tweaks]);

  // Sauvegarde session (chemins ouverts + état UI) avec debounce.
  // L'état UI vit dans uiStateByPathRef ; on tague ses mises à jour via uiStateTick.
  const [uiStateTick, setUiStateTick] = useState(0);
  useEffect(() => {
    if (!persistedSessionReadyRef.current) return;

    const openPaths = tabs
      .map((t) => t.path)
      .filter((p): p is string => typeof p === "string");
    const activeTab = tabs.find((t) => t.id === activeId);
    const activePath = activeTab?.path ?? null;

    // Élaguer perFile aux chemins encore présents.
    const perFile: Record<string, PersistedUiState> = {};
    for (const path of openPaths) {
      const ui = uiStateByPathRef.current.get(path);
      if (ui) perFile[path] = ui;
    }

    const session: PersistedSession = {
      openPaths,
      activePath,
      perFile,
      recentPaths,
      firstRunDone: firstRunDoneRef.current,
    };
    const serialized = JSON.stringify(session);
    if (lastSavedSessionRef.current === serialized) return;
    lastSavedSessionRef.current = serialized;

    window.localStorage.setItem(SESSION_STORAGE_KEY, serialized);
    const timer = setTimeout(() => {
      void savePersistedSession(session);
    }, 1000);
    return () => clearTimeout(timer);
  }, [tabs, activeId, uiStateTick, recentPaths]);

  useEffect(() => {
    const onResize = () => setTextWidthMax(getViewportTextWidthMax());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();

      textWidthWheelDeltaRef.current += e.deltaY;
      if (
        Math.abs(textWidthWheelDeltaRef.current) < TEXT_WIDTH_WHEEL_THRESHOLD
      ) {
        return;
      }

      const direction = textWidthWheelDeltaRef.current < 0 ? 1 : -1;
      textWidthWheelDeltaRef.current = 0;
      setTweaks((current) => ({
        ...current,
        textWidth: clampTextWidth(
          current.textWidth + direction * TEXT_WIDTH_WHEEL_STEP,
        ),
      }));
    };

    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const normalizedTabs = tabs.map(normalizeTabContent);
    const changed = normalizedTabs.some((tab, index) => tab !== tabs[index]);

    tabsRef.current = normalizedTabs;
    if (changed) setTabs(normalizedTabs);
  }, [tabs]);

  // File actions
  const handleNew = useCallback(() => {
    const id = "nouveau-" + Date.now();
    const f: MdFile = {
      id,
      name: "sans-titre.md",
      content: normalizeMarkdown("# Nouveau document\n\nCommencez à écrire…\n"),
    };
    setTabs((prev) => [...prev, f]);
    setActiveId(id);
  }, []);

  /** Préfixe `path` dans l'historique récent, dédup, clamp à MAX_RECENT_PATHS. */
  const bumpRecent = useCallback((path: string) => {
    setRecentPaths((prev) => {
      const next = [path, ...prev.filter((p) => p !== path)];
      return next.slice(0, MAX_RECENT_PATHS);
    });
  }, []);

  /** Retire un chemin des récents (fichier introuvable). */
  const dropRecent = useCallback((path: string) => {
    setRecentPaths((prev) => prev.filter((p) => p !== path));
  }, []);

  const addOrFocusTab = useCallback(
    (f: OpenedFile) => {
      bumpRecent(f.path);
      const existing = tabsRef.current.find((t) => t.path === f.path);
      if (existing) {
        setActiveId(existing.id);
        return;
      }

      const id = `file-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const nextTabs = [
        ...tabsRef.current,
        {
          id,
          name: f.name,
          content: normalizeMarkdown(f.content),
          path: f.path,
        },
      ];
      tabsRef.current = nextTabs;
      setTabs(nextTabs);
      setActiveId(id);
    },
    [bumpRecent],
  );

  const handleOpen = useCallback(async () => {
    try {
      const f = await openFileDialog();
      if (!f) return;
      addOrFocusTab(f);
    } catch (err) {
      console.error("Ouverture échouée:", err);
    }
  }, [addOrFocusTab]);

  const handleOpenRecent = useCallback(
    async (path: string) => {
      try {
        const content = await invoke<string>("read_text_file", { path });
        const name = path.split(/[/\\]/).pop() || "document.md";
        addOrFocusTab({ path, name, content });
      } catch (err) {
        console.error("Ouverture du fichier récent échouée:", err);
        dropRecent(path);
      }
    },
    [addOrFocusTab, dropRecent],
  );

  useEffect(() => {
    const unlisten = listen<OpenedFile>("open-file", (event) => {
      addOrFocusTab(event.payload);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [addOrFocusTab]);

  // Boot : restaurer la session (onglets + état UI) puis signaler le frontend prêt.
  // L'ordre est critique : tabsRef.current doit refléter les onglets restaurés
  // avant que les events "open-file" déclenchés par argv ne soient traités, sinon
  // un doublon serait créé pour un fichier déjà restauré depuis la session.
  useEffect(() => {
    let cancelled = false;

    const restore = async () => {
      const localSession = loadSession();
      let session: PersistedSession = localSession;

      // Backup Tauri store : utilisé si localStorage est totalement vierge
      // (cas d'un wipe de WebView storage / install fraîche en dev).
      const localEmpty =
        !session.openPaths.length &&
        !session.recentPaths.length &&
        !session.firstRunDone;
      if (localEmpty) {
        const remote = await loadPersistedSession();
        if (remote) session = remote;
      }

      const restored: MdFile[] = [];
      for (const path of session.openPaths) {
        try {
          const content = await invoke<string>("read_text_file", { path });
          if (cancelled) return;
          const id = `file-${Date.now()}-${restored.length}-${Math.random().toString(36).slice(2)}`;
          const name =
            path.split(/[/\\]/).pop() || "document.md";
          restored.push({
            id,
            name,
            content: normalizeMarkdown(content),
            path,
          });
        } catch {
          // Fichier introuvable / inaccessible — on l'ignore silencieusement.
        }
      }
      if (cancelled) return;

      uiStateByPathRef.current = new Map(Object.entries(session.perFile));
      setRecentPaths(session.recentPaths);
      firstRunDoneRef.current = session.firstRunDone;

      // Premier lancement : aucun onglet précédent et la doc n'a jamais été
      // affichée → on injecte l'onglet "Bienvenue.md" comme document non
      // sauvegardé (pas de path, donc jamais persisté dans openPaths).
      if (!session.firstRunDone && restored.length === 0) {
        restored.push({
          id: WELCOME_TAB_ID,
          name: "Bienvenue.md",
          content: normalizeMarkdown(WELCOME_MD),
        });
        firstRunDoneRef.current = true;
      }

      tabsRef.current = restored;
      setTabs(restored);

      if (restored.length) {
        const activeTab = session.activePath
          ? restored.find((t) => t.path === session.activePath)
          : null;
        setActiveId((activeTab ?? restored[0]).id);
      }

      persistedSessionReadyRef.current = true;
      // On invalide explicitement lastSavedSessionRef pour que l'effet de
      // sauvegarde voit firstRunDone à jour et persiste la nouvelle valeur.
      lastSavedSessionRef.current = null;

      emit("frontend-ready").catch((err) =>
        console.error("Signal frontend-ready échoué:", err),
      );
    };

    void restore();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleExportEmbeddedMd = useCallback(async () => {
    const md = getActiveMarkdown();
    if (md == null) return;
    const tab = tabs.find((t) => t.id === activeId);
    if (!tab) return;
    try {
      const content = normalizeMarkdown(md);
      await exportEmbeddedMarkdownDialog(content, tab.name);
    } catch (err) {
      console.error("Export embarqué échoué:", err);
    }
  }, [activeId, tabs, getActiveMarkdown]);

  const handleSaveAs = useCallback(async () => {
    const md = getActiveMarkdown();
    if (md == null) return;
    const tab = tabs.find((t) => t.id === activeId);
    if (!tab) return;
    try {
      const content = normalizeMarkdown(md);
      const path = await saveAsDialog(content, tab.name);
      if (!path) return;
      setTabs((prev) =>
        prev.map((t) =>
          t.id === activeId
            ? {
                ...t,
                content,
                path,
                name: basename(path),
                dirty: false,
              }
            : t,
        ),
      );
    } catch (err) {
      console.error("Save As échoué:", err);
    }
  }, [activeId, tabs, getActiveMarkdown]);

  const handleSave = useCallback(async () => {
    const md = getActiveMarkdown();
    if (md == null) return;
    const tab = tabs.find((t) => t.id === activeId);
    if (!tab) return;
    if (!tab.path) {
      await handleSaveAs();
      return;
    }
    try {
      const content = normalizeMarkdown(md);
      await writeToPath(tab.path, content);
      setTabs((prev) =>
        prev.map((t) =>
          t.id === activeId
            ? { ...t, content, dirty: false }
            : t,
        ),
      );
    } catch (err) {
      console.error("Save échoué:", err);
    }
  }, [activeId, tabs, getActiveMarkdown, handleSaveAs]);

  // Auto-save (debounce 1s).
  useEffect(() => {
    if (!tweaks.autoSave) return;
    const dirtyWithPath = tabs.filter((t) => t.dirty && t.path);
    if (!dirtyWithPath.length) return;
    const timer = setTimeout(() => {
      for (const t of dirtyWithPath) {
        const md =
          t.id === activeId && sourceVisible
            ? sourceRef.current?.getMarkdown()
            : wysiwygHandles.current.get(t.id)?.getMarkdown();
        if (md == null || !t.path) continue;
        const content = normalizeMarkdown(md);
        writeToPath(t.path, content)
          .then(() => {
            setTabs((prev) =>
              prev.map((x) =>
                x.id === t.id ? { ...x, content, dirty: false } : x,
              ),
            );
          })
          .catch((err) => console.error("Auto-save échoué:", err));
      }
    }, 1000);
    return () => clearTimeout(timer);
  }, [tabs, tweaks.autoSave, activeId, sourceVisible]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && e.shiftKey && key === "s") {
        e.preventDefault();
        handleSaveAs();
      } else if (mod && key === "s") {
        e.preventDefault();
        handleSave();
      } else if (mod && key === "o") {
        e.preventDefault();
        handleOpen();
      } else if (mod && key === "n") {
        e.preventDefault();
        handleNew();
      } else if (mod && key === "f") {
        e.preventDefault();
        setSearchOpen(true);
      } else if (e.key === "Escape") {
        setSearchOpen(false);
        setFileMenuOpen(false);
      } else if (mod && key === "m") {
        e.preventDefault();
        toggleEditMode();
      } else if (mod && key === "p") {
        e.preventDefault();
        window.print();
      } else if (e.altKey && !mod && !e.shiftKey && key === "p") {
        if (sidePanel) {
          e.preventDefault();
          setSidePanel(null);
          setHighlightedBlock(null);
        }
      } else if (e.altKey && !mod && !e.shiftKey && key === "s") {
        if (editMode) {
          e.preventDefault();
          switchViewMode(viewMode === "source" ? "preview" : "source");
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    handleSave,
    handleSaveAs,
    handleOpen,
    handleNew,
    toggleEditMode,
    sidePanel,
    editMode,
    viewMode,
    switchViewMode,
  ]);

  // Curseur main sur les liens : actif seulement quand Ctrl/Cmd est enfoncé.
  useEffect(() => {
    const update = (held: boolean) => {
      document.body.classList.toggle("ctrl-held", held);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) update(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey) update(false);
    };
    const reset = () => update(false);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", reset);
      document.body.classList.remove("ctrl-held");
    };
  }, []);

  // Selection toolbar (WYSIWYG preview + edit mode)
  useEffect(() => {
    if (!editMode || viewMode !== "preview") {
      setFloatPos(null);
      return;
    }
    const onUp = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) {
        setFloatPos(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        setFloatPos(null);
        return;
      }
      const containerRect = contentRef.current?.getBoundingClientRect();
      if (!containerRect) return;
      setFloatPos({
        x: rect.left + rect.width / 2 - containerRect.left,
        y: rect.top - containerRect.top,
      });
    };
    const onSelChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) setFloatPos(null);
    };
    document.addEventListener("mouseup", onUp);
    document.addEventListener("selectionchange", onSelChange);
    return () => {
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("selectionchange", onSelChange);
    };
  }, [editMode, viewMode, activeId]);

  // Réinitialise le panneau source au changement d'onglet.
  useEffect(() => {
    setSidePanel(null);
    setSyncLine(null);
    setHighlightedBlock(null);
    blockEls.current.clear();
    lineEls.current.clear();
  }, [activeId]);

  // En mode "source complète", scroll initial vers le bloc cliqué.
  // Centre la preview ET la source sur ce bloc (réagit aussi au nonce
  // → re-clic sur le bouton PanelRight = re-centrage).
  useEffect(() => {
    if (sidePanel?.mode !== "full") return;
    const ln = sidePanel.initialBlock.lineStart;
    const key = sidePanel.initialBlock.key;
    let raf2 = 0;
    const raf = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const target = lineEls.current.get(ln);
        const body = sideBodyRef.current;
        const reading = readingPaneRef.current;
        const blockInfo = blockEls.current.get(key);
        if (!body) return;
        syncingRef.current = true;
        if (target) centerOnEl(body, target);
        if (reading && blockInfo) centerOnEl(reading, blockInfo.el);
        setSyncLine(ln);
        setHighlightedBlock(key);
        setTimeout(() => {
          syncingRef.current = false;
        }, 280);
      });
    });
    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(raf2);
    };
  }, [sidePanel]);

  // Scroll synchronisé en mode "source complète".
  // Désactivable via le tweak `syncScroll`.
  useEffect(() => {
    if (sidePanel?.mode !== "full") return;
    if (!tweaks.syncScroll) return;
    const reading = readingPaneRef.current;
    const side = sideBodyRef.current;
    if (!reading || !side) return;

    const onReadingScroll = () => {
      if (syncingRef.current) return;
      const anchor = reading.scrollTop + reading.clientHeight / 2;
      let bestInfo: {
        el: HTMLDivElement;
        lineStart: number;
        lineEnd: number;
      } | null = null;
      let bestDelta = Infinity;
      blockEls.current.forEach((info) => {
        const top = info.el.offsetTop;
        if (top <= anchor) {
          const delta = anchor - top;
          if (delta < bestDelta) {
            bestDelta = delta;
            bestInfo = info;
          }
        }
      });
      if (!bestInfo) return;
      const bi = bestInfo as { el: HTMLDivElement; lineStart: number; lineEnd: number };
      const blockHeight = bi.el.offsetHeight || 1;
      const progress = Math.min(
        1,
        Math.max(0, (anchor - bi.el.offsetTop) / blockHeight),
      );
      const targetLn =
        bi.lineStart + Math.round(progress * (bi.lineEnd - bi.lineStart));
      const targetEl = lineEls.current.get(targetLn);
      if (!targetEl) return;
      syncingRef.current = true;
      centerOnEl(side, targetEl);
      setSyncLine(bi.lineStart);
      requestAnimationFrame(() => {
        syncingRef.current = false;
      });
    };

    const onSideScroll = () => {
      if (syncingRef.current) return;
      const anchor = side.scrollTop + side.clientHeight / 2;
      let bestLn: number | null = null;
      let bestDelta = Infinity;
      lineEls.current.forEach((el, idx) => {
        const top = el.offsetTop;
        if (top <= anchor) {
          const delta = anchor - top;
          if (delta < bestDelta) {
            bestDelta = delta;
            bestLn = idx;
          }
        }
      });
      if (bestLn == null) return;
      let bestBlock: {
        el: HTMLDivElement;
        lineStart: number;
        lineEnd: number;
      } | null = null;
      blockEls.current.forEach((info) => {
        if (info.lineStart <= bestLn! && bestLn! <= info.lineEnd)
          bestBlock = info;
      });
      if (!bestBlock) return;
      const bb = bestBlock as { el: HTMLDivElement; lineStart: number; lineEnd: number };
      syncingRef.current = true;
      centerOnEl(reading, bb.el);
      setSyncLine(bb.lineStart);
      requestAnimationFrame(() => {
        syncingRef.current = false;
      });
    };

    reading.addEventListener("scroll", onReadingScroll, { passive: true });
    side.addEventListener("scroll", onSideScroll, { passive: true });
    return () => {
      reading.removeEventListener("scroll", onReadingScroll);
      side.removeEventListener("scroll", onSideScroll);
    };
  }, [sidePanel, tweaks.syncScroll]);

  // Centre la preview ET la source sur un bloc donné (depuis un bouton côté source).
  const jumpToBlock = useCallback((blockKey: number) => {
    const reading = readingPaneRef.current;
    const side = sideBodyRef.current;
    const blockInfo = blockEls.current.get(blockKey);
    if (!blockInfo) return;
    const lineEl = lineEls.current.get(blockInfo.lineStart);
    syncingRef.current = true;
    if (reading) centerOnEl(reading, blockInfo.el);
    if (side && lineEl) centerOnEl(side, lineEl);
    setSyncLine(blockInfo.lineStart);
    setHighlightedBlock(blockKey);
    setTimeout(() => {
      syncingRef.current = false;
    }, 280);
  }, []);

  const closeTab = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const next = tabs.filter((t) => t.id !== id);
    wysiwygHandles.current.delete(id);
    setTabs(next);
    if (activeId === id) setActiveId(next.length ? next[0].id : "");
  };

  const handlePdfExport = async (opts: {
    format: Tweaks["pdfPageFormat"];
    colorMode: Tweaks["pdfColorMode"];
  }) => {
    setTweak("pdfPageFormat", opts.format);
    setTweak("pdfColorMode", opts.colorMode);
    setPdfModalOpen(false);
    setEditMode(false);
    await new Promise((r) => setTimeout(r, 80));
    const suggested = active?.name ?? "document.md";
    try {
      await exportPdfDialog(suggested, opts);
    } catch (err) {
      console.error("Export PDF échoué :", err);
    }
  };

  const hitCount = useMemo(() => {
    if (!searchQ || !active) return 0;
    const re = new RegExp(
      searchQ.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "gi",
    );
    return (active.content.match(re) || []).length;
  }, [searchQ, active]);

  return (
    <div
      className="app"
      data-theme={tweaks.theme}
      data-palette={tweaks.palette}
      data-font={tweaks.font}
      data-density={tweaks.density}
      style={{ "--reading-width": `${tweaks.textWidth}px` } as CSSProperties}
    >
      {/* Top bar unifié : menu Fichier + onglets + actions + contrôles fenêtre */}
      <div className="topbar" data-tauri-drag-region>
        <FileMenu
          open={fileMenuOpen}
          setOpen={setFileMenuOpen}
          onNew={handleNew}
          onOpen={handleOpen}
          onSave={handleSave}
          onSaveAs={handleSaveAs}
          onExportPdf={() => setPdfModalOpen(true)}
          onExportEmbeddedMd={handleExportEmbeddedMd}
          recents={recentPaths}
          onOpenRecent={handleOpenRecent}
        />
        <div className="topbar-sep" data-tauri-drag-region />
        <div
          className="tabs topbar-tabs"
          data-tab-style={tweaks.tabStyle}
          data-tauri-drag-region
        >
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`tab ${tab.id === activeId ? "active" : ""}`}
              onClick={() => switchTab(tab.id)}
            >
              <span
                className="dot-unsaved"
                style={{ opacity: tab.dirty ? 0.7 : 0 }}
              />
              <span>{tab.name}</span>
              <span className="close" onClick={(e) => closeTab(tab.id, e)}>
                <Icon.Close />
              </span>
            </div>
          ))}
          <button
            className="tab-new"
            onClick={handleNew}
            title="Nouveau fichier"
          >
            <Icon.Plus />
          </button>
        </div>
        <div className="topbar-actions">
          <button
            className={`icon-btn ${searchOpen ? "active" : ""}`}
            title="Rechercher ⌘F"
            onClick={() => setSearchOpen(!searchOpen)}
          >
            <Icon.Search />
          </button>
          <button
            className="icon-btn"
            title={tweaks.theme === "dark" ? "Mode clair" : "Mode sombre"}
            onClick={() =>
              setTweak("theme", tweaks.theme === "dark" ? "light" : "dark")
            }
          >
            {tweaks.theme === "dark" ? <Icon.Sun /> : <Icon.Moon />}
          </button>
          {updater.status === "available" && (
            <button
              className="icon-btn update-btn"
              title={`Mise à jour disponible (v${updater.version}) — cliquer pour installer`}
              onClick={updater.install}
            >
              <Icon.ArrowDownCircle />
            </button>
          )}
          {updater.status === "downloading" && (
            <button
              className="icon-btn update-btn downloading"
              title={`Téléchargement… ${Math.round(updater.progress * 100)}%`}
              disabled
            >
              <Icon.ArrowDownCircle />
            </button>
          )}
          <div style={{ width: 6 }} />
          <button
            className={`edit-toggle ${editMode ? "on" : ""}`}
            onClick={toggleEditMode}
            title={editMode ? "Lecture (Ctrl+M)" : "Modification (Ctrl+M)"}
          >
            {editMode ? (
              <>
                <Icon.Eye /> Lecture
              </>
            ) : (
              <>
                <Icon.Pencil /> Activer la modification
              </>
            )}
          </button>
        </div>
        <WindowControls />
      </div>

      {/* Toolbar - edit mode only */}
      {editMode && (
        <Toolbar
          viewMode={viewMode}
          onViewMode={switchViewMode}
          onAction={handleAction}
          pos={tweaks.toolbarPos}
        />
      )}

      {/* Content */}
      <div
        className="content"
        ref={contentRef}
        data-floating-toolbar={
          editMode && tweaks.toolbarPos === "floating" ? "1" : undefined
        }
      >
        {searchOpen && (
          <div className="search-overlay">
            <Icon.Search />
            <input
              autoFocus
              placeholder="Rechercher dans le document…"
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
            />
            <span className="count">
              {hitCount > 0
                ? `${hitCount} résultats`
                : searchQ
                  ? "aucun"
                  : ""}
            </span>
            <button
              onClick={() => {
                setSearchQ("");
                setSearchOpen(false);
              }}
              title="Fermer"
            >
              <Icon.Close />
            </button>
          </div>
        )}

        {!active ? (
          <div className="welcome-empty" style={{ flex: 1 }}>
            <div className="welcome-empty-inner">
              {recentPaths.length > 0 ? (
                <div className="welcome-recents">
                  <h1>Fichiers récents</h1>
                  <ul className="welcome-recents-list">
                    {recentPaths.map((path) => (
                      <li key={path}>
                        <button
                          className="welcome-recents-item"
                          title={path}
                          onClick={() => handleOpenRecent(path)}
                        >
                          <span className="welcome-recents-name">
                            {basename(path)}
                          </span>
                          <span className="welcome-recents-path">{path}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div className="welcome-doc reading">
                  {renderMarkdown(normalizeMarkdown(WELCOME_MD))}
                </div>
              )}
              <div className="welcome-actions">
                <button className="welcome-btn" onClick={handleNew}>
                  <Icon.Plus />
                  <span>Nouveau document</span>
                  <span className="kbd">⌘N</span>
                </button>
                <button className="welcome-btn" onClick={handleOpen}>
                  <Icon.FileText />
                  <span>Ouvrir un fichier…</span>
                  <span className="kbd">⌘O</span>
                </button>
              </div>
            </div>
          </div>
        ) : sourceVisible ? (
          <div
            ref={sourceScrollerRef}
            style={{ flex: 1, overflow: "auto" }}
          >
            <SourceView
              ref={sourceRef}
              content={active.content}
              search={searchQ}
              currentHit={currentHit}
              onInput={() => markDirty(active.id)}
            />
          </div>
        ) : (
          <>
            {/* Volet lecture + éditeur WYSIWYG */}
            <div className="reading-pane" ref={readingPaneRef}>
              {/* Tous les WysiwygEditor restent montés (modifs préservées au switch d'onglet) */}
              {tabs.map((tab) => {
                const isActive = tab.id === activeId;
                const editorVisible = isActive && editMode;
                return (
                  <div
                    key={tab.id}
                    style={{
                      display: editorVisible ? "block" : "none",
                      height: "100%",
                      position: "relative",
                    }}
                  >
                    <WysiwygEditor
                      ref={(h) => {
                        if (h) wysiwygHandles.current.set(tab.id, h);
                        else wysiwygHandles.current.delete(tab.id);
                      }}
                      initialContent={tab.content}
                      enabled={editMode && isActive}
                      onInput={() => markDirty(tab.id)}
                    />
                    {isActive && editMode && viewMode === "preview" && active && (
                      <div className="reading reading-blocks reading-blocks-overlay" aria-hidden="true">
                        {renderMarkdownBlocks(active.content, {
                          onInspect: (b) =>
                            setSidePanel((prev) =>
                              prev?.mode === "block" && prev.block.key === b.key
                                ? null
                                : { mode: "block", block: b },
                            ),
                          onOpenFull: (b) =>
                            setSidePanel({
                              mode: "full",
                              initialBlock: b,
                              nonce: Date.now(),
                            }),
                          selectedBlockKey:
                            sidePanel?.mode === "block" ? sidePanel.block.key : null,
                          inspectMode: sidePanel?.mode ?? null,
                          highlightedBlockKey: highlightedBlock,
                          blockEls,
                        })}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Prévisualisation lecture avec boutons de bloc */}
              {!editMode && (
                <div className="reading reading-blocks">
                  {renderMarkdownBlocks(active.content, {
                    onInspect: (b) =>
                      setSidePanel((prev) =>
                        prev?.mode === "block" && prev.block.key === b.key
                          ? null
                          : { mode: "block", block: b },
                      ),
                    onOpenFull: (b) =>
                      setSidePanel({
                        mode: "full",
                        initialBlock: b,
                        nonce: Date.now(),
                      }),
                    selectedBlockKey:
                      sidePanel?.mode === "block" ? sidePanel.block.key : null,
                    inspectMode: sidePanel?.mode ?? null,
                    highlightedBlockKey: highlightedBlock,
                    onTaskToggle: (lineIndex, checked) =>
                      toggleTaskAtLine(active.id, lineIndex, checked),
                    blockEls,
                  })}
                </div>
              )}

              {editMode && viewMode === "preview" && (
                <FloatingToolbar pos={floatPos} onAction={handleAction} />
              )}
            </div>

            {/* Panneau source latéral */}
            <div className={`side-source ${sidePanel ? "open" : ""}`}>
              {sidePanel && (
                <div className="side-source-inner">
                  <div className="side-head">
                    <span className="side-title">
                      {sidePanel.mode === "block" ? "Source" : "Source complète"}
                    </span>
                    {sidePanel.mode === "block" ? (
                      <>
                        <span className="side-kind">{sidePanel.block.kind}</span>
                        <span className="side-kind">
                          {`L${sidePanel.block.lineStart + 1}${sidePanel.block.lineEnd > sidePanel.block.lineStart ? `–${sidePanel.block.lineEnd + 1}` : ""}`}
                        </span>
                      </>
                    ) : (
                      <span className="pill-sync">
                        <span className="live-dot" />
                        Sync
                      </span>
                    )}
                    <span className="side-spacer" />
                    <button
                      className="icon-btn"
                      title="Copier"
                      onClick={() =>
                        navigator.clipboard?.writeText(
                          sidePanel.mode === "block"
                            ? sidePanel.block.sourceLines.join("\n")
                            : active.content,
                        )
                      }
                    >
                      <Icon.Copy />
                    </button>
                    <button
                      className="icon-btn"
                      title="Fermer"
                      onClick={() => {
                        setSidePanel(null);
                        setHighlightedBlock(null);
                      }}
                    >
                      <Icon.Close />
                    </button>
                  </div>
                  <div className="side-body" ref={sideBodyRef}>
                    {sidePanel.mode === "block" ? (
                      <SourceMini
                        content={sidePanel.block.sourceLines.join("\n")}
                        startLine={sidePanel.block.lineStart}
                      />
                    ) : (
                      <SourceMini
                        content={active.content}
                        startLine={0}
                        lineEls={lineEls}
                        currentSyncLine={syncLine}
                        lineToBlock={fullSourceLineToBlock}
                        highlightedBlock={highlightedBlock}
                        onJumpToBlock={jumpToBlock}
                      />
                    )}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Status bar */}
      <div className="statusbar">
        <span>{active?.name || "—"}</span>
        <span style={{ color: "var(--faint)" }}>·</span>
        <span>{wordCount(active?.content || "")} mots</span>
        <span style={{ color: "var(--faint)" }}>·</span>
        <span>{readTime(active?.content || "")} min de lecture</span>
        <span className="status-sep" />
        {active?.dirty && <span className="pill">non sauvegardé</span>}
        {editMode ? (
          <span className="pill live">modification</span>
        ) : (
          <span className="pill">lecture seule</span>
        )}
        <span className="pill">UTF-8</span>
        <span className="pill">Markdown</span>
      </div>

      {/* Tweaks panel */}
      <TweaksPanel
        open={tweaksOpen}
        onOpen={() => setTweaksOpen(true)}
        onClose={() => setTweaksOpen(false)}
      >
        <TweakSection label="Apparence" />
        <TweakRadio<Theme>
          label="Mode"
          value={tweaks.theme}
          options={[
            { label: "Clair", value: "light" },
            { label: "Sombre", value: "dark" },
          ]}
          onChange={(v) => setTweak("theme", v)}
        />
        <TweakSelect<Palette>
          label="Palette"
          value={tweaks.palette}
          options={[
            { label: "Graphite", value: "graphite" },
            { label: "Encre", value: "encre" },
            { label: "Sépia", value: "sepia" },
            { label: "Forêt", value: "foret" },
          ]}
          onChange={(v) => setTweak("palette", v)}
        />
        <TweakRadio<FontVariant>
          label="Police"
          value={tweaks.font}
          options={[
            { label: "Sans", value: "sans" },
            { label: "Serif", value: "serif" },
            { label: "Mono", value: "mono" },
          ]}
          onChange={(v) => setTweak("font", v)}
        />
        <TweakRadio<Density>
          label="Densité"
          value={tweaks.density}
          options={[
            { label: "Aéré", value: "aere" },
            { label: "Compact", value: "compact" },
          ]}
          onChange={(v) => setTweak("density", v)}
        />

        <TweakSection label="Onglets & barre d'outils" />
        <TweakSelect<TabStyle>
          label="Style d'onglets"
          value={tweaks.tabStyle}
          options={[
            { label: "Navigateur", value: "browser" },
            { label: "Éditeur de code", value: "vscode" },
            { label: "Pastilles", value: "pastille" },
          ]}
          onChange={(v) => setTweak("tabStyle", v)}
        />
        <TweakRadio<ToolbarPos>
          label="Toolbar"
          value={tweaks.toolbarPos}
          options={[
            { label: "Fixe", value: "top" },
            { label: "Flottante", value: "floating" },
          ]}
          onChange={(v) => setTweak("toolbarPos", v)}
        />

        <TweakSection label="Mise en page" />
        <TweakSlider
          label="Largeur du texte"
          value={sliderTextWidth}
          min={TEXT_WIDTH_MIN}
          max={textWidthMax}
          step={10}
          unit="px"
          onChange={(v) => setTweak("textWidth", v)}
        />

        <TweakSection label="Source" />
        <TweakToggle
          label="Scroll synchronisé"
          value={tweaks.syncScroll}
          onChange={(v) => setTweak("syncScroll", v)}
        />

        <TweakSection label="Fichier" />
        <TweakToggle
          label="Sauvegarde auto"
          value={tweaks.autoSave}
          onChange={(v) => setTweak("autoSave", v)}
        />
      </TweaksPanel>

      {pdfModalOpen && (
        <PdfExportModal
          initialFormat={tweaks.pdfPageFormat}
          initialColorMode={tweaks.pdfColorMode}
          onCancel={() => setPdfModalOpen(false)}
          onConfirm={handlePdfExport}
        />
      )}
    </div>
  );
}

export default App;
