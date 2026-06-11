import { useEffect, useState } from "react";
import { Icon } from "./Icons";
import type { ToolbarPos, ViewMode } from "../types";

export type ToolbarAction =
  | "undo"
  | "redo"
  | "bold"
  | "italic"
  | "strike"
  | "code"
  | "clearFormat"
  | "h1"
  | "h2"
  | "h3"
  | "ul"
  | "ol"
  | "quote"
  | "link";

type Props = {
  viewMode: ViewMode;
  onViewMode: (m: ViewMode) => void;
  onAction: (a: ToolbarAction) => void;
  pos: ToolbarPos;
};

const keepFocus = (e: React.MouseEvent) => e.preventDefault();

export function Toolbar({
  viewMode,
  onViewMode,
  onAction,
  pos,
}: Props) {
  // « Effacer le formatage » n'a de sens que sur une sélection non vide.
  const [hasSelection, setHasSelection] = useState(false);
  useEffect(() => {
    const onSelectionChange = () => {
      const sel = window.getSelection();
      setHasSelection(!!sel && sel.rangeCount > 0 && !sel.isCollapsed);
    };
    document.addEventListener("selectionchange", onSelectionChange);
    onSelectionChange();
    return () =>
      document.removeEventListener("selectionchange", onSelectionChange);
  }, []);

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
          <button
            className="tb-btn"
            title="Effacer le formatage de la sélection"
            disabled={!hasSelection}
            onMouseDown={keepFocus}
            onClick={() => onAction("clearFormat")}
          >
            <Icon.ClearFormat />
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
      </div>
    </div>
  );
}
