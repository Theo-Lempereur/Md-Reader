import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import {
  placeCaretAtStart,
  readMarkdownFromSourceRoot,
  readSourceCaret,
  rebuildSourceDom,
  writeSourceCaret,
} from "../markdown/sourceDom";
import type { SourceCaret } from "../types";

type Snapshot = { md: string; caret: SourceCaret | null };

const MAX_STEPS = 200;
const COMMIT_DEBOUNCE_MS = 350;

export type SourceUndoApi = {
  /** À appeler après chaque modification (frappe ou opération structurelle). */
  scheduleCommit: () => void;
  /** Annule la dernière modification. Renvoie `true` si quelque chose a été restauré. */
  undo: () => boolean;
  /** Rétablit la modification annulée. */
  redo: () => boolean;
};

/** Pile d'annulation pour les vues source (DOM structuré en lignes).
 *
 * L'historique natif du navigateur est inutilisable ici : les opérations
 * structurelles (split/fusion de lignes, collage, reconstruction) passent par
 * des mutations DOM directes qui le corrompent. On snapshotte donc le markdown
 * complet (+ caret) à intervalle de frappe, et on reconstruit le DOM au undo. */
export function useSourceUndo(opts: {
  rootRef: RefObject<HTMLDivElement | null>;
  /** Contenu de référence (synchronisé avec le rendu React du DOM). */
  content: string;
  /** Changement de cible d'édition (onglet, bloc…) → historique vierge. */
  resetKey?: unknown;
  /** Appelé après chaque restauration, avec le markdown restauré. */
  onRestore?: (md: string) => void;
}): SourceUndoApi {
  const { rootRef, content, resetKey } = opts;
  const past = useRef<Snapshot[]>([]);
  const future = useRef<Snapshot[]>([]);
  const current = useRef<Snapshot>({ md: content, caret: null });
  const timer = useRef<number | null>(null);
  const onRestoreRef = useRef(opts.onRestore);
  onRestoreRef.current = opts.onRestore;

  const commitNow = useCallback(() => {
    if (timer.current != null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    const root = rootRef.current;
    if (!root) return;
    const md = readMarkdownFromSourceRoot(root, current.current.md);
    if (md === current.current.md) {
      // Pas de changement de texte : on rafraîchit juste le caret mémorisé.
      const caret = readSourceCaret(root);
      if (caret) current.current = { md, caret };
      return;
    }
    past.current.push(current.current);
    if (past.current.length > MAX_STEPS) past.current.shift();
    future.current = [];
    current.current = { md, caret: readSourceCaret(root) };
  }, [rootRef]);

  const scheduleCommit = useCallback(() => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      commitNow();
    }, COMMIT_DEBOUNCE_MS);
  }, [commitNow]);

  useEffect(() => {
    return () => {
      if (timer.current != null) window.clearTimeout(timer.current);
    };
  }, []);

  // Changement de cible d'édition (autre onglet, autre bloc) : on ne doit
  // jamais pouvoir « annuler » vers le contenu de l'ancienne cible.
  const contentRef = useRef(content);
  contentRef.current = content;
  const resetKeyRef = useRef(resetKey);
  useEffect(() => {
    if (resetKeyRef.current === resetKey) return;
    resetKeyRef.current = resetKey;
    if (timer.current != null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    past.current = [];
    future.current = [];
    current.current = { md: contentRef.current, caret: null };
  }, [resetKey]);

  // Resynchronisation sur changement du contenu rendu. Pour un round-trip de
  // nos propres éditions (flush → état parent → re-rendu), le commit aligne
  // `current.md` sur le contenu reçu et l'historique est conservé.
  useEffect(() => {
    commitNow();
    if (content !== current.current.md) {
      past.current = [];
      future.current = [];
      current.current = { md: content, caret: null };
    }
  }, [content, commitNow]);

  const apply = useCallback(
    (snap: Snapshot) => {
      const root = rootRef.current;
      if (!root) return;
      rebuildSourceDom(root, snap.md);
      if (snap.caret) {
        writeSourceCaret(root, snap.caret);
      } else {
        const firstContent = root.querySelector<HTMLElement>(".src-content");
        if (firstContent) placeCaretAtStart(firstContent);
      }
      onRestoreRef.current?.(snap.md);
    },
    [rootRef],
  );

  const undo = useCallback(() => {
    commitNow();
    const prev = past.current.pop();
    if (!prev) return false;
    future.current.push(current.current);
    current.current = prev;
    apply(prev);
    return true;
  }, [apply, commitNow]);

  const redo = useCallback(() => {
    commitNow();
    const next = future.current.pop();
    if (!next) return false;
    past.current.push(current.current);
    current.current = next;
    apply(next);
    return true;
  }, [apply, commitNow]);

  return useMemo(
    () => ({ scheduleCommit, undo, redo }),
    [scheduleCommit, undo, redo],
  );
}
