import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import {
  matchCommands,
  SLASH_COMMANDS,
  type SlashCommand,
} from "./commands";
import { clearTriggerText, insertTable, type SlashCtx } from "./runners";

type Anchor = { x: number; y: number };

type Inactive = { active: false };

type ListMode = {
  active: true;
  mode: "list";
  query: string;
  anchor: Anchor;
  triggerNode: Node;
  /** Offset du caractère `/` dans `triggerNode` (le `/` est à offset-1). */
  triggerOffset: number;
  selectedIndex: number;
};

type FormMode = {
  active: true;
  mode: "table-form";
  anchor: Anchor;
  triggerNode: Node;
  triggerOffset: number;
};

export type SlashState = Inactive | ListMode | FormMode;

type Opts = {
  editorRef: RefObject<HTMLDivElement | null>;
  enabled: boolean;
  onInput?: () => void;
};

export type SlashApi = {
  state: SlashState;
  matches: SlashCommand[];
  /** À brancher en `onKeyDown` du contentEditable. */
  handleKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
  /** À brancher en `onBlur` (avec délai pour permettre clic dans le menu). */
  handleBlur: () => void;
  close: () => void;
  /** Sélection d'une entrée (clic, ou via clavier). */
  pickIndex: (index: number) => void;
  /** Validation du sous-formulaire tableau. */
  submitTableForm: (rows: number, cols: number) => void;
  /** Annulation du sous-formulaire tableau. */
  cancelForm: () => void;
};

/** Le `/` est-il en position de déclenchement ? Vrai si le caret est précédé
 * d'un espace, début de ligne, ou tout début de bloc ; pas dans un <code>/<pre>. */
function shouldTrigger(editor: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  if (!range.collapsed) return false;
  if (!editor.contains(range.startContainer)) return false;

  // Refus si le caret est dans un <pre> ou <code>.
  const startEl =
    range.startContainer.nodeType === 1
      ? (range.startContainer as Element)
      : range.startContainer.parentElement;
  if (startEl?.closest("pre, code")) return false;

  const node = range.startContainer;
  const offset = range.startOffset;
  if (node.nodeType === 3) {
    // text node : regarde le caractère juste avant le caret.
    if (offset === 0) return true; // début de noeud texte
    const text = (node as Text).data;
    const prev = text.charAt(offset - 1);
    return prev === "" || /\s/.test(prev);
  }
  // Element : vérifie le noeud à offset-1.
  if (offset === 0) return true;
  const prevNode = (node as Element).childNodes[offset - 1];
  if (!prevNode) return true;
  if (prevNode.nodeType === 3) {
    const data = (prevNode as Text).data;
    if (!data.length) return true;
    return /\s/.test(data.charAt(data.length - 1));
  }
  // Block-level voisin : on autorise.
  return true;
}

function computeAnchor(): Anchor | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0).cloneRange();
  const rect = range.getBoundingClientRect();
  // Quand collapsed, getBoundingClientRect peut renvoyer un rect vide ;
  // tomber sur le client rect du parent élément dans ce cas.
  if (rect.width === 0 && rect.height === 0) {
    const el =
      range.startContainer.nodeType === 1
        ? (range.startContainer as Element)
        : range.startContainer.parentElement;
    if (el) {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.bottom };
    }
    return null;
  }
  return { x: rect.left, y: rect.bottom };
}

/** Lit le texte entre la position de déclenchement et le caret. Renvoie
 * `null` si la position n'est plus dans le DOM ou si une rupture est détectée. */
function readQuery(
  editor: HTMLElement,
  triggerNode: Node,
  triggerOffset: number,
): string | null {
  if (!editor.contains(triggerNode)) return null;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const caret = sel.getRangeAt(0);
  if (!caret.collapsed) return null;
  const range = document.createRange();
  try {
    range.setStart(triggerNode, triggerOffset);
    range.setEnd(caret.endContainer, caret.endOffset);
  } catch {
    return null;
  }
  const text = range.toString();
  // Le texte doit commencer par "/"
  if (!text.startsWith("/")) return null;
  const query = text.slice(1);
  // Pas d'espace, retour, ni nouvelle ligne dans la query.
  if (/[\s\n]/.test(query)) return null;
  return query;
}

export function useSlashCommand({
  editorRef,
  enabled,
  onInput,
}: Opts): SlashApi {
  const [state, setState] = useState<SlashState>({ active: false });
  const stateRef = useRef(state);
  stateRef.current = state;

  const close = useCallback(() => {
    setState({ active: false });
  }, []);

  const matches = useMemo(() => {
    if (!state.active || state.mode !== "list") return [];
    const editor = editorRef.current;
    const all = matchCommands(state.query);
    if (!editor) return all;
    return all.filter((c) => (c.isEnabled ? c.isEnabled(editor) : true));
  }, [state, editorRef]);

  /** Exécute la commande à l'index sélectionné. */
  const runCommandAtIndex = useCallback(
    (index: number) => {
      const s = stateRef.current;
      if (!s.active || s.mode !== "list") return;
      const editor = editorRef.current;
      if (!editor) return;
      const cmd = matches[index];
      if (!cmd) return;

      const ctx: SlashCtx = {
        editor,
        triggerNode: s.triggerNode,
        triggerOffset: s.triggerOffset,
        onInput,
      };

      if (cmd.needsForm === "table") {
        // Supprime `/table…` AVANT de basculer dans le formulaire — sinon
        // le caret part dans l'input et `clearTriggerText` ne peut plus
        // calculer la plage de suppression.
        clearTriggerText(editor, s.triggerNode, s.triggerOffset);
        setState({
          active: true,
          mode: "table-form",
          anchor: s.anchor,
          triggerNode: s.triggerNode,
          triggerOffset: s.triggerOffset,
        });
        return;
      }

      // Désactive le state d'abord pour éviter les re-rendus parasites
      setState({ active: false });
      cmd.run?.(ctx);
      onInput?.();
    },
    [editorRef, matches, onInput],
  );

  const pickIndex = useCallback(
    (index: number) => {
      runCommandAtIndex(index);
    },
    [runCommandAtIndex],
  );

  const submitTableForm = useCallback(
    (rows: number, cols: number) => {
      const s = stateRef.current;
      if (!s.active || s.mode !== "table-form") return;
      const editor = editorRef.current;
      if (!editor) return;
      setState({ active: false });
      editor.focus();
      // Replace le caret à l'endroit du déclencheur (le `/table…` a déjà été
      // supprimé au moment de l'ouverture du formulaire).
      const sel = window.getSelection();
      if (sel && editor.contains(s.triggerNode)) {
        try {
          const r = document.createRange();
          r.setStart(s.triggerNode, s.triggerOffset);
          r.collapse(true);
          sel.removeAllRanges();
          sel.addRange(r);
        } catch {
          // position devenue invalide — laisse le caret là où il est
        }
      }
      insertTable(
        {
          editor,
          triggerNode: s.triggerNode,
          triggerOffset: s.triggerOffset,
          onInput,
        },
        rows,
        cols,
      );
      onInput?.();
    },
    [editorRef, onInput],
  );

  const cancelForm = useCallback(() => {
    setState({ active: false });
    editorRef.current?.focus();
  }, [editorRef]);

  /** Met à jour la query / ferme si le caret a quitté la zone, après chaque
   * modification du contenu. */
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const handler = () => {
      const s = stateRef.current;
      if (!s.active || s.mode !== "list") return;
      const q = readQuery(editor, s.triggerNode, s.triggerOffset);
      if (q === null) {
        setState({ active: false });
        return;
      }
      setState((prev) => {
        if (!prev.active || prev.mode !== "list") return prev;
        if (prev.query === q) return prev;
        return { ...prev, query: q, selectedIndex: 0 };
      });
    };
    editor.addEventListener("input", handler);
    return () => editor.removeEventListener("input", handler);
  }, [editorRef]);

  /** Repositionne le menu si la sélection change (utile quand l'user clique
   * autre part dans le doc). */
  useEffect(() => {
    if (!state.active || state.mode !== "list") return;
    const onSelectionChange = () => {
      const editor = editorRef.current;
      const s = stateRef.current;
      if (!editor || !s.active) return;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const node = sel.getRangeAt(0).startContainer;
      if (!editor.contains(node)) {
        setState({ active: false });
      }
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () =>
      document.removeEventListener("selectionchange", onSelectionChange);
  }, [state, editorRef]);

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!enabled) return;
      const editor = editorRef.current;
      if (!editor) return;
      const s = stateRef.current;

      if (!s.active) {
        if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey) {
          if (!shouldTrigger(editor)) return;
          // Laisser le `/` s'insérer normalement, puis ouvrir le menu.
          requestAnimationFrame(() => {
            const sel = window.getSelection();
            if (!sel || sel.rangeCount === 0) return;
            const caret = sel.getRangeAt(0);
            if (caret.startContainer.nodeType !== 3) return;
            const offset = caret.startOffset;
            if (offset === 0) return;
            // Vérifie que le caractère juste avant le caret est bien "/".
            const data = (caret.startContainer as Text).data;
            if (data.charAt(offset - 1) !== "/") return;
            const anchor = computeAnchor();
            if (!anchor) return;
            setState({
              active: true,
              mode: "list",
              query: "",
              anchor,
              triggerNode: caret.startContainer,
              triggerOffset: offset - 1,
              selectedIndex: 0,
            });
          });
        }
        return;
      }

      if (s.mode === "table-form") {
        // Les touches sont gérées dans le formulaire lui-même ; on ignore ici.
        return;
      }

      // Mode liste
      switch (e.key) {
        case "Escape":
          e.preventDefault();
          setState({ active: false });
          return;
        case "ArrowDown":
          e.preventDefault();
          setState((prev) =>
            prev.active && prev.mode === "list"
              ? {
                  ...prev,
                  selectedIndex: Math.min(
                    prev.selectedIndex + 1,
                    Math.max(0, matches.length - 1),
                  ),
                }
              : prev,
          );
          return;
        case "ArrowUp":
          e.preventDefault();
          setState((prev) =>
            prev.active && prev.mode === "list"
              ? {
                  ...prev,
                  selectedIndex: Math.max(prev.selectedIndex - 1, 0),
                }
              : prev,
          );
          return;
        case "Tab":
        case "Enter": {
          if (matches.length === 0) {
            if (e.key === "Tab") {
              e.preventDefault();
              setState({ active: false });
            }
            return;
          }
          e.preventDefault();
          runCommandAtIndex(s.selectedIndex);
          return;
        }
      }
    },
    [editorRef, enabled, matches, runCommandAtIndex],
  );

  const handleBlur = useCallback(() => {
    // Délai pour permettre au clic dans le menu de prendre effet.
    setTimeout(() => {
      const editor = editorRef.current;
      if (!editor) return;
      if (document.activeElement === editor) return;
      // Si focus dans le menu lui-même, ne pas fermer.
      const active = document.activeElement as HTMLElement | null;
      if (active?.closest?.(".slash-menu")) return;
      setState({ active: false });
    }, 120);
  }, [editorRef]);

  return {
    state,
    matches,
    handleKeyDown,
    handleBlur,
    close,
    pickIndex,
    submitTableForm,
    cancelForm,
  };
}

// ré-export pratique
export { SLASH_COMMANDS };
