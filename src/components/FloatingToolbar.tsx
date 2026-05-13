import { Icon } from "./Icons";
import type { ToolbarAction } from "./Toolbar";

type Props = {
  pos: { x: number; y: number } | null;
  onAction: (a: ToolbarAction) => void;
};

const keepFocus = (e: React.MouseEvent) => e.preventDefault();

export function FloatingToolbar({ pos, onAction }: Props) {
  if (!pos) return null;
  return (
    <div className="floating-toolbar" style={{ left: pos.x, top: pos.y }}>
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
