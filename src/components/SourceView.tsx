import { forwardRef, useImperativeHandle, useRef } from "react";
import { normalizeMarkdown } from "../markdown/normalize";
import { highlightSearch, marginIcon, tokenizeLine } from "../markdown/source";
import type { SearchHit } from "../types";
import type { ToolbarAction } from "./Toolbar";

export type SourceViewHandle = {
  executeCommand: (action: ToolbarAction) => void;
  getMarkdown: () => string;
};

type Props = {
  content: string;
  search: string;
  currentHit: SearchHit | null;
  onInput?: () => void;
};

export const SourceView = forwardRef<SourceViewHandle, Props>(
  function SourceView({ content, search, currentHit, onInput }, ref) {
    const rootRef = useRef<HTMLDivElement | null>(null);

    useImperativeHandle(
      ref,
      () => ({
        executeCommand: (action) => {
          runSourceCommand(action);
          onInput?.();
        },
        getMarkdown: () => {
          const root = rootRef.current;
          if (!root) return normalizeMarkdown(content);
          const lines = Array.from(
            root.querySelectorAll<HTMLDivElement>(".src-content"),
          ).map((el) => (el.textContent || "").replace(/​/g, ""));
          return normalizeMarkdown(lines.join("\n"));
        },
      }),
      [content, onInput],
    );

    const normalizedContent = normalizeMarkdown(content);
    const lines = normalizedContent.split("\n");
    return (
      <div
        className="source"
        ref={rootRef}
        contentEditable
        suppressContentEditableWarning
        onInput={onInput}
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

  // undo / redo : délégué au contentEditable natif via le navigateur.
  if (action === "undo") {
    document.execCommand("undo");
    return;
  }
  if (action === "redo") {
    document.execCommand("redo");
    return;
  }
}

function findSrcContent(node: Node | null): HTMLElement | null {
  let cur: Node | null = node;
  while (cur) {
    if (
      cur instanceof HTMLElement &&
      cur.classList.contains("src-content")
    ) {
      return cur;
    }
    cur = cur.parentNode;
  }
  return null;
}
