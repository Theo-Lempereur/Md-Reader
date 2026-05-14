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
import type { ToolbarAction } from "./Toolbar";

export type WysiwygEditorHandle = {
  executeCommand: (action: ToolbarAction) => void;
  focus: () => void;
  getMarkdown: () => string;
  /** Réécrit le DOM à partir d'un markdown — utilisé après un flush externe
   * (ex. retour de la vue Source) pour resynchroniser l'éditeur WYSIWYG. */
  refreshFromContent: (content: string) => void;
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
      }),
      [onInput],
    );

    return (
      <div
        ref={divRef}
        className={`reading ${enabled ? "wysiwyg" : ""}`}
        contentEditable={enabled}
        suppressContentEditableWarning
        spellCheck={enabled}
      />
    );
  },
);

function runWysiwygCommand(editor: HTMLElement, action: ToolbarAction) {
  switch (action) {
    case "bold":
      document.execCommand("bold");
      return;
    case "italic":
      document.execCommand("italic");
      return;
    case "strike":
      document.execCommand("strikeThrough");
      return;
    case "code":
      wrapInCode(editor);
      return;
    case "h1":
      document.execCommand("formatBlock", false, "H1");
      return;
    case "h2":
      document.execCommand("formatBlock", false, "H2");
      return;
    case "h3":
      document.execCommand("formatBlock", false, "H3");
      return;
    case "quote":
      document.execCommand("formatBlock", false, "BLOCKQUOTE");
      return;
    case "ul":
      document.execCommand("insertUnorderedList");
      return;
    case "ol":
      document.execCommand("insertOrderedList");
      return;
    case "link": {
      const url = window.prompt("URL ?");
      if (url) document.execCommand("createLink", false, url);
      return;
    }
    case "undo":
      document.execCommand("undo");
      return;
    case "redo":
      document.execCommand("redo");
      return;
  }
}

function wrapInCode(editor: HTMLElement) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  if (!editor.contains(range.startContainer)) return;

  const code = document.createElement("code");

  if (range.collapsed) {
    const zwsp = document.createTextNode("​");
    code.appendChild(zwsp);
    range.insertNode(code);
    const inner = document.createRange();
    inner.setStart(zwsp, 1);
    inner.collapse(true);
    sel.removeAllRanges();
    sel.addRange(inner);
  } else {
    const fragment = range.extractContents();
    code.appendChild(fragment);
    range.insertNode(code);
    const after = document.createRange();
    after.selectNodeContents(code);
    sel.removeAllRanges();
    sel.addRange(after);
  }
}
