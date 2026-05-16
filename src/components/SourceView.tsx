import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
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

    const handleKeyDown = useCallback(
      (e: ReactKeyboardEvent<HTMLDivElement>) => {
        const root = rootRef.current;
        if (!root) return;
        const key = e.key;
        const mod = e.ctrlKey || e.metaKey;

        if (mod && !e.altKey && !e.shiftKey && key === "Enter") {
          if (moveCaretToNextSrcLine(root)) {
            e.preventDefault();
            onInput?.();
          }
          return;
        }
        if (e.altKey && !mod && !e.shiftKey && key === "Enter") {
          if (insertBlankSrcLineBelow(root)) {
            e.preventDefault();
            onInput?.();
          }
          return;
        }
        if (mod && !e.altKey && !e.shiftKey && key.toLowerCase() === "l") {
          if (moveCaretToLineEnd()) {
            e.preventDefault();
          }
          return;
        }
      },
      [onInput],
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
        onKeyDown={handleKeyDown}
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

function getCurrentSrcLine(root: HTMLDivElement): HTMLDivElement | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const node = sel.getRangeAt(0).startContainer;
  if (!root.contains(node)) return null;
  const content = findSrcContent(node);
  const line = content?.parentElement;
  if (line instanceof HTMLDivElement && line.classList.contains("src-line")) {
    return line;
  }
  return null;
}

function placeCaretAtStart(el: HTMLElement) {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function placeCaretAtEnd(el: HTMLElement) {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

function createBlankSrcLine(): HTMLDivElement {
  const line = document.createElement("div");
  line.className = "src-line";

  const ln = document.createElement("div");
  ln.className = "ln";
  ln.contentEditable = "false";

  const margin = document.createElement("div");
  margin.className = "margin-icon";
  margin.contentEditable = "false";

  const content = document.createElement("div");
  content.className = "src-content";
  const span = document.createElement("span");
  span.textContent = "​";
  content.appendChild(span);

  line.appendChild(ln);
  line.appendChild(margin);
  line.appendChild(content);
  return line;
}

function renumberLines(root: HTMLDivElement) {
  const lines = root.querySelectorAll<HTMLDivElement>(".src-line > .ln");
  lines.forEach((el, i) => {
    el.textContent = String(i + 1);
  });
}

function moveCaretToNextSrcLine(root: HTMLDivElement): boolean {
  const current = getCurrentSrcLine(root);
  if (!current) return false;
  const next = current.nextElementSibling;
  if (next instanceof HTMLDivElement && next.classList.contains("src-line")) {
    const content = next.querySelector<HTMLDivElement>(".src-content");
    if (content) {
      placeCaretAtStart(content);
      return true;
    }
  }
  // Dernière ligne : créer une ligne vide à la fin.
  const blank = createBlankSrcLine();
  root.appendChild(blank);
  renumberLines(root);
  const content = blank.querySelector<HTMLDivElement>(".src-content");
  if (content) placeCaretAtStart(content);
  return true;
}

function insertBlankSrcLineBelow(root: HTMLDivElement): boolean {
  const current = getCurrentSrcLine(root);
  if (!current || !current.parentNode) return false;
  const blank = createBlankSrcLine();
  current.parentNode.insertBefore(blank, current.nextSibling);
  renumberLines(root);
  const content = blank.querySelector<HTMLDivElement>(".src-content");
  if (content) placeCaretAtStart(content);
  return true;
}

function moveCaretToLineEnd(): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const node = sel.getRangeAt(0).startContainer;
  const content = findSrcContent(node);
  if (!content) return false;
  placeCaretAtEnd(content);
  return true;
}
