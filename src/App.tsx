import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { emit, listen } from "@tauri-apps/api/event";
import "katex/dist/katex.min.css";
import "./App.css";

import { SAMPLE_FILES } from "./data/sampleFiles";
import {
  readTime,
  wordCount,
  renderMarkdownBlocks,
  type BlockInfo,
} from "./markdown/render";
import { normalizeMarkdown } from "./markdown/normalize";
import { tokenizeLine, marginIcon } from "./markdown/source";
import { Icon } from "./components/Icons";
import { SourceView, type SourceViewHandle } from "./components/SourceView";
import {
  Toolbar,
  type ExportKind,
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
import { WindowControls } from "./components/WindowControls";
import {
  basename,
  openFileDialog,
  saveAsDialog,
  writeToPath,
  type OpenedFile,
} from "./lib/fileIo";
import type {
  Density,
  FontVariant,
  MdFile,
  Palette,
  SearchHit,
  TabStyle,
  Theme,
  ToolbarPos,
  Tweaks,
  ViewMode,
} from "./types";

const DEFAULT_TWEAKS: Tweaks = {
  theme: "light",
  palette: "graphite",
  font: "sans",
  density: "aere",
  tabStyle: "pastille",
  toolbarPos: "floating",
  autoSave: false,
  textWidth: 60,
};

const TEXT_WIDTH_MIN = 30;
const TEXT_WIDTH_MAX = 100;
const TEXT_WIDTH_WHEEL_STEP = 2;
const TEXT_WIDTH_WHEEL_THRESHOLD = 60;

const TWEAKS_STORAGE_KEY = "md-reader:tweaks";

const TWEAK_OPTIONS = {
  theme: ["light", "dark"],
  palette: ["graphite", "encre", "sepia", "foret"],
  font: ["sans", "serif", "mono"],
  density: ["aere", "compact"],
  tabStyle: ["browser", "vscode", "pastille"],
  toolbarPos: ["top", "floating"],
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

function loadTweaks(): Tweaks {
  if (typeof window === "undefined") return DEFAULT_TWEAKS;

  try {
    const saved = window.localStorage.getItem(TWEAKS_STORAGE_KEY);
    if (!saved) return DEFAULT_TWEAKS;

    const parsed = JSON.parse(saved);
    if (!parsed || typeof parsed !== "object") return DEFAULT_TWEAKS;

    const s = parsed as Partial<Record<keyof Tweaks, unknown>>;
    return {
      theme: readStringTweak(s, "theme"),
      palette: readStringTweak(s, "palette"),
      font: readStringTweak(s, "font"),
      density: readStringTweak(s, "density"),
      tabStyle: readStringTweak(s, "tabStyle"),
      toolbarPos: readStringTweak(s, "toolbarPos"),
      autoSave: typeof s.autoSave === "boolean" ? s.autoSave : DEFAULT_TWEAKS.autoSave,
      textWidth:
        typeof s.textWidth === "number" &&
        s.textWidth >= TEXT_WIDTH_MIN &&
        s.textWidth <= TEXT_WIDTH_MAX
          ? s.textWidth
          : DEFAULT_TWEAKS.textWidth,
    };
  } catch {
    return DEFAULT_TWEAKS;
  }
}

function clampTextWidth(value: number): number {
  return Math.min(TEXT_WIDTH_MAX, Math.max(TEXT_WIDTH_MIN, value));
}

type SidePanel =
  | { mode: "block"; block: BlockInfo }
  | { mode: "full"; initialBlock: BlockInfo }
  | null;

function SourceMini({
  content,
  startLine = 0,
  lineEls,
  currentSyncLine,
}: {
  content: string;
  startLine?: number;
  lineEls?: React.MutableRefObject<Map<number, HTMLDivElement>>;
  currentSyncLine?: number | null;
}) {
  const lines = normalizeMarkdown(content).split("\n");
  return (
    <div className="source source-mini">
      {lines.map((line, i) => {
        const absIdx = startLine + i;
        const mi = marginIcon(line);
        return (
          <div
            key={i}
            className={`src-line${currentSyncLine === absIdx ? " sync-current" : ""}`}
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

  const [tabs, setTabs] = useState<MdFile[]>(
    SAMPLE_FILES.map(normalizeTabContent),
  );
  const [activeId, setActiveId] = useState<string>(SAMPLE_FILES[0].id);
  const tabsRef = useRef<MdFile[]>(SAMPLE_FILES.map(normalizeTabContent));
  const [editMode, setEditMode] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("preview");
  const [exportOpen, setExportOpen] = useState(false);
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const [currentHit] = useState<SearchHit | null>(null);
  const [floatPos, setFloatPos] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [tweaksOpen, setTweaksOpen] = useState(false);
  const [sidePanel, setSidePanel] = useState<SidePanel>(null);
  const [syncLine, setSyncLine] = useState<number | null>(null);
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

  const active = tabs.find((t) => t.id === activeId) || tabs[0];
  const sourceVisible = !!active && editMode && viewMode === "source";

  const getActiveMarkdown = useCallback((): string | null => {
    if (sourceVisible) return sourceRef.current?.getMarkdown() ?? null;
    return wysiwygHandles.current.get(activeId)?.getMarkdown() ?? null;
  }, [sourceVisible, activeId]);

  const markDirty = useCallback((id: string) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === id && !t.dirty ? { ...t, dirty: true } : t)),
    );
  }, []);

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
    [viewMode, activeId],
  );

  const toggleEditMode = useCallback(() => {
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
    setEditMode((v) => !v);
  }, [editMode, sourceVisible, activeId]);

  const switchTab = useCallback(
    (newId: string) => {
      if (newId === activeId) return;
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
    [sourceVisible, activeId],
  );

  useEffect(() => {
    window.localStorage.setItem(TWEAKS_STORAGE_KEY, JSON.stringify(tweaks));
  }, [tweaks]);

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

  const addOrFocusTab = useCallback((f: OpenedFile) => {
    const existing = tabsRef.current.find((t) => t.path === f.path);
    if (existing) {
      setActiveId(existing.id);
      return;
    }

    const id = `file-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const nextTabs = [
      ...tabsRef.current,
      { id, name: f.name, content: normalizeMarkdown(f.content), path: f.path },
    ];
    tabsRef.current = nextTabs;
    setTabs(nextTabs);
    setActiveId(id);
  }, []);

  const handleOpen = useCallback(async () => {
    try {
      const f = await openFileDialog();
      if (!f) return;
      addOrFocusTab(f);
    } catch (err) {
      console.error("Ouverture échouée:", err);
    }
  }, [addOrFocusTab]);

  useEffect(() => {
    const unlisten = listen<OpenedFile>("open-file", (event) => {
      addOrFocusTab(event.payload);
    });

    emit("frontend-ready").catch((err) =>
      console.error("Signal frontend-ready échoué:", err),
    );

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [addOrFocusTab]);

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
        setExportOpen(false);
        setFileMenuOpen(false);
      } else if (mod && key === "e") {
        e.preventDefault();
        toggleEditMode();
      } else if (mod && key === "p") {
        e.preventDefault();
        window.print();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleSave, handleSaveAs, handleOpen, handleNew, toggleEditMode]);

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
    blockEls.current.clear();
    lineEls.current.clear();
  }, [activeId]);

  // En mode "source complète", scroll initial vers le bloc cliqué.
  useEffect(() => {
    if (sidePanel?.mode !== "full") return;
    const ln = sidePanel.initialBlock.lineStart;
    let raf2 = 0;
    const raf = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const target = lineEls.current.get(ln);
        const body = sideBodyRef.current;
        if (target && body) {
          syncingRef.current = true;
          body.scrollTop = target.offsetTop - 16;
          setSyncLine(ln);
          setTimeout(() => {
            syncingRef.current = false;
          }, 280);
        }
      });
    });
    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(raf2);
    };
  }, [sidePanel]);

  // Scroll synchronisé en mode "source complète".
  useEffect(() => {
    if (sidePanel?.mode !== "full") return;
    const reading = readingPaneRef.current;
    const side = sideBodyRef.current;
    if (!reading || !side) return;

    const onReadingScroll = () => {
      if (syncingRef.current) return;
      const anchor = reading.scrollTop + 40;
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
      side.scrollTop = targetEl.offsetTop - 16;
      setSyncLine(bi.lineStart);
      requestAnimationFrame(() => {
        syncingRef.current = false;
      });
    };

    const onSideScroll = () => {
      if (syncingRef.current) return;
      const anchor = side.scrollTop + 16;
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
      reading.scrollTop = bb.el.offsetTop - 24;
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
  }, [sidePanel]);

  const closeTab = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const next = tabs.filter((t) => t.id !== id);
    wysiwygHandles.current.delete(id);
    setTabs(next);
    if (activeId === id && next.length) setActiveId(next[0].id);
  };

  const onExport = (kind: ExportKind) => {
    setExportOpen(false);
    if (kind === "print") window.print();
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
      style={{ "--reading-width": `${tweaks.textWidth}%` } as CSSProperties}
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
          <div style={{ width: 6 }} />
          <button
            className={`edit-toggle ${editMode ? "on" : ""}`}
            onClick={toggleEditMode}
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
          onExport={onExport}
          onAction={handleAction}
          exportOpen={exportOpen}
          setExportOpen={setExportOpen}
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
          <div className="welcome" style={{ flex: 1 }}>
            <h1>Aucun document ouvert</h1>
            <p>Glissez un fichier .md ici, ou créez-en un nouveau.</p>
            <div className="kbds">
              <span className="kbd">⌘N</span>
              <span
                style={{
                  alignSelf: "center",
                  color: "var(--muted)",
                  fontSize: 11,
                }}
              >
                nouveau
              </span>
            </div>
          </div>
        ) : sourceVisible ? (
          <div style={{ flex: 1, overflow: "auto" }}>
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
                      <div className="reading reading-blocks-overlay" aria-hidden="true">
                        {renderMarkdownBlocks(active.content, {
                          onInspect: (b) =>
                            setSidePanel((prev) =>
                              prev?.mode === "block" && prev.block.key === b.key
                                ? null
                                : { mode: "block", block: b },
                            ),
                          onOpenFull: (b) =>
                            setSidePanel((prev) =>
                              prev?.mode === "full" ? null : { mode: "full", initialBlock: b },
                            ),
                          selectedBlockKey:
                            sidePanel?.mode === "block" ? sidePanel.block.key : null,
                          inspectMode: sidePanel?.mode ?? null,
                          blockEls,
                        })}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Prévisualisation lecture avec boutons de bloc */}
              {!editMode && (
                <div className="reading">
                  {renderMarkdownBlocks(active.content, {
                    onInspect: (b) =>
                      setSidePanel((prev) =>
                        prev?.mode === "block" && prev.block.key === b.key
                          ? null
                          : { mode: "block", block: b },
                      ),
                    onOpenFull: (b) =>
                      setSidePanel((prev) =>
                        prev?.mode === "full" ? null : { mode: "full", initialBlock: b },
                      ),
                    selectedBlockKey:
                      sidePanel?.mode === "block" ? sidePanel.block.key : null,
                    inspectMode: sidePanel?.mode ?? null,
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
                      onClick={() => setSidePanel(null)}
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
          value={tweaks.textWidth}
          min={TEXT_WIDTH_MIN}
          max={TEXT_WIDTH_MAX}
          step={1}
          unit="%"
          onChange={(v) => setTweak("textWidth", v)}
        />

        <TweakSection label="Fichier" />
        <TweakToggle
          label="Sauvegarde auto"
          value={tweaks.autoSave}
          onChange={(v) => setTweak("autoSave", v)}
        />
      </TweaksPanel>
    </div>
  );
}

export default App;
