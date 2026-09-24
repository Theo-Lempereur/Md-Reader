import { useEffect } from "react";
import { SHORTCUT_GROUPS, formatKeys } from "../lib/shortcuts";

type Props = {
  /** Affiche la section de l'assistant IA. */
  showAi: boolean;
  onClose: () => void;
};

export function ShortcutsModal({ showAi, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const groups = SHORTCUT_GROUPS.filter((g) => showAi || !g.ai);

  return (
    <div
      className="pdf-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="shortcuts-modal-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="pdf-modal shortcuts-modal">
        <div className="pdf-modal-head shortcuts-head">
          <h2 id="shortcuts-modal-title">Raccourcis clavier</h2>
          <button
            type="button"
            className="twk-x"
            aria-label="Fermer"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="pdf-modal-body shortcuts-body">
          {groups.map((g) => (
            <section key={g.title} className="shortcuts-group">
              <h3>{g.title}</h3>
              <ul>
                {g.items.map((s, i) => (
                  <li key={i}>
                    <span className="shortcuts-label">
                      {s.label}
                      {s.hint && <span className="shortcuts-hint">{s.hint}</span>}
                    </span>
                    <span className="shortcuts-keys">
                      {s.keys.map((combo, ci) => (
                        <span key={ci} className="shortcuts-combo">
                          {ci > 0 && <span className="shortcuts-or">ou</span>}
                          {formatKeys(combo).map((k, ki) => (
                            <kbd key={ki}>{k}</kbd>
                          ))}
                        </span>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
