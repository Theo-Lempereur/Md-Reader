import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { normalizeMarkdown } from "../markdown/normalize";
import { renderMarkdown } from "../markdown/render";
import { htmlToMarkdown } from "../lib/htmlToMarkdown";
import { attachMathDoubleClick } from "../slash/math";
import { runWysiwygCommand } from "../slash/runners";
import { useSlashCommand } from "../slash/useSlashCommand";
import { SlashMenu } from "./SlashMenu";
import type { ToolbarAction } from "./Toolbar";
import type { PreviewCaret } from "../types";

export type WysiwygEditorHandle = {
  executeCommand: (action: ToolbarAction) => void;
  focus: () => void;
  getMarkdown: () => string;
  /** Réécrit le DOM à partir d'un markdown — utilisé après un flush externe
   * (ex. retour de la vue Source) pour resynchroniser l'éditeur WYSIWYG. */
  refreshFromContent: (content: string) => void;
  getCaret: () => PreviewCaret | null;
  setCaret: (c: PreviewCaret) => void;
};

type Props = {
  initialContent: string;
  enabled: boolean;
  onInput?: () => void;
};

export const WysiwygEditor = forwardRef<WysiwygEditorHandle, Props>(
  function WysiwygEditor({ initialContent, enabled, onInput }, ref) {
    const divRef = useRef<HTMLDivElement | null>(null);
    const mountedRef = useRef(false);

    const slash = useSlashCommand({
      editorRef: divRef,
      enabled,
      onInput,
    });

    // Mount une seule fois : pose le HTML rendu depuis le markdown source.
    // Les changements ultérieurs d'initialContent NE REJOUENT PAS — sinon une
    // sauvegarde (qui met à jour tab.content) écraserait les modifs DOM en cours.
    useEffect(() => {
      if (!divRef.current || mountedRef.current) return;
      const content = normalizeMarkdown(initialContent);
      divRef.current.innerHTML = renderToStaticMarkup(
        <>{renderMarkdown(content)}</>,
      );
      mountedRef.current = true;
    }, [initialContent]);

    useEffect(() => {
      const el = divRef.current;
      if (!el || !onInput) return;
      const handler = () => onInput();
      el.addEventListener("input", handler);
      return () => el.removeEventListener("input", handler);
    }, [onInput]);

    useEffect(() => {
      const el = divRef.current;
      if (!el || !enabled) return;
      const handler = (event: Event) => {
        const input = event.target;
        if (!(input instanceof HTMLInputElement)) return;
        if (input.type !== "checkbox") return;
        const li = input.closest("li.task-li");
        if (!li || !el.contains(li)) return;

        li.classList.toggle("done", input.checked);
        if (input.checked) input.setAttribute("checked", "");
        else input.removeAttribute("checked");
        onInput?.();
      };
      el.addEventListener("change", handler);
      return () => el.removeEventListener("change", handler);
    }, [enabled, onInput]);

    // Double-clic sur une formule rendue → ré-ouvre l'édition.
    useEffect(() => {
      const el = divRef.current;
      if (!el || !enabled) return;
      return attachMathDoubleClick(el);
    }, [enabled]);

    useImperativeHandle(
      ref,
      () => ({
        focus: () => divRef.current?.focus(),
        executeCommand: (action) => {
          const el = divRef.current;
          if (!el) return;
          el.focus();
          runWysiwygCommand(el, action);
          onInput?.();
        },
        getMarkdown: () => {
          const html = divRef.current?.innerHTML ?? "";
          return htmlToMarkdown(html);
        },
        refreshFromContent: (content) => {
          if (!divRef.current) return;
          const normalizedContent = normalizeMarkdown(content);
          divRef.current.innerHTML = renderToStaticMarkup(
            <>{renderMarkdown(normalizedContent)}</>,
          );
        },
        getCaret: () => readPreviewCaret(divRef.current),
        setCaret: (c) => writePreviewCaret(divRef.current, c),
      }),
      [onInput],
    );

    return (
      <>
        <div
          ref={divRef}
          className={`reading ${enabled ? "wysiwyg" : ""}`}
          contentEditable={enabled}
          suppressContentEditableWarning
          spellCheck={enabled}
          onKeyDown={slash.handleKeyDown}
          onBlur={slash.handleBlur}
        />
        <SlashMenu
          state={slash.state}
          matches={slash.matches}
          onPick={slash.pickIndex}
          onSubmitTable={slash.submitTableForm}
          onCancelForm={slash.cancelForm}
        />
      </>
    );
  },
);

function readPreviewCaret(root: HTMLDivElement | null): PreviewCaret | null {
  if (!root) return null;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer)) return null;

  // Offset textuel cumulé depuis le début de root jusqu'au caret.
  let offset = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode() as Text | null;
  while (node) {
    if (node === range.startContainer) {
      offset += range.startOffset;
      return { offset };
    }
    offset += node.data.length;
    node = walker.nextNode() as Text | null;
  }
  // startContainer n'est pas un nœud texte : tomber sur l'offset accumulé jusqu'au container.
  if (range.startContainer === root) {
    let acc = 0;
    for (let i = 0; i < range.startOffset && i < root.childNodes.length; i++) {
      acc += textLengthOf(root.childNodes[i]);
    }
    return { offset: acc };
  }
  return { offset };
}

function writePreviewCaret(
  root: HTMLDivElement | null,
  caret: PreviewCaret,
): void {
  if (!root) return;
  const sel = window.getSelection();
  if (!sel) return;
  let remaining = Math.max(0, caret.offset);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode() as Text | null;
  let target: Text | null = null;
  let targetOffset = 0;
  while (node) {
    const len = node.data.length;
    if (remaining <= len) {
      target = node;
      targetOffset = remaining;
      break;
    }
    remaining -= len;
    node = walker.nextNode() as Text | null;
  }
  const range = document.createRange();
  if (target) {
    range.setStart(target, targetOffset);
  } else {
    // Offset > texte total : poser le caret à la fin.
    range.selectNodeContents(root);
    range.collapse(false);
  }
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function textLengthOf(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return (node as Text).data.length;
  let total = 0;
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  let n = walker.nextNode() as Text | null;
  while (n) {
    total += n.data.length;
    n = walker.nextNode() as Text | null;
  }
  return total;
}
