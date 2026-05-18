import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { SlashCommand } from "../slash/commands";
import type {
  LinkFormPayload,
  SlashState,
} from "../slash/useSlashCommand";

type Props = {
  state: SlashState;
  matches: SlashCommand[];
  onPick: (index: number) => void;
  onSubmitTable: (rows: number, cols: number) => void;
  onSubmitLink: (payload: LinkFormPayload) => void;
  onCancelForm: () => void;
};

const MENU_MAX_HEIGHT = 320;

export function SlashMenu({
  state,
  matches,
  onPick,
  onSubmitTable,
  onSubmitLink,
  onCancelForm,
}: Props) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Empêche la perte de focus du contentEditable au mousedown.
  const keepFocus = (e: React.MouseEvent) => {
    if (
      state.active &&
      (state.mode === "table-form" || state.mode === "link-form")
    ) {
      return;
    }
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
      {state.mode === "list" && (
        <ListBody
          matches={matches}
          selectedIndex={state.selectedIndex}
          onPick={onPick}
        />
      )}
      {state.mode === "table-form" && (
        <TableForm onSubmit={onSubmitTable} onCancel={onCancelForm} />
      )}
      {state.mode === "link-form" && (
        <LinkForm
          initialUrl={state.initialUrl}
          initialLabel={state.initialLabel}
          editing={!!state.editingAnchor}
          headings={state.headings}
          onSubmit={onSubmitLink}
          onCancel={onCancelForm}
        />
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

function LinkForm({
  initialUrl,
  initialLabel,
  editing,
  headings,
  onSubmit,
  onCancel,
}: {
  initialUrl: string;
  initialLabel: string;
  editing: boolean;
  headings: { label: string; slug: string }[];
  onSubmit: (payload: LinkFormPayload) => void;
  onCancel: () => void;
}) {
  const inferredInternal =
    initialUrl.startsWith("#") || (!initialUrl && headings.length > 0 && false);
  const [kind, setKind] = useState<"external" | "internal">(
    inferredInternal ? "internal" : "external",
  );
  const [url, setUrl] = useState(initialUrl);
  const [label, setLabel] = useState(initialLabel);
  const [internalMode, setInternalMode] = useState<"select" | "custom">(() => {
    if (!initialUrl.startsWith("#")) return "select";
    const slug = initialUrl.slice(1);
    return headings.some((h) => h.slug === slug) ? "select" : "custom";
  });
  const [selectedSlug, setSelectedSlug] = useState<string>(() => {
    if (initialUrl.startsWith("#")) {
      const slug = initialUrl.slice(1);
      if (headings.some((h) => h.slug === slug)) return slug;
    }
    return headings[0]?.slug ?? "";
  });
  const [customAnchor, setCustomAnchor] = useState<string>(() =>
    initialUrl.startsWith("#") ? initialUrl : "",
  );
  const urlRef = useRef<HTMLInputElement | null>(null);
  const labelRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (kind === "external") {
      urlRef.current?.focus();
      urlRef.current?.select();
    } else {
      labelRef.current?.focus();
    }
  }, [kind]);

  const computeUrl = (): string => {
    if (kind === "external") return url.trim();
    if (internalMode === "select") {
      return selectedSlug ? `#${selectedSlug}` : "";
    }
    const a = customAnchor.trim();
    if (!a) return "";
    return a.startsWith("#") ? a : `#${a}`;
  };

  const submit = () => {
    const finalUrl = computeUrl();
    if (!finalUrl) return;
    onSubmit({ url: finalUrl, label: label.trim() });
  };

  const onKey = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="slash-menu-form slash-menu-form-link">
      <div className="slash-menu-form-title">
        {editing ? "Modifier le lien" : "Insérer un lien"}
      </div>
      <div className="slash-menu-form-tabs">
        <button
          type="button"
          className={kind === "external" ? "active" : ""}
          onClick={() => setKind("external")}
        >
          Externe
        </button>
        <button
          type="button"
          className={kind === "internal" ? "active" : ""}
          onClick={() => setKind("internal")}
          disabled={headings.length === 0 && internalMode === "select"}
          title={
            headings.length === 0
              ? "Aucun titre disponible — saisie libre"
              : undefined
          }
        >
          Interne
        </button>
      </div>

      {kind === "external" ? (
        <label className="slash-menu-form-field">
          URL
          <input
            ref={urlRef}
            type="text"
            value={url}
            placeholder="https://…"
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={onKey}
          />
        </label>
      ) : (
        <>
          <div className="slash-menu-form-tabs slash-menu-form-tabs-sub">
            <button
              type="button"
              className={internalMode === "select" ? "active" : ""}
              onClick={() => setInternalMode("select")}
              disabled={headings.length === 0}
            >
              Titre du document
            </button>
            <button
              type="button"
              className={internalMode === "custom" ? "active" : ""}
              onClick={() => setInternalMode("custom")}
            >
              Ancre libre
            </button>
          </div>
          {internalMode === "select" ? (
            <label className="slash-menu-form-field">
              Cible
              <select
                value={selectedSlug}
                onChange={(e) => setSelectedSlug(e.target.value)}
                onKeyDown={onKey}
              >
                {headings.length === 0 ? (
                  <option value="">(aucun titre)</option>
                ) : (
                  headings.map((h) => (
                    <option key={h.slug} value={h.slug}>
                      {h.label}
                    </option>
                  ))
                )}
              </select>
            </label>
          ) : (
            <label className="slash-menu-form-field">
              Ancre
              <input
                type="text"
                value={customAnchor}
                placeholder="#section-perso"
                onChange={(e) => setCustomAnchor(e.target.value)}
                onKeyDown={onKey}
              />
            </label>
          )}
        </>
      )}

      <label className="slash-menu-form-field">
        Libellé
        <input
          ref={labelRef}
          type="text"
          value={label}
          placeholder="Texte affiché"
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={onKey}
        />
      </label>

      <div className="slash-menu-form-actions">
        <button type="button" onClick={onCancel}>
          Annuler
        </button>
        <button
          type="button"
          className="primary"
          onClick={submit}
        >
          {editing ? "Mettre à jour" : "Insérer"}
        </button>
      </div>
    </div>
  );
}
