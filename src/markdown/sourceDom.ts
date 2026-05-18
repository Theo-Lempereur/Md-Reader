import { normalizeMarkdown } from "./normalize";
import type { SourceCaret } from "../types";

const ZWSP = "\u200b";

export function readMarkdownFromSourceRoot(
  root: HTMLElement | null,
  fallback = "",
): string {
  if (!root) return normalizeMarkdown(fallback);
  const lines = Array.from(
    root.querySelectorAll<HTMLElement>(".src-content"),
  ).map((el) => (el.textContent || "").replace(/\u200b/g, ""));
  return normalizeMarkdown(lines.join("\n"));
}

export function findSrcContent(node: Node | null): HTMLElement | null {
  let cur: Node | null = node;
  while (cur) {
    if (cur instanceof HTMLElement && cur.classList.contains("src-content")) {
      return cur;
    }
    cur = cur.parentNode;
  }
  return null;
}

function getCurrentSrcLine(root: HTMLElement): HTMLDivElement | null {
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

export function placeCaretAtStart(el: HTMLElement) {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

export function placeCaretAtEnd(el: HTMLElement) {
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
  span.textContent = ZWSP;
  content.appendChild(span);

  line.appendChild(ln);
  line.appendChild(margin);
  line.appendChild(content);
  return line;
}

export function renumberSourceLines(root: HTMLElement) {
  const lines = root.querySelectorAll<HTMLElement>(".src-line > .ln");
  lines.forEach((el, i) => {
    el.textContent = String(i + 1);
  });
}

export function moveCaretToNextSrcLine(root: HTMLElement): boolean {
  const current = getCurrentSrcLine(root);
  if (!current) return false;
  const next = current.nextElementSibling;
  if (next instanceof HTMLDivElement && next.classList.contains("src-line")) {
    const content = next.querySelector<HTMLElement>(".src-content");
    if (content) {
      placeCaretAtStart(content);
      return true;
    }
  }

  const blank = createBlankSrcLine();
  root.appendChild(blank);
  renumberSourceLines(root);
  const content = blank.querySelector<HTMLElement>(".src-content");
  if (content) placeCaretAtStart(content);
  return true;
}

export function insertBlankSrcLineBelow(root: HTMLElement): boolean {
  const current = getCurrentSrcLine(root);
  if (!current || !current.parentNode) return false;
  const blank = createBlankSrcLine();
  current.parentNode.insertBefore(blank, current.nextSibling);
  renumberSourceLines(root);
  const content = blank.querySelector<HTMLElement>(".src-content");
  if (content) placeCaretAtStart(content);
  return true;
}

export function moveCaretToLineEnd(): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const node = sel.getRangeAt(0).startContainer;
  const content = findSrcContent(node);
  if (!content) return false;
  placeCaretAtEnd(content);
  return true;
}

export function readSourceCaret(root: HTMLElement | null): SourceCaret | null {
  if (!root) return null;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer)) return null;
  const content = findSrcContent(range.startContainer);
  if (!content) return null;
  const line = content.parentElement;
  if (!(line instanceof HTMLDivElement)) return null;
  const lines = Array.from(root.children).filter(
    (el): el is HTMLDivElement =>
      el instanceof HTMLDivElement && el.classList.contains("src-line"),
  );
  const lineIndex = lines.indexOf(line);
  if (lineIndex < 0) return null;
  const before = document.createRange();
  before.selectNodeContents(content);
  before.setEnd(range.startContainer, range.startOffset);
  const column = (before.toString() || "").replace(/\u200b/g, "").length;
  return { line: lineIndex, column };
}

export function writeSourceCaret(
  root: HTMLElement | null,
  caret: SourceCaret,
): void {
  if (!root) return;
  const lines = Array.from(root.children).filter(
    (el): el is HTMLDivElement =>
      el instanceof HTMLDivElement && el.classList.contains("src-line"),
  );
  if (!lines.length) return;
  const line = lines[Math.max(0, Math.min(caret.line, lines.length - 1))];
  const content = line.querySelector<HTMLElement>(".src-content");
  if (!content) return;
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  let remaining = caret.column;
  let targetNode: Text | null = null;
  let targetOffset = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const text = (node.data || "").replace(/\u200b/g, "");
    if (remaining <= text.length) {
      let realOffset = 0;
      let counted = 0;
      const raw = node.data || "";
      while (realOffset < raw.length && counted < remaining) {
        if (raw[realOffset] !== ZWSP) counted++;
        realOffset++;
      }
      targetNode = node;
      targetOffset = realOffset;
      break;
    }
    remaining -= text.length;
  }
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  if (targetNode) {
    range.setStart(targetNode, targetOffset);
  } else {
    range.selectNodeContents(content);
    range.collapse(false);
  }
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}
