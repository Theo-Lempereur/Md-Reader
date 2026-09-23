import { useEffect, useState } from "react";
import { Icon } from "./Icons";
import type { ToolbarAction } from "./Toolbar";
import type { QuickActionKind } from "../ai/types";

type Props = {
  pos: { x: number; y: number } | null;
  onAction: (a: ToolbarAction) => void;
  /** Actions rapides de l'assistant IA (absentes tant qu'il n'est pas prêt). */
  onAiAction?: (kind: QuickActionKind) => void;
};

const keepFocus = (e: React.MouseEvent) => e.preventDefault();

const AI_ACTIONS: { kind: QuickActionKind; label: string }[] = [
  { kind: "rephrase", label: "Reformuler" },
  { kind: "fix", label: "Corriger" },
  { kind: "shorten", label: "Raccourcir" },
  { kind: "translate", label: "Traduire" },
  { kind: "continue", label: "Continuer" },
];

export function FloatingToolbar({ pos, onAction, onAiAction }: Props) {
  const [aiOpen, setAiOpen] = useState(false);
  useEffect(() => {
    if (!pos) setAiOpen(false);
  }, [pos]);
  if (!pos) return null;
  return (
    <div className="floating-toolbar" style={{ left: pos.x, top: pos.y }}>
      {onAiAction && (
        <>
          <button
            onMouseDown={keepFocus}
            onClick={() => setAiOpen((v) => !v)}
            title="Assistant IA"
            className={`ft-ai${aiOpen ? " on" : ""}`}
          >
            <Icon.Sparkles />
          </button>
          {aiOpen && (
            <div className="floating-ai-menu">
              {AI_ACTIONS.map((a) => (
                <button
                  key={a.kind}
                  onMouseDown={keepFocus}
                  onClick={() => {
                    setAiOpen(false);
                    onAiAction(a.kind);
                  }}
                >
                  {a.label}
                </button>
              ))}
            </div>
          )}
          <span className="sep" />
        </>
      )}
      <button
        onMouseDown={keepFocus}
        onClick={() => onAction("bold")}
        title="Gras"
      >
        <Icon.Bold />
      </button>
      <button
        onMouseDown={keepFocus}
        onClick={() => onAction("italic")}
        title="Italique"
      >
        <Icon.Italic />
      </button>
      <button
        onMouseDown={keepFocus}
        onClick={() => onAction("strike")}
        title="Barré"
      >
        <Icon.Strike />
      </button>
      <button
        onMouseDown={keepFocus}
        onClick={() => onAction("code")}
        title="Code"
      >
        <Icon.Code />
      </button>
      <button
        onMouseDown={keepFocus}
        onClick={() => onAction("clearFormat")}
        title="Effacer le formatage"
      >
        <Icon.ClearFormat />
      </button>
      <span className="sep" />
      <button
        onMouseDown={keepFocus}
        onClick={() => onAction("link")}
        title="Lien"
      >
        <Icon.Link />
      </button>
      <button
        onMouseDown={keepFocus}
        onClick={() => onAction("h2")}
        title="Titre"
      >
        H2
      </button>
    </div>
  );
}
