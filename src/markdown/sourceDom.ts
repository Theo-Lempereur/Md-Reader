import { normalizeMarkdown } from "./normalize";
import { marginIcon } from "./source";
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

/** Applique l'icône de marge correspondant au texte de la ligne. */
function applyMarginIcon(line: HTMLElement, text: string) {
  const margin = line.querySelector<HTMLElement>(".margin-icon");
  if (!margin) return;
  const mi = marginIcon(text);
  margin.className = `margin-icon ${mi ? mi.cls : ""}`;
  margin.textContent = mi ? mi.label : "";
}

/** Texte d'une cellule .src-content, ZWSP exclus. */
function srcContentText(content: HTMLElement): string {
  return (content.textContent || "").replace(/​/g, "");
}

/** Remplace le contenu d'une cellule .src-content par du texte brut (un seul
 * span, comme au rendu initial) et met à jour l'icône de marge. */
function setSrcContentText(content: HTMLElement, text: string) {
  content.innerHTML = "";
  const span = document.createElement("span");
  span.textContent = text || ZWSP;
  content.appendChild(span);
  const line = content.parentElement;
  if (line instanceof HTMLElement) applyMarginIcon(line, text);
}

function createSrcLineWithText(text: string): HTMLDivElement {
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
  span.textContent = text || ZWSP;
  content.appendChild(span);

  line.appendChild(ln);
  line.appendChild(margin);
  line.appendChild(content);
  applyMarginIcon(line, text);
  return line;
}

function createBlankSrcLine(): HTMLDivElement {
  return createSrcLineWithText("");
}

export function renumberSourceLines(root: HTMLElement) {
  const lines = root.querySelectorAll<HTMLElement>(".src-line > .ln");
  // Conserve l'offset éventuel (panneau de bloc : la 1re ligne n'est pas « 1 »).
  let base = 0;
  const first = lines[0]?.textContent;
  if (first) {
    const n = parseInt(first, 10);
    if (Number.isFinite(n) && n > 0) base = n - 1;
  }
  lines.forEach((el, i) => {
    el.textContent = String(base + i + 1);
  });
}

/** Reconstruit entièrement les lignes du DOM source à partir d'un markdown.
 * Conserve la numérotation de départ existante (offset des panneaux de bloc). */
export function rebuildSourceDom(root: HTMLElement, markdown: string) {
  const firstLn = root.querySelector<HTMLElement>(".src-line > .ln");
  let base = 0;
  if (firstLn?.textContent) {
    const n = parseInt(firstLn.textContent, 10);
    if (Number.isFinite(n) && n > 0) base = n - 1;
  }
  root.innerHTML = "";
  const lines = markdown.split("\n");
  lines.forEach((text, i) => {
    const line = createSrcLineWithText(text);
    const ln = line.querySelector<HTMLElement>(".ln");
    if (ln) ln.textContent = String(base + i + 1);
    root.appendChild(line);
  });
}

export function moveCaretToNextSrcLine(
  root: HTMLElement,
): { created: boolean } | null {
  const current = getCurrentSrcLine(root);
  if (!current) return null;
  const next = current.nextElementSibling;
  if (next instanceof HTMLDivElement && next.classList.contains("src-line")) {
    const content = next.querySelector<HTMLElement>(".src-content");
    if (content) {
      placeCaretAtStart(content);
      return { created: false };
    }
  }

  const blank = createBlankSrcLine();
  root.appendChild(blank);
  renumberSourceLines(root);
  const content = blank.querySelector<HTMLElement>(".src-content");
  if (content) placeCaretAtStart(content);
  return { created: true };
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

/** Place le caret à une colonne donnée (ZWSP exclus) dans une .src-content. */
function placeCaretAtColumn(content: HTMLElement, column: number): void {
  const sel = window.getSelection();
  if (!sel) return;
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  let remaining = Math.max(0, column);
  let targetNode: Text | null = null;
  let targetOffset = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const raw = node.data || "";
    const visible = raw.replace(/​/g, "");
    if (remaining <= visible.length) {
      let realOffset = 0;
      let counted = 0;
      while (realOffset < raw.length && counted < remaining) {
        if (raw[realOffset] !== ZWSP) counted++;
        realOffset++;
      }
      targetNode = node;
      targetOffset = realOffset;
      break;
    }
    remaining -= visible.length;
  }
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

export type SourceCaretContext = {
  line: HTMLDivElement;
  content: HTMLElement;
  /** Colonne du caret (ZWSP exclus). */
  column: number;
  /** Texte de la ligne (ZWSP exclus). */
  text: string;
};

/** Ligne + colonne du caret (sélection collapsed uniquement). */
export function getSourceCaretContext(
  root: HTMLElement,
): SourceCaretContext | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!range.collapsed) return null;
  if (!root.contains(range.startContainer)) return null;
  const content = findSrcContent(range.startContainer);
  if (!content) return null;
  const line = content.parentElement;
  if (!(line instanceof HTMLDivElement) || !line.classList.contains("src-line")) {
    return null;
  }
  const before = document.createRange();
  before.selectNodeContents(content);
  before.setEnd(range.startContainer, range.startOffset);
  const column = before.toString().replace(/​/g, "").length;
  return { line, content, column, text: srcContentText(content) };
}

/** Entrée : scinde la ligne courante au caret en deux lignes. */
export function splitSrcLineAtCaret(root: HTMLElement): boolean {
  const ctx = getSourceCaretContext(root);
  if (!ctx) return false;
  const before = ctx.text.slice(0, ctx.column);
  const after = ctx.text.slice(ctx.column);
  setSrcContentText(ctx.content, before);
  const newLine = createSrcLineWithText(after);
  ctx.line.parentNode?.insertBefore(newLine, ctx.line.nextSibling);
  renumberSourceLines(root);
  const content = newLine.querySelector<HTMLElement>(".src-content");
  if (content) placeCaretAtColumn(content, 0);
  return true;
}

/** Backspace en colonne 0 : fusionne la ligne courante dans la précédente. */
export function mergeSrcLineWithPrevious(root: HTMLElement): boolean {
  const ctx = getSourceCaretContext(root);
  if (!ctx || ctx.column !== 0) return false;
  const prev = ctx.line.previousElementSibling;
  if (!(prev instanceof HTMLDivElement) || !prev.classList.contains("src-line")) {
    return false;
  }
  const prevContent = prev.querySelector<HTMLElement>(".src-content");
  if (!prevContent) return false;
  const prevText = srcContentText(prevContent);
  setSrcContentText(prevContent, prevText + ctx.text);
  ctx.line.remove();
  renumberSourceLines(root);
  placeCaretAtColumn(prevContent, prevText.length);
  return true;
}

/** Suppr en fin de ligne : fusionne la ligne suivante dans la courante. */
export function mergeNextSrcLineIntoCurrent(root: HTMLElement): boolean {
  const ctx = getSourceCaretContext(root);
  if (!ctx || ctx.column !== ctx.text.length) return false;
  const next = ctx.line.nextElementSibling;
  if (!(next instanceof HTMLDivElement) || !next.classList.contains("src-line")) {
    return false;
  }
  const nextContent = next.querySelector<HTMLElement>(".src-content");
  if (!nextContent) return false;
  setSrcContentText(ctx.content, ctx.text + srcContentText(nextContent));
  next.remove();
  renumberSourceLines(root);
  placeCaretAtColumn(ctx.content, ctx.text.length);
  return true;
}

/** Insère du texte (possiblement multi-lignes) au caret, en créant les
 * lignes nécessaires. Utilisé par le collage. */
export function insertTextAtSourceCaret(
  root: HTMLElement,
  rawText: string,
): boolean {
  const ctx = getSourceCaretContext(root);
  if (!ctx) return false;
  const text = rawText.replace(/\r\n?/g, "\n");
  const before = ctx.text.slice(0, ctx.column);
  const after = ctx.text.slice(ctx.column);
  const parts = text.split("\n");

  if (parts.length === 1) {
    setSrcContentText(ctx.content, before + text + after);
    placeCaretAtColumn(ctx.content, ctx.column + text.length);
    return true;
  }

  setSrcContentText(ctx.content, before + parts[0]);
  let anchor: HTMLDivElement = ctx.line;
  for (let i = 1; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    const line = createSrcLineWithText(isLast ? parts[i] + after : parts[i]);
    anchor.parentNode?.insertBefore(line, anchor.nextSibling);
    anchor = line;
  }
  renumberSourceLines(root);
  const lastContent = anchor.querySelector<HTMLElement>(".src-content");
  if (lastContent) {
    placeCaretAtColumn(lastContent, parts[parts.length - 1].length);
  }
  return true;
}

/** Colonne (ZWSP exclus) d'une borne de `range` clampée au contenu `content`. */
function clampedBoundaryColumn(
  content: HTMLElement,
  range: Range,
  which: "start" | "end",
): number {
  const lineRange = document.createRange();
  lineRange.selectNodeContents(content);
  if (which === "start") {
    // Borne de début avant le début de la ligne → colonne 0.
    if (range.compareBoundaryPoints(Range.START_TO_START, lineRange) <= 0) {
      return 0;
    }
    const before = document.createRange();
    before.selectNodeContents(content);
    before.setEnd(range.startContainer, range.startOffset);
    return before.toString().replace(/​/g, "").length;
  }
  // Borne de fin après la fin de la ligne → toute la ligne.
  if (range.compareBoundaryPoints(Range.END_TO_END, lineRange) >= 0) {
    return srcContentText(content).length;
  }
  const before = document.createRange();
  before.selectNodeContents(content);
  before.setEnd(range.endContainer, range.endOffset);
  return before.toString().replace(/​/g, "").length;
}

/** Texte markdown de la sélection courante, sans numéros de ligne ni icônes
 * de marge. `null` si la sélection est vide ou hors du DOM source. */
export function getSourceSelectionText(root: HTMLElement): string | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (
    !root.contains(range.startContainer) ||
    !root.contains(range.endContainer)
  ) {
    return null;
  }
  const parts: string[] = [];
  root.querySelectorAll<HTMLElement>(".src-content").forEach((content) => {
    if (!range.intersectsNode(content)) return;
    const startCol = clampedBoundaryColumn(content, range, "start");
    const endCol = clampedBoundaryColumn(content, range, "end");
    parts.push(srcContentText(content).slice(startCol, endCol));
  });
  return parts.length ? parts.join("\n") : null;
}

/** Supprime la sélection courante (possiblement multi-lignes) du DOM source
 * en respectant la structure de lignes. Caret replacé au point de fusion. */
export function deleteSourceSelection(root: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
  const range = sel.getRangeAt(0);
  if (
    !root.contains(range.startContainer) ||
    !root.contains(range.endContainer)
  ) {
    return false;
  }
  const contents = Array.from(
    root.querySelectorAll<HTMLElement>(".src-content"),
  ).filter((c) => range.intersectsNode(c));
  if (!contents.length) return false;

  const first = contents[0];
  const last = contents[contents.length - 1];
  const startCol = clampedBoundaryColumn(first, range, "start");
  const endCol = clampedBoundaryColumn(last, range, "end");
  const firstText = srcContentText(first);
  const tail =
    first === last
      ? firstText.slice(endCol)
      : srcContentText(last).slice(endCol);
  setSrcContentText(first, firstText.slice(0, startCol) + tail);
  for (let i = 1; i < contents.length; i++) {
    contents[i].parentElement?.remove();
  }
  renumberSourceLines(root);
  placeCaretAtColumn(first, startCol);
  return true;
}
