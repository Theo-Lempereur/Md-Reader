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
import { runWysiwygCommand } from "../slash/runners";
import { useSlashCommand } from "../slash/useSlashCommand";
import { SlashMenu } from "./SlashMenu";
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
