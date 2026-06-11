import {
  useCallback,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import { htmlToMarkdown } from "./htmlToMarkdown";
import {
  deleteSourceSelection,
  getSourceCaretContext,
  getSourceSelectionText,
  insertBlankSrcLineBelow,
  insertTextAtSourceCaret,
  mergeNextSrcLineIntoCurrent,
  mergeSrcLineWithPrevious,
  moveCaretToLineEnd,
  moveCaretToNextSrcLine,
  splitSrcLineAtCaret,
} from "../markdown/sourceDom";

type Opts = {
  rootRef: RefObject<HTMLDivElement | null>;
  /** Édition autorisée (les vues lecture gardent quand même la copie propre). */
  enabled?: boolean;
  /** Notifie une modification du DOM source (dirty + commit undo). */
  onEdit: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
};

/** Handlers clavier/presse-papier communs aux vues source (SourceView et
 * panneau latéral). Le contentEditable natif ne sait pas préserver la
 * structure en lignes (.src-line) : Entrée, Backspace en début de ligne,
 * Suppr en fin de ligne, collage multi-lignes et couper/copier doivent être
 * réimplémentés à la main. */
export function useSourceEditing({
  rootRef,
  enabled = true,
  onEdit,
  onUndo,
  onRedo,
}: Opts) {
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!enabled) return;
      const root = rootRef.current;
      if (!root) return;
      const key = e.key;
      const mod = e.ctrlKey || e.metaKey;

      if (mod && !e.altKey && key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) onRedo?.();
        else onUndo?.();
        return;
      }
      if (mod && !e.altKey && !e.shiftKey && key.toLowerCase() === "y") {
        e.preventDefault();
        onRedo?.();
        return;
      }
      if (mod && !e.altKey && !e.shiftKey && key === "Enter") {
        const res = moveCaretToNextSrcLine(root);
        if (res) {
          e.preventDefault();
          // Seule la création d'une ligne modifie le document.
          if (res.created) onEdit();
        }
        return;
      }
      if (e.altKey && !mod && !e.shiftKey && key === "Enter") {
        if (insertBlankSrcLineBelow(root)) {
          e.preventDefault();
          onEdit();
        }
        return;
      }
      if (mod && !e.altKey && !e.shiftKey && key.toLowerCase() === "l") {
        if (moveCaretToLineEnd()) e.preventDefault();
        return;
      }
      if (!mod && !e.altKey && key === "Enter") {
        // Le split natif du contentEditable imbrique des <div> dans la ligne
        // et fusionne silencieusement les lignes au prochain flush.
        e.preventDefault();
        deleteSourceSelection(root);
        if (splitSrcLineAtCaret(root)) onEdit();
        return;
      }
      if (!mod && !e.altKey && !e.shiftKey && key === "Backspace") {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) {
          if (deleteSourceSelection(root)) {
            e.preventDefault();
            onEdit();
          }
          return;
        }
        const ctx = getSourceCaretContext(root);
        if (ctx && ctx.column === 0) {
          // En début de ligne, le natif mange les éléments non éditables
          // (numéro, icône de marge) au lieu de fusionner les lignes.
          e.preventDefault();
          if (mergeSrcLineWithPrevious(root)) onEdit();
        }
        return;
      }
      if (!mod && !e.altKey && !e.shiftKey && key === "Delete") {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) {
          if (deleteSourceSelection(root)) {
            e.preventDefault();
            onEdit();
          }
          return;
        }
        const ctx = getSourceCaretContext(root);
        if (ctx && ctx.column === ctx.text.length) {
          e.preventDefault();
          if (mergeNextSrcLineIntoCurrent(root)) onEdit();
        }
        return;
      }
    },
    [enabled, rootRef, onEdit, onUndo, onRedo],
  );

  const onPaste = useCallback(
    (e: ReactClipboardEvent<HTMLDivElement>) => {
      if (!enabled) return;
      const root = rootRef.current;
      if (!root) return;
      const dt = e.clipboardData;
      if (!dt) return;
      e.preventDefault();
      let text = dt.getData("text/plain");
      if (!text) {
        // Certaines apps (Word, pages web) ne fournissent que du HTML :
        // on le convertit en markdown plutôt que de ne rien coller.
        const html = dt.getData("text/html");
        if (html) text = htmlToMarkdown(html).trimEnd();
      }
      if (!text) return;
      deleteSourceSelection(root);
      if (insertTextAtSourceCaret(root, text)) onEdit();
    },
    [enabled, rootRef, onEdit],
  );

  // Copie : la sélection native inclut les numéros de ligne et icônes de
  // marge (contentEditable=false mais présents dans le range) — on extrait
  // le markdown pur à la place.
  const onCopy = useCallback(
    (e: ReactClipboardEvent<HTMLDivElement>) => {
      const root = rootRef.current;
      if (!root) return;
      const text = getSourceSelectionText(root);
      if (text == null) return;
      e.preventDefault();
      e.clipboardData?.setData("text/plain", text);
    },
    [rootRef],
  );

  const onCut = useCallback(
    (e: ReactClipboardEvent<HTMLDivElement>) => {
      const root = rootRef.current;
      if (!root) return;
      const text = getSourceSelectionText(root);
      if (text == null) return;
      e.preventDefault();
      e.clipboardData?.setData("text/plain", text);
      if (!enabled) return;
      if (deleteSourceSelection(root)) onEdit();
    },
    [enabled, rootRef, onEdit],
  );

  return { onKeyDown, onPaste, onCopy, onCut };
}
