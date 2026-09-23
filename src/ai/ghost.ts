/** Autocomplétion par texte fantôme.
 *
 * Un `<span contenteditable="false" data-ai-ghost>` est inséré au caret après
 * ~400 ms d'inactivité (ou à la demande avec Ctrl+Espace). Précautions :
 *  - il est exclu de `htmlToMarkdown`, des instantanés d'annulation et de la
 *    lecture du DOM source (donc des sauvegardes) ;
 *  - il disparaît à la moindre frappe, clic ou déplacement du caret, et la
 *    requête en cours est annulée (AbortController) ;
 *  - Tab ne l'accepte QUE s'il est visible : sans fantôme, Tab garde son
 *    comportement existant (listes, tableaux, formules). */

import { completeText } from "./client";
import { COMPLETE_SYSTEM, completePrompt } from "./prompts";
import type { AiBridge, ProviderId } from "./types";

export const GHOST_ATTR = "data-ai-ghost";
const IDLE_MS = 400;

export type GhostOptions = {
  provider: ProviderId;
  model: string;
  /** Déclenchement automatique à l'inactivité ; sinon Ctrl+Espace seulement. */
  auto: boolean;
};

type Anchor = { node: Node; offset: number };

export function attachGhost(bridge: AiBridge, getOptions: () => GhostOptions | null): () => void {
  let ghost: HTMLSpanElement | null = null;
  let anchor: Anchor | null = null;
  let idleTimer: number | null = null;
  let controller: AbortController | null = null;
  let seq = 0;
  let placing = false;

  const cancelRequest = () => {
    if (idleTimer != null) {
      window.clearTimeout(idleTimer);
      idleTimer = null;
    }
    controller?.abort();
    controller = null;
    seq++;
  };

  const removeGhost = () => {
    if (ghost?.isConnected) ghost.remove();
    ghost = null;
    anchor = null;
  };

  const clearAll = () => {
    cancelRequest();
    removeGhost();
  };

  const caretInEditor = (): { root: ReturnType<AiBridge["getEditorRoot"]>; range: Range } | null => {
    const root = bridge.getEditorRoot();
    const sel = window.getSelection();
    if (!root || !sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    if (!root.el.contains(range.startContainer)) return null;
    return { root, range };
  };

  /** Le caret doit être en fin de ligne / de bloc, hors code et formules. */
  const eligible = (rootEl: HTMLElement, kind: "wysiwyg" | "source", range: Range): boolean => {
    const start =
      range.startContainer.nodeType === 1
        ? (range.startContainer as Element)
        : range.startContainer.parentElement;
    if (!start) return false;
    if (kind === "wysiwyg") {
      if (start.closest("pre, code, .math-edit, .math-inline, .math-block")) return false;
      const block = start.closest("p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th") ?? rootEl;
      const after = document.createRange();
      after.setStart(range.startContainer, range.startOffset);
      after.setEnd(block, block.childNodes.length);
      return !after.toString().replace(/​/g, "").trim();
    }
    const content = start.closest(".src-content");
    if (!content) return false;
    const after = document.createRange();
    after.setStart(range.startContainer, range.startOffset);
    after.setEnd(content, content.childNodes.length);
    return !after.toString().replace(/​/g, "").trim();
  };

  const surroundingText = (
    rootEl: HTMLElement,
    kind: "wysiwyg" | "source",
    range: Range,
  ): { before: string; after: string } | null => {
    if (kind === "source") {
      const caret = bridge.getCaretOffset();
      if (!caret) return null;
      return {
        before: caret.markdown.slice(Math.max(0, caret.offset - 2000), caret.offset),
        after: caret.markdown.slice(caret.offset, caret.offset + 500),
      };
    }
    const before = document.createRange();
    before.setStart(rootEl, 0);
    before.setEnd(range.startContainer, range.startOffset);
    const after = document.createRange();
    after.setStart(range.startContainer, range.startOffset);
    after.setEnd(rootEl, rootEl.childNodes.length);
    return {
      before: before.toString().replace(/​/g, "").slice(-2000),
      after: after.toString().replace(/​/g, "").slice(0, 500),
    };
  };

  const request = async () => {
    const opts = getOptions();
    const here = caretInEditor();
    if (!opts || !here || !here.root) return;
    if (!eligible(here.root.el, here.root.kind, here.range)) return;
    const ctx = surroundingText(here.root.el, here.root.kind, here.range);
    if (!ctx || ctx.before.trim().length < 12) return;

    cancelRequest();
    const mySeq = seq;
    const at: Anchor = { node: here.range.startContainer, offset: here.range.startOffset };
    controller = new AbortController();
    let text: string;
    try {
      text = await completeText(
        {
          provider: opts.provider,
          model: opts.model,
          system: COMPLETE_SYSTEM,
          messages: [{ role: "user", content: completePrompt(ctx.before, ctx.after) }],
          mode: "complete",
          maxTokens: 48,
          stop: ["\n\n"],
          rawPrefix: ctx.before,
        },
        controller.signal,
      );
    } catch {
      return;
    }
    if (mySeq !== seq) return;
    // Première ligne seulement, et jamais de doublon avec ce qui précède.
    let suggestion = text.replace(/^\n+/, "").split("\n")[0].replace(/\s+$/, "");
    if (!suggestion.trim()) return;
    // Après une ponctuation, une suggestion qui commence par un mot a besoin
    // d'une espace ; ailleurs, le modèle décide (il peut finir un mot).
    if (/[.!?:;,]$/.test(ctx.before) && /^[\p{L}\p{N}]/u.test(suggestion)) {
      suggestion = " " + suggestion;
    }
    // La continuation brute apporte souvent sa propre espace initiale.
    if (/\s$/.test(ctx.before)) suggestion = suggestion.replace(/^[ \t]+/, "");
    // Une phrase au plus : au-delà, la suggestion devient un paragraphe imposé.
    const sentence = /^.*?[.!?…](?=\s|$)/su.exec(suggestion);
    if (sentence && sentence[0].trim()) suggestion = sentence[0];
    suggestion = suggestion.slice(0, 240);
    const now = caretInEditor();
    if (!now || now.range.startContainer !== at.node || now.range.startOffset !== at.offset) return;
    show(now.range, suggestion);
  };

  const show = (range: Range, text: string) => {
    removeGhost();
    const span = document.createElement("span");
    span.setAttribute("contenteditable", "false");
    span.setAttribute(GHOST_ATTR, "");
    span.className = "ai-ghost";
    span.textContent = text;
    placing = true;
    try {
      range.insertNode(span);
      const caret = document.createRange();
      caret.setStartBefore(span);
      caret.collapse(true);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(caret);
      ghost = span;
      anchor = { node: caret.startContainer, offset: caret.startOffset };
    } finally {
      // selectionchange est asynchrone : on l'ignore jusqu'à la frame suivante.
      requestAnimationFrame(() => (placing = false));
    }
  };

  const accept = () => {
    if (!ghost) return;
    const text = ghost.textContent ?? "";
    const g = ghost;
    ghost = null;
    anchor = null;
    const caret = document.createRange();
    caret.setStartBefore(g);
    caret.collapse(true);
    g.remove();
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(caret);
    // insertText déclenche `input` : l'annulation maison et le marquage
    // « modifié » fonctionnent comme pour une frappe normale.
    document.execCommand("insertText", false, text);
  };

  const inEditor = (target: EventTarget | null) => {
    const root = bridge.getEditorRoot();
    return !!root && target instanceof Node && root.el.contains(target);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (ghost) {
      if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        cancelRequest();
        accept();
        return;
      }
      if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
      clearAll();
      if (e.key === "Escape") e.preventDefault();
    } else {
      cancelRequest();
    }
    if (e.ctrlKey && e.code === "Space" && inEditor(e.target)) {
      e.preventDefault();
      void request();
    }
  };

  const onInput = (e: Event) => {
    if (!inEditor(e.target)) return;
    clearAll();
    if (!getOptions()?.auto) return;
    idleTimer = window.setTimeout(() => {
      idleTimer = null;
      void request();
    }, IDLE_MS);
  };

  const onSelection = () => {
    if (!ghost || placing) return;
    const sel = window.getSelection();
    const r = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    if (!r || !anchor || !r.collapsed || r.startContainer !== anchor.node || r.startOffset !== anchor.offset) {
      clearAll();
    }
  };

  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("input", onInput, true);
  document.addEventListener("mousedown", clearAll, true);
  document.addEventListener("compositionstart", clearAll, true);
  document.addEventListener("focusout", clearAll, true);
  document.addEventListener("selectionchange", onSelection);
  return () => {
    clearAll();
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("input", onInput, true);
    document.removeEventListener("mousedown", clearAll, true);
    document.removeEventListener("compositionstart", clearAll, true);
    document.removeEventListener("focusout", clearAll, true);
    document.removeEventListener("selectionchange", onSelection);
  };
}
