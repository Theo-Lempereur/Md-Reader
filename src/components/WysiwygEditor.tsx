import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
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

    /* --------------------------------------------------------------- */
    /* Undo/redo maison.                                                */
    /* L'historique natif du contentEditable est corrompu par toutes    */
    /* les mutations DOM programmatiques (slash commands, insertions de */
    /* tableaux, refreshFromContent…) : on snapshotte innerHTML + caret */
    /* à chaque rafale d'édition et on restaure nous-mêmes.             */
    /* --------------------------------------------------------------- */
    const undoPast = useRef<WysiwygSnapshot[]>([]);
    const undoFuture = useRef<WysiwygSnapshot[]>([]);
    const undoCurrent = useRef<WysiwygSnapshot | null>(null);
    const undoTimer = useRef<number | null>(null);

    const undoCommitNow = useCallback(() => {
      if (undoTimer.current != null) {
        window.clearTimeout(undoTimer.current);
        undoTimer.current = null;
      }
      const el = divRef.current;
      if (!el) return;
      const snap: WysiwygSnapshot = {
        html: el.innerHTML,
        caret: readPreviewCaret(el),
      };
      if (undoCurrent.current && undoCurrent.current.html === snap.html) {
        // Pas de changement de contenu : rafraîchit juste le caret mémorisé.
        undoCurrent.current = snap;
        return;
      }
      if (undoCurrent.current) {
        undoPast.current.push(undoCurrent.current);
        if (undoPast.current.length > UNDO_MAX_STEPS) undoPast.current.shift();
        undoFuture.current = [];
      }
      undoCurrent.current = snap;
    }, []);

    const scheduleUndoCommit = useCallback(() => {
      if (undoTimer.current != null) window.clearTimeout(undoTimer.current);
      undoTimer.current = window.setTimeout(() => {
        undoTimer.current = null;
        undoCommitNow();
      }, UNDO_DEBOUNCE_MS);
    }, [undoCommitNow]);

    const applyUndoSnapshot = useCallback(
      (snap: WysiwygSnapshot) => {
        const el = divRef.current;
        if (!el) return;
        el.innerHTML = snap.html;
        syncHeadingIds(el);
        if (snap.caret) writePreviewCaret(el, snap.caret);
        setSelectedImage(null);
        onInput?.();
      },
      [onInput],
    );

    /** Après application d'un snapshot, mémorise la forme RELUE du DOM :
     * le navigateur normalise le HTML injecté (et syncHeadingIds le
     * retouche), donc la chaîne relue diffère de celle stockée. Sans cette
     * resynchronisation, le commit suivant croit voir une nouvelle édition,
     * vide la pile redo et boucle entre deux formes du même état — c'était
     * le « Ctrl+Z bloqué après 1 ou 2 retours ». */
    const resyncCurrentAfterApply = useCallback((snap: WysiwygSnapshot) => {
      undoCurrent.current = {
        html: divRef.current?.innerHTML ?? snap.html,
        caret: snap.caret,
      };
    }, []);

    const undoEdit = useCallback(() => {
      undoCommitNow();
      const prev = undoPast.current.pop();
      if (!prev || !undoCurrent.current) return;
      undoFuture.current.push(undoCurrent.current);
      applyUndoSnapshot(prev);
      resyncCurrentAfterApply(prev);
    }, [applyUndoSnapshot, resyncCurrentAfterApply, undoCommitNow]);

    const redoEdit = useCallback(() => {
      undoCommitNow();
      const next = undoFuture.current.pop();
      if (!next || !undoCurrent.current) return;
      undoPast.current.push(undoCurrent.current);
      applyUndoSnapshot(next);
      resyncCurrentAfterApply(next);
    }, [applyUndoSnapshot, resyncCurrentAfterApply, undoCommitNow]);

    useEffect(() => {
      return () => {
        if (undoTimer.current != null) window.clearTimeout(undoTimer.current);
      };
    }, []);

    // Chaque édition (frappe ou commande programmatique via dispatchInput)
    // programme un commit de snapshot.
    useEffect(() => {
      const el = divRef.current;
      if (!el || !enabled) return;
      const handler = () => scheduleUndoCommit();
      el.addEventListener("input", handler);
      return () => el.removeEventListener("input", handler);
    }, [enabled, scheduleUndoCommit]);

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
      undoPast.current = [];
      undoFuture.current = [];
      undoCurrent.current = { html: divRef.current.innerHTML, caret: null };
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

    // Collage : interprète le markdown (ChatGPT & co fournissent le markdown
    // brut en text/plain) ou convertit le HTML riche, au lieu de laisser le
    // contentEditable coller du texte plat sans mise en forme.
    const handlePaste = useCallback(
      (e: ReactClipboardEvent<HTMLDivElement>) => {
        if (!enabled) return;
        const el = divRef.current;
        if (!el) return;
        const dt = e.clipboardData;
        if (!dt) return;
        const plain = dt.getData("text/plain");
        const html = dt.getData("text/html");

        // Dans une cellule, un bloc de code ou une formule : texte brut
        // uniquement (les blocs markdown y casseraient la structure).
        const sel = window.getSelection();
        const startNode =
          sel && sel.rangeCount > 0 ? sel.getRangeAt(0).startContainer : null;
        const startEl =
          startNode?.nodeType === 1
            ? (startNode as Element)
            : startNode?.parentElement;
        if (startEl?.closest("td, th, pre, code, .math-edit")) {
          if (!plain) return;
          e.preventDefault();
          const text = startEl.closest("td, th")
            ? plain.replace(/\s*\n+\s*/g, " ")
            : plain;
          document.execCommand("insertText", false, text);
          return;
        }

        let md: string | null = null;
        if (plain && looksLikeMarkdownPaste(plain)) md = plain;
        else if (html && /<\s*(p|h[1-6]|ul|ol|li|table|pre|blockquote|img|a|strong|em|b|i|code)\b/i.test(html)) {
          md = htmlToMarkdown(html);
        }

        if (md != null) {
          e.preventDefault();
          try {
            insertMarkdownAtCaret(el, md);
          } catch (err) {
            // Filet de sécurité : aucune conversion / insertion ne doit
            // pouvoir faire planter l'app. On retombe sur du texte brut.
            console.error(
              "Collage markdown échoué, repli sur texte brut :",
              err,
            );
            document.execCommand("insertText", false, plain || md);
          }
          el.dispatchEvent(new Event("input", { bubbles: true }));
          return;
        }
        if (plain) {
          e.preventDefault();
          document.execCommand("insertText", false, plain);
        }
      },
      [enabled],
    );

    // Copie : fournit aussi le markdown en text/plain (au lieu du texte nu),
    // pour que « copier depuis Md Reader → coller ailleurs » garde la forme.
    const handleCopy = useCallback(
      (e: ReactClipboardEvent<HTMLDivElement>) => {
        const el = divRef.current;
        const sel = window.getSelection();
        if (!el || !sel || sel.rangeCount === 0 || sel.isCollapsed) return;
        const range = sel.getRangeAt(0);
        if (!el.contains(range.commonAncestorContainer)) return;
        const container = document.createElement("div");
        container.appendChild(range.cloneContents());
        if (!container.innerHTML) return;
        e.preventDefault();
        e.clipboardData?.setData("text/html", container.innerHTML);
        e.clipboardData?.setData(
          "text/plain",
          htmlToMarkdown(container.innerHTML).trimEnd(),
        );
      },
      [],
    );

    const handleCut = useCallback(
      (e: ReactClipboardEvent<HTMLDivElement>) => {
        if (!enabled) {
          handleCopy(e);
          return;
        }
        handleCopy(e);
        if (e.defaultPrevented) {
          document.execCommand("delete");
        }
      },
      [enabled, handleCopy],
    );

    const handleKeyDown = useCallback(
      (e: ReactKeyboardEvent<HTMLDivElement>) => {
        if (enabled) {
          const mod = e.ctrlKey || e.metaKey;
          if (mod && !e.altKey && e.key.toLowerCase() === "z") {
            e.preventDefault();
            if (e.shiftKey) redoEdit();
            else undoEdit();
            return;
          }
          if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "y") {
            e.preventDefault();
            redoEdit();
            return;
          }
        }
        slash.handleKeyDown(e);
      },
      [enabled, redoEdit, slash, undoEdit],
    );

    useImperativeHandle(
      ref,
      () => ({
        focus: () => divRef.current?.focus(),
        executeCommand: (action) => {
          const el = divRef.current;
          if (!el) return;
          el.focus();
          if (action === "undo") {
            undoEdit();
            return;
          }
          if (action === "redo") {
            redoEdit();
            return;
          }
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
          // Commit l'état courant AVANT de réécrire, pour que le
          // remplacement externe soit une étape d'historique annulable.
          undoCommitNow();
          const normalizedContent = normalizeMarkdown(content);
          divRef.current.innerHTML = renderToStaticMarkup(
            <>{renderMarkdown(normalizedContent)}</>,
          );
          syncHeadingIds(divRef.current);
          scheduleUndoCommit();
        },
        getCaret: () => readPreviewCaret(divRef.current),
        setCaret: (c) => writePreviewCaret(divRef.current, c),
      }),
      [onInput, slash, redoEdit, undoEdit, undoCommitNow, scheduleUndoCommit],
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
          onKeyDown={handleKeyDown}
          onBlur={slash.handleBlur}
          onPaste={handlePaste}
          onCopy={handleCopy}
          onCut={handleCut}
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

type WysiwygSnapshot = { html: string; caret: PreviewCaret | null };

const UNDO_MAX_STEPS = 200;
const UNDO_DEBOUNCE_MS = 350;

/** Heuristique : le texte collé mérite-t-il un rendu markdown ?
 * Multi-ligne → toujours (il faut au minimum des paragraphes). Sinon on
 * cherche de la syntaxe block ou inline. */
function looksLikeMarkdownPaste(text: string): boolean {
  if (text.includes("\n")) return true;
  if (/^\s{0,3}(#{1,6}\s|```|~~~|>\s|[-*+]\s|\d+[.)]\s|\|)/.test(text)) {
    return true;
  }
  return /\*\*[^*]+\*\*|\*[^*\s][^*]*\*|__[^_]+__|~~[^~]+~~|`[^`]+`|!?\[[^\]]+\]\([^)]+\)|\$[^$]+\$/.test(
    text,
  );
}

/** Insère un markdown rendu (HTML) à la position du caret.
 * - Un seul paragraphe → insertion inline au fil du texte.
 * - Plusieurs blocs → insérés après le bloc top-level courant. */
function insertMarkdownAtCaret(editor: HTMLElement, md: string): void {
  const sel = window.getSelection();
  if (!sel) return;
  let range: Range;
  if (
    sel.rangeCount > 0 &&
    editor.contains(sel.getRangeAt(0).startContainer)
  ) {
    range = sel.getRangeAt(0);
  } else {
    range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
  }
  range.deleteContents();

  const html = renderToStaticMarkup(
    <>{renderMarkdown(normalizeMarkdown(md))}</>,
  );
  const tpl = document.createElement("template");
  tpl.innerHTML = html;

  const blocks = Array.from(tpl.content.children);
  if (blocks.length === 1 && blocks[0].tagName === "P") {
    // Contenu inline : on déballe le <p> et on insère au fil du texte.
    const p = blocks[0];
    const frag = document.createDocumentFragment();
    while (p.firstChild) frag.appendChild(p.firstChild);
    const lastNode = frag.lastChild;
    range.insertNode(frag);
    if (lastNode) {
      const after = document.createRange();
      after.setStartAfter(lastNode);
      after.collapse(true);
      sel.removeAllRanges();
      sel.addRange(after);
    }
    return;
  }

  // Plusieurs blocs : insertion après le bloc top-level contenant le caret.
  // ⚠ Le caret peut être posé DIRECTEMENT dans l'éditeur (document vide ou
  // curseur entre deux blocs) : dans ce cas range.startContainer === editor.
  // Il ne faut alors PAS remonter la chaîne des parents (sinon on sort de
  // l'éditeur et `insertBefore` lève NotFoundError → crash de l'app).
  let topBlock: Node | null = null;
  let refNode: Node | null = null;
  if (range.startContainer === editor) {
    // Insertion à la position du caret entre les enfants de l'éditeur.
    refNode = editor.childNodes[range.startOffset] ?? null;
  } else {
    topBlock = range.startContainer;
    while (topBlock && topBlock.parentNode && topBlock.parentNode !== editor) {
      topBlock = topBlock.parentNode;
    }
    if (topBlock && topBlock.parentNode === editor) {
      refNode = topBlock.nextSibling;
    } else {
      // On n'a jamais atteint un enfant direct de l'éditeur : on ajoute à la fin.
      topBlock = null;
      refNode = null;
    }
  }

  const nodes = Array.from(tpl.content.childNodes);
  for (const n of nodes) {
    editor.insertBefore(n, refNode);
  }

  // Si le bloc d'origine était vide (paragraphe placeholder), on le retire.
  if (
    topBlock instanceof HTMLElement &&
    !(topBlock.textContent || "").replace(/​/g, "").trim() &&
    !topBlock.querySelector("img, table, hr, input")
  ) {
    topBlock.remove();
  }

  for (let i = nodes.length - 1; i >= 0; i--) {
    const lastEl = nodes[i];
    if (lastEl instanceof HTMLElement) {
      const after = document.createRange();
      after.selectNodeContents(lastEl);
      after.collapse(false);
      sel.removeAllRanges();
      sel.addRange(after);
      break;
    }
  }
}

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
