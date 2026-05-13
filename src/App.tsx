import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import "katex/dist/katex.min.css";
import "./App.css";

import { SAMPLE_FILES } from "./data/sampleFiles";
import { readTime, wordCount } from "./markdown/render";
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

function App() {
  const [tweaks, setTweaks] = useState<Tweaks>(loadTweaks);
  const setTweak = <K extends keyof Tweaks>(key: K, value: Tweaks[K]) =>
    setTweaks((t) => ({ ...t, [key]: value }));

  const [tabs, setTabs] = useState<MdFile[]>(SAMPLE_FILES);
  const [activeId, setActiveId] = useState<string>(SAMPLE_FILES[0].id);
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
  const contentRef = useRef<HTMLDivElement | null>(null);
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
          setTabs((prev) =>
            prev.map((t) => (t.id === activeId ? { ...t, content: md } : t)),
          );
        }
      } else {
        const md = sourceRef.current?.getMarkdown();
        if (md != null) {
          setTabs((prev) =>
            prev.map((t) => (t.id === activeId ? { ...t, content: md } : t)),
          );
          // WYSIWYG-active reste monté (key stable). On rafraîchit son DOM.
          wysiwygHandles.current.get(activeId)?.refreshFromContent(md);
        }
      }
      setViewMode(newMode);
    },
    [viewMode, activeId],
  );

  const toggleEditMode = useCallback(() => {
    if (editMode && sourceVisible) {
      // Quitter l'édition pendant qu'on est en source : flush + refresh WYSIWYG.
      const md = sourceRef.current?.getMarkdown();
      if (md != null) {
        setTabs((prev) =>
          prev.map((t) => (t.id === activeId ? { ...t, content: md } : t)),
        );
        wysiwygHandles.current.get(activeId)?.refreshFromContent(md);
      }
    }
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
          setTabs((prev) =>
            prev.map((t) => (t.id === activeId ? { ...t, content: md } : t)),
          );
          wysiwygHandles.current.get(activeId)?.refreshFromContent(md);
        }
      }
      setActiveId(newId);
    },
    [sourceVisible, activeId],
  );

  useEffect(() => {
    window.localStorage.setItem(TWEAKS_STORAGE_KEY, JSON.stringify(tweaks));
  }, [tweaks]);

  // File actions
  const handleNew = useCallback(() => {
    const id = "nouveau-" + Date.now();
    const f: MdFile = {
      id,
      name: "sans-titre.md",
      content: "# Nouveau document\n\nCommencez à écrire…\n",
    };
    setTabs((prev) => [...prev, f]);
    setActiveId(id);
  }, []);

  const handleOpen = useCallback(async () => {
    try {
      const f = await openFileDialog();
      if (!f) return;
      const id = `file-${Date.now()}`;
      setTabs((prev) => [
        ...prev,
        { id, name: f.name, content: f.content, path: f.path },
      ]);
      setActiveId(id);
    } catch (err) {
      console.error("Ouverture échouée:", err);
    }
  }, []);

  const handleSaveAs = useCallback(async () => {
    const md = getActiveMarkdown();
    if (md == null) return;
    const tab = tabs.find((t) => t.id === activeId);
    if (!tab) return;
    try {
      const path = await saveAsDialog(md, tab.name);
      if (!path) return;
      setTabs((prev) =>
        prev.map((t) =>
          t.id === activeId
            ? { ...t, content: md, path, name: basename(path), dirty: false }
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
      await writeToPath(tab.path, md);
      setTabs((prev) =>
        prev.map((t) =>
          t.id === activeId ? { ...t, content: md, dirty: false } : t,
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
        writeToPath(t.path, md)
          .then(() => {
            setTabs((prev) =>
              prev.map((x) =>
                x.id === t.id ? { ...x, content: md, dirty: false } : x,
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
        y: rect.top - containerRect.top + (contentRef.current?.scrollTop || 0),
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
          <div className="welcome">
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
        ) : (
          <>
            {/* Tous les WysiwygEditor restent montés : préserve les modifs au switch d'onglet */}
            {tabs.map((tab) => {
              const isActive = tab.id === activeId;
              const wysiwygVisible = isActive && !sourceVisible;
              return (
                <div
                  key={tab.id}
                  style={{
                    display: wysiwygVisible ? "block" : "none",
                    height: "100%",
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
                </div>
              );
            })}
            {sourceVisible && (
              <SourceView
                ref={sourceRef}
                content={active.content}
                search={searchQ}
                currentHit={currentHit}
                onInput={() => markDirty(active.id)}
              />
            )}
          </>
        )}

        {editMode && viewMode === "preview" && (
          <FloatingToolbar pos={floatPos} onAction={handleAction} />
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
