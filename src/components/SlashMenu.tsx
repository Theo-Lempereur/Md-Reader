import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { SlashCommand } from "../slash/commands";
import type { SlashState } from "../slash/useSlashCommand";

type Props = {
  state: SlashState;
  matches: SlashCommand[];
  onPick: (index: number) => void;
  onSubmitTable: (rows: number, cols: number) => void;
  onCancelForm: () => void;
};

const MENU_MAX_HEIGHT = 320;

export function SlashMenu({
  state,
  matches,
  onPick,
  onSubmitTable,
  onCancelForm,
}: Props) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Empêche la perte de focus du contentEditable au mousedown.
  const keepFocus = (e: React.MouseEvent) => {
    if (state.active && state.mode === "table-form") return;
    e.preventDefault();
  };

  useLayoutEffect(() => {
    if (!state.active) {
      setPos(null);
      return;
    }
    const node = menuRef.current;
    if (!node) return;
    const w = node.offsetWidth || 240;
    const h = node.offsetHeight || 200;
    let left = state.anchor.x;
    let top = state.anchor.y + 4;
    if (left + w > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - w - 8);
    }
    if (top + h > window.innerHeight - 8) {
      // Place au-dessus si trop bas
      top = Math.max(8, state.anchor.y - h - 4);
    }
    setPos({ left, top });
  }, [state]);

  // Scroll la sélection en vue
  useEffect(() => {
    if (!state.active || state.mode !== "list") return;
    const list = menuRef.current?.querySelector(".slash-menu-list");
    const sel = list?.querySelector(
      `.slash-menu-item[data-index="${state.selectedIndex}"]`,
    ) as HTMLElement | null;
    sel?.scrollIntoView({ block: "nearest" });
  }, [state]);

  if (!state.active) return null;

  const style: CSSProperties = pos
    ? { left: pos.left, top: pos.top, visibility: "visible" }
    : { left: -9999, top: -9999, visibility: "hidden" };

  return (
    <div
      ref={menuRef}
      className="slash-menu"
      style={style}
      role="listbox"
      onMouseDown={keepFocus}
    >
      {state.mode === "list" ? (
        <ListBody
          matches={matches}
          selectedIndex={state.selectedIndex}
          onPick={onPick}
        />
      ) : (
        <TableForm onSubmit={onSubmitTable} onCancel={onCancelForm} />
      )}
    </div>
  );
}

function ListBody({
  matches,
  selectedIndex,
  onPick,
}: {
  matches: SlashCommand[];
  selectedIndex: number;
  onPick: (index: number) => void;
}) {
  if (matches.length === 0) {
    return (
      <div className="slash-menu-empty">Aucune commande</div>
    );
  }
  return (
    <div
      className="slash-menu-list"
      style={{ maxHeight: MENU_MAX_HEIGHT }}
    >
      {matches.map((cmd, i) => (
        <button
          key={cmd.id}
          type="button"
          tabIndex={-1}
          data-index={i}
          className={
            "slash-menu-item" + (i === selectedIndex ? " selected" : "")
          }
          onClick={() => onPick(i)}
        >
          <span className="slash-menu-label">{cmd.label}</span>
          {cmd.hint ? (
            <span className="slash-menu-hint">{cmd.hint}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

function TableForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (rows: number, cols: number) => void;
  onCancel: () => void;
}) {
  const [rows, setRows] = useState("3");
  const [cols, setCols] = useState("3");
  const rowsRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    rowsRef.current?.focus();
    rowsRef.current?.select();
  }, []);

  const submit = () => {
    const r = parseInt(rows, 10);
    const c = parseInt(cols, 10);
    if (!Number.isFinite(r) || !Number.isFinite(c) || r < 1 || c < 1) return;
    onSubmit(r, c);
  };

  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="slash-menu-form">
      <div className="slash-menu-form-title">Insérer un tableau</div>
      <div className="slash-menu-form-row">
        <label>
          Lignes
          <input
            ref={rowsRef}
            type="number"
            min={1}
            max={50}
            value={rows}
            onChange={(e) => setRows(e.target.value)}
            onKeyDown={onKey}
          />
        </label>
        <label>
          Colonnes
          <input
            type="number"
            min={1}
            max={20}
            value={cols}
            onChange={(e) => setCols(e.target.value)}
            onKeyDown={onKey}
          />
        </label>
      </div>
      <div className="slash-menu-form-actions">
        <button type="button" onClick={onCancel}>
          Annuler
        </button>
        <button
          type="button"
          className="primary"
          onClick={submit}
        >
          Insérer
        </button>
      </div>
    </div>
  );
}
