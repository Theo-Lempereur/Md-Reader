import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { normalizeMarkdown } from "../markdown/normalize";
import { renderMarkdown } from "../markdown/render";
import { htmlToMarkdown } from "../lib/htmlToMarkdown";
import { attachMathDoubleClick } from "../slash/math";
import {
  runWysiwygCommand,
  syncHeadingIds,
  unlinkAnchor,
} from "../slash/runners";
import { useSlashCommand } from "../slash/useSlashCommand";
import { SlashMenu } from "./SlashMenu";
import { LinkPopover } from "./LinkPopover";
import { ImageResizeOverlay } from "./ImageResizeOverlay";
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
    const [activeLink, setActiveLink] = useState<HTMLAnchorElement | null>(
      null,
    );
    const [selectedImage, setSelectedImage] =
      useState<HTMLImageElement | null>(null);

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
      syncHeadingIds(divRef.current);
      mountedRef.current = true;
    }, [initialContent]);

    // Resynchronise les `id` des headings à chaque édition (debounce léger).
    useEffect(() => {
      const el = divRef.current;
      if (!el || !enabled) return;
      let timer: number | null = null;
      const handler = () => {
        if (timer !== null) window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          if (divRef.current) syncHeadingIds(divRef.current);
        }, 200);
      };
      el.addEventListener("input", handler);
      return () => {
        el.removeEventListener("input", handler);
        if (timer !== null) window.clearTimeout(timer);
      };
    }, [enabled]);

    // Détecte si le caret est dans un <a>, pour afficher le popover.
    useEffect(() => {
      if (!enabled) {
        setActiveLink(null);
        return;
      }
      const el = divRef.current;
      if (!el) return;
      const onSelectionChange = () => {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) {
          setActiveLink(null);
          return;
        }
        const node = sel.getRangeAt(0).startContainer;
        if (!el.contains(node)) {
          setActiveLink(null);
          return;
        }
        const start =
          node.nodeType === 1 ? (node as Element) : node.parentElement;
        const a = start?.closest("a");
        setActiveLink(a instanceof HTMLAnchorElement ? a : null);
      };
      document.addEventListener("selectionchange", onSelectionChange);
      return () =>
        document.removeEventListener("selectionchange", onSelectionChange);
    }, [enabled]);

    // Sélection d'image : `click` (= mouseup confirmé) → poignées apparaissent.
    // Le `mousedown` se contente d'empêcher le drag natif de l'image et le
    // placement de caret « dans » l'image — il ne sélectionne PAS, sinon
    // l'overlay se monte pendant que le bouton est encore enfoncé et un
    // mouvement immédiat de la souris peut frapper une poignée fraîchement
    // rendue.
    useEffect(() => {
      if (!enabled) {
        setSelectedImage(null);
        return;
      }
      const el = divRef.current;
      if (!el) return;

      const onMouseDown = (e: MouseEvent) => {
        const target = e.target;
        if (!(target instanceof Element)) return;
        if (target.closest(".image-resize-handle")) return;
        const img = target.closest("img");
        if (img instanceof HTMLImageElement && el.contains(img)) {
          e.preventDefault();
        }
      };
      const onClick = (e: MouseEvent) => {
        const target = e.target;
        if (!(target instanceof Element)) return;
        if (target.closest(".image-resize-handle")) return;
        const img = target.closest("img");
        if (img instanceof HTMLImageElement && el.contains(img)) {
          e.preventDefault();
          setSelectedImage(img);
          return;
        }
        setSelectedImage(null);
      };
      el.addEventListener("mousedown", onMouseDown);
      el.addEventListener("click", onClick);
      return () => {
        el.removeEventListener("mousedown", onMouseDown);
        el.removeEventListener("click", onClick);
      };
    }, [enabled]);

    // Désélection via touche clavier (Échap, flèches…) — le clic ailleurs est
    // déjà géré par l'`onClick` ci-dessus.
    useEffect(() => {
      if (!enabled || !selectedImage) return;
      const handler = (e: KeyboardEvent) => {
        if (
          e.key === "Escape" ||
          e.key === "ArrowLeft" ||
          e.key === "ArrowRight" ||
          e.key === "ArrowUp" ||
          e.key === "ArrowDown"
        ) {
          setSelectedImage(null);
        }
      };
      document.addEventListener("keydown", handler);
      return () => document.removeEventListener("keydown", handler);
    }, [enabled, selectedImage]);

    // Ctrl+clic sur un lien : ouvre l'URL (externe via Tauri) ou scroll (#ancre).
    useEffect(() => {
      const el = divRef.current;
      if (!el) return;
      const onClick = (e: MouseEvent) => {
        const target = e.target;
        if (!(target instanceof Element)) return;
        const a = target.closest("a");
        if (!a || !el.contains(a)) return;
        const url = a.getAttribute("href");
        if (!url) return;
        if (!(e.ctrlKey || e.metaKey)) {
          // En mode édition, on bloque la navigation native ; sans Ctrl le
          // clic place simplement le caret comme du texte normal.
          if (enabled) e.preventDefault();
          return;
        }
        e.preventDefault();
        if (url.startsWith("#")) {
          const targetEl = document.getElementById(url.slice(1));
          targetEl?.scrollIntoView({ behavior: "smooth", block: "start" });
          return;
        }
        import("@tauri-apps/plugin-opener")
          .then(({ openUrl }) => openUrl(url))
          .catch((err) => console.error("Open URL failed:", err));
      };
      el.addEventListener("click", onClick);
      return () => el.removeEventListener("click", onClick);
    }, [enabled]);

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
          if (action === "link") {
            const sel = window.getSelection();
            const insideLink =
              sel && sel.rangeCount > 0
                ? (() => {
                    const node = sel.getRangeAt(0).startContainer;
                    if (!el.contains(node)) return null;
                    const start =
                      node.nodeType === 1
                        ? (node as Element)
                        : node.parentElement;
                    const a = start?.closest("a");
                    return a instanceof HTMLAnchorElement ? a : null;
                  })()
                : null;
            slash.openLinkForm(insideLink ? { editing: insideLink } : undefined);
            return;
          }
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
          syncHeadingIds(divRef.current);
        },
        getCaret: () => readPreviewCaret(divRef.current),
        setCaret: (c) => writePreviewCaret(divRef.current, c),
      }),
      [onInput, slash],
    );

    const isFormOpen =
      slash.state.active &&
      (slash.state.mode === "link-form" ||
        slash.state.mode === "image-form");

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
          onSubmitLink={slash.submitLinkForm}
          onSubmitImage={slash.submitImageForm}
          onCancelForm={slash.cancelForm}
        />
        {enabled && !isFormOpen && (
          <LinkPopover
            anchor={activeLink}
            onEdit={() => {
              if (activeLink) slash.openLinkForm({ editing: activeLink });
            }}
            onRemove={() => {
              const el = divRef.current;
              if (el && activeLink) {
                unlinkAnchor(el, activeLink);
                setActiveLink(null);
                onInput?.();
              }
            }}
          />
        )}
        {enabled && !isFormOpen && (
          <ImageResizeOverlay
            anchor={selectedImage}
            onCommit={() => onInput?.()}
          />
        )}
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
