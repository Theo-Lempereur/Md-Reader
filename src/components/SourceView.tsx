import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { normalizeMarkdown } from "../markdown/normalize";
import { highlightSearch, marginIcon, tokenizeLine } from "../markdown/source";
import {
  findSrcContent,
  readMarkdownFromSourceRoot,
  readSourceCaret,
  writeSourceCaret,
} from "../markdown/sourceDom";
import { useSourceEditing } from "../lib/useSourceEditing";
import { useSourceUndo } from "../lib/useSourceUndo";
import type { SearchHit, SourceCaret } from "../types";
import type { ToolbarAction } from "./Toolbar";

export type SourceViewHandle = {
  executeCommand: (action: ToolbarAction) => void;
  getMarkdown: () => string;
  getCaret: () => SourceCaret | null;
  setCaret: (c: SourceCaret) => void;
  getScrollTop: () => number;
  setScrollTop: (top: number) => void;
  scrollToLine: (line: number) => void;
  focus: () => void;
};

type Props = {
  content: string;
  search: string;
  currentHit: SearchHit | null;
  /** Identifiant de la cible éditée (onglet) : un changement vide l'historique d'annulation. */
  undoKey?: string;
  onInput?: () => void;
};

export const SourceView = forwardRef<SourceViewHandle, Props>(
  function SourceView({ content, search, currentHit, undoKey, onInput }, ref) {
    const rootRef = useRef<HTMLDivElement | null>(null);

    const normalizedContent = normalizeMarkdown(content);

    const undo = useSourceUndo({
      rootRef,
      content: normalizedContent,
      resetKey: undoKey,
      onRestore: () => onInput?.(),
    });

    const notifyEdit = useCallback(() => {
      undo.scheduleCommit();
      onInput?.();
    }, [undo, onInput]);

    const editing = useSourceEditing({
      rootRef,
      onEdit: notifyEdit,
      onUndo: undo.undo,
      onRedo: undo.redo,
    });

    // Le DOM d'un contentEditable diverge de ce que React connaît dès la
    // première frappe : re-réconcilier provoque des NotFoundError. À chaque
    // changement de rendu (contenu flushé, recherche), on REMONTE donc le
    // sous-arbre complet (clé), en capturant caret/focus juste avant.
    const remountIdRef = useRef(0);
    const remountInfoRef = useRef<{
      caret: SourceCaret | null;
      hadFocus: boolean;
    }>({ caret: null, hadFocus: false });
    const remountKey = useMemo(() => {
      const root = rootRef.current;
      remountInfoRef.current = {
        caret: root ? readSourceCaret(root) : null,
        hadFocus:
          !!root &&
          (document.activeElement === root ||
            root.contains(document.activeElement)),
      };
      return ++remountIdRef.current;
      // Dépendances par VALEUR : l'identité de currentHit change à chaque
      // recalcul des hits, pas forcément sa position.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
      normalizedContent,
      search,
      currentHit?.line,
      currentHit?.start,
      currentHit?.end,
    ]);

    useLayoutEffect(() => {
      const info = remountInfoRef.current;
      remountInfoRef.current = { caret: null, hadFocus: false };
      if (!info.hadFocus || !info.caret) return;
      const root = rootRef.current;
      if (!root) return;
      root.focus();
      writeSourceCaret(root, info.caret);
    }, [remountKey]);

    useImperativeHandle(
      ref,
      () => ({
        executeCommand: (action) => {
          if (action === "undo") {
            undo.undo();
            return;
          }
          if (action === "redo") {
            undo.redo();
            return;
          }
          runSourceCommand(action);
          notifyEdit();
        },
        getMarkdown: () => {
          return readMarkdownFromSourceRoot(rootRef.current, content);
        },
        getCaret: () => readSourceCaret(rootRef.current),
        setCaret: (c) => writeSourceCaret(rootRef.current, c),
        getScrollTop: () => rootRef.current?.parentElement?.scrollTop ?? 0,
        setScrollTop: (top) => {
          const scroller = rootRef.current?.parentElement;
          if (scroller) scroller.scrollTop = top;
        },
        scrollToLine: (line) => {
          const row = rootRef.current?.children.item(line);
          if (row instanceof HTMLElement) {
            row.scrollIntoView({ block: "center", inline: "nearest" });
          }
        },
        focus: () => rootRef.current?.focus(),
      }),
      [content, notifyEdit, undo],
    );

    useEffect(() => {
      if (!currentHit) return;
      const row = rootRef.current?.children.item(currentHit.line);
      if (row instanceof HTMLElement) {
        row.scrollIntoView({ block: "center", inline: "nearest" });
      }
    }, [currentHit]);

    const lines = normalizedContent.split("\n");
    return (
      <div
        key={remountKey}
        className="source"
        ref={rootRef}
        contentEditable
        suppressContentEditableWarning
        onInput={notifyEdit}
        onKeyDown={editing.onKeyDown}
        onPaste={editing.onPaste}
        onCopy={editing.onCopy}
        onCut={editing.onCut}
      >
        {lines.map((line, i) => {
          const mi = marginIcon(line);
          return (
            <div key={i} className="src-line">
              <div className="ln" contentEditable={false}>
                {i + 1}
              </div>
              <div
                className={`margin-icon ${mi ? mi.cls : ""}`}
                contentEditable={false}
              >
                {mi ? mi.label : ""}
              </div>
              <div className="src-content">
                {search
                  ? highlightSearch(line, search, i, currentHit)
                  : line
                    ? tokenizeLine(line, i)
                    : <span>{"​"}</span>}
              </div>
            </div>
          );
        })}
      </div>
    );
  },
);

const INLINE_MARKERS: Partial<Record<ToolbarAction, [string, string]>> = {
  bold: ["**", "**"],
  italic: ["*", "*"],
  strike: ["~~", "~~"],
  code: ["`", "`"],
};

const BLOCK_PREFIXES: Partial<Record<ToolbarAction, string>> = {
  h1: "# ",
  h2: "## ",
  h3: "### ",
  quote: "> ",
  ul: "- ",
  ol: "1. ",
};

function runSourceCommand(action: ToolbarAction) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);

  const lineEl = findSrcContent(range.startContainer);
  if (!lineEl) return;

  if (action === "link") {
    const url = window.prompt("URL ?");
    if (!url) return;
    if (range.collapsed) {
      const node = document.createTextNode(`[](${url})`);
      range.insertNode(node);
      const after = document.createRange();
      after.setStart(node, 1);
      after.collapse(true);
      sel.removeAllRanges();
      sel.addRange(after);
    } else {
      const text = range.toString();
      range.deleteContents();
      const node = document.createTextNode(`[${text}](${url})`);
      range.insertNode(node);
      const after = document.createRange();
      after.setStartAfter(node);
      after.collapse(true);
      sel.removeAllRanges();
      sel.addRange(after);
    }
    return;
  }

  const inline = INLINE_MARKERS[action];
  if (inline) {
    const [open, close] = inline;
    if (range.collapsed) {
      const node = document.createTextNode(open + close);
      range.insertNode(node);
      const after = document.createRange();
      after.setStart(node, open.length);
      after.collapse(true);
      sel.removeAllRanges();
      sel.addRange(after);
    } else {
      const text = range.toString();
      range.deleteContents();
      const node = document.createTextNode(open + text + close);
      range.insertNode(node);
      const after = document.createRange();
      after.setStartAfter(node);
      after.collapse(true);
      sel.removeAllRanges();
      sel.addRange(after);
    }
    return;
  }

  const prefix = BLOCK_PREFIXES[action];
  if (prefix) {
    // Préfixer la ligne entière, peu importe la position du caret.
    const current = lineEl.textContent || "";
    if (!current.startsWith(prefix)) {
      lineEl.textContent = prefix + current;
    }
    // Place le caret à la fin de la ligne.
    if (lineEl.firstChild) {
      const after = document.createRange();
      after.setStart(
        lineEl.firstChild,
        lineEl.firstChild.textContent?.length ?? 0,
      );
      after.collapse(true);
      sel.removeAllRanges();
      sel.addRange(after);
    }
    return;
  }
}
