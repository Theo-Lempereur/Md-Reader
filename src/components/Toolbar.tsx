import { Icon } from "./Icons";
import type { ToolbarPos, ViewMode } from "../types";

export type ToolbarAction =
  | "undo"
  | "redo"
  | "bold"
  | "italic"
  | "strike"
  | "code"
  | "h1"
  | "h2"
  | "h3"
  | "ul"
  | "ol"
  | "quote"
  | "link";

export type ExportKind = "md" | "html" | "pdf" | "print" | "copy";

type Props = {
  viewMode: ViewMode;
  onViewMode: (m: ViewMode) => void;
  onExport: (k: ExportKind) => void;
  onAction: (a: ToolbarAction) => void;
  exportOpen: boolean;
  setExportOpen: (v: boolean) => void;
  pos: ToolbarPos;
};

const keepFocus = (e: React.MouseEvent) => e.preventDefault();

export function Toolbar({
  viewMode,
  onViewMode,
  onExport,
  onAction,
  exportOpen,
  setExportOpen,
  pos,
}: Props) {
  return (
    <div className="toolbar-wrap" data-pos={pos}>
      <div className="toolbar">
        <div className="viewmode-switch">
          <button
            className={viewMode === "preview" ? "active" : ""}
            onClick={() => onViewMode("preview")}
          >
            Modifier
          </button>
          <button
            className={viewMode === "source" ? "active" : ""}
            onClick={() => onViewMode("source")}
          >
            Source
          </button>
        </div>
        <div className="tb-sep" />
        <div className="tb-group">
          <button
            className="tb-btn"
            title="Annuler ⌘Z"
            onMouseDown={keepFocus}
            onClick={() => onAction("undo")}
          >
            <Icon.Undo />
          </button>
          <button
            className="tb-btn"
            title="Rétablir ⇧⌘Z"
            onMouseDown={keepFocus}
            onClick={() => onAction("redo")}
          >
            <Icon.Redo />
          </button>
        </div>
        <div className="tb-sep" />
        <div className="tb-group">
          <button
            className="tb-btn"
            title="Gras ⌘B"
            onMouseDown={keepFocus}
            onClick={() => onAction("bold")}
          >
            <Icon.Bold />
          </button>
          <button
            className="tb-btn"
            title="Italique ⌘I"
            onMouseDown={keepFocus}
            onClick={() => onAction("italic")}
          >
            <Icon.Italic />
          </button>
          <button
            className="tb-btn"
            title="Barré"
            onMouseDown={keepFocus}
            onClick={() => onAction("strike")}
          >
            <Icon.Strike />
          </button>
          <button
            className="tb-btn"
            title="Code ⌘E"
            onMouseDown={keepFocus}
            onClick={() => onAction("code")}
          >
            <Icon.Code />
          </button>
        </div>
        <div className="tb-sep" />
        <div className="tb-group">
          <button
            className="tb-btn"
            title="Titre 1"
            onMouseDown={keepFocus}
            onClick={() => onAction("h1")}
          >
            <Icon.H1 />
          </button>
          <button
            className="tb-btn"
            title="Titre 2"
            onMouseDown={keepFocus}
            onClick={() => onAction("h2")}
          >
            <Icon.H2 />
          </button>
          <button
            className="tb-btn"
            title="Titre 3"
            onMouseDown={keepFocus}
            onClick={() => onAction("h3")}
          >
            <Icon.H3 />
          </button>
        </div>
        <div className="tb-sep" />
        <div className="tb-group">
          <button
            className="tb-btn"
            title="Liste à puces"
            onMouseDown={keepFocus}
            onClick={() => onAction("ul")}
          >
            <Icon.List />
          </button>
          <button
            className="tb-btn"
            title="Liste numérotée"
            onMouseDown={keepFocus}
            onClick={() => onAction("ol")}
          >
            <Icon.OrderedList />
          </button>
          <button
            className="tb-btn"
            title="Citation"
            onMouseDown={keepFocus}
            onClick={() => onAction("quote")}
          >
            <Icon.Quote />
          </button>
          <button
            className="tb-btn"
            title="Lien ⌘K"
            onMouseDown={keepFocus}
            onClick={() => onAction("link")}
          >
            <Icon.Link />
          </button>
        </div>
        <div className="tb-spacer" />
        <div className="export-wrap">
          <button
            className="tb-btn"
            onClick={() => setExportOpen(!exportOpen)}
            style={{ paddingLeft: 10, paddingRight: 8 }}
          >
            <Icon.Download />
            <span style={{ marginLeft: 4 }}>Exporter</span>
            <Icon.ChevronDown />
          </button>
          {exportOpen && (
            <div
              className="export-menu"
              onMouseLeave={() => setExportOpen(false)}
            >
              <button onClick={() => onExport("md")}>
                <span className="menu-icon">
                  <Icon.FileText />
                </span>
                Markdown (.md)
                <span className="kbd">⌘S</span>
              </button>
              <button onClick={() => onExport("html")}>
                <span className="menu-icon">
                  <Icon.Globe />
                </span>
                Page HTML
              </button>
              <button onClick={() => onExport("pdf")}>
                <span className="menu-icon">
                  <Icon.Download />
                </span>
                PDF
              </button>
              <hr />
              <button onClick={() => onExport("print")}>
                <span className="menu-icon">
                  <Icon.Print />
                </span>
                Imprimer
                <span className="kbd">⌘P</span>
              </button>
              <button onClick={() => onExport("copy")}>
                <span className="menu-icon">
                  <Icon.Copy />
                </span>
                Copier (HTML riche)
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
