import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "./Icons";

type Props = {
  anchor: HTMLAnchorElement | null;
  onEdit: () => void;
  onRemove: () => void;
};

export function LinkPopover({ anchor, onEdit, onRemove }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!anchor) {
      setPos(null);
      return;
    }
    const reposition = () => {
      const rect = anchor.getBoundingClientRect();
      const node = ref.current;
      const w = node?.offsetWidth ?? 240;
      const h = node?.offsetHeight ?? 36;
      let left = rect.left;
      let top = rect.top - h - 6;
      if (top < 8) top = rect.bottom + 6;
      if (left + w > window.innerWidth - 8) {
        left = Math.max(8, window.innerWidth - w - 8);
      }
      if (left < 8) left = 8;
      setPos({ left, top });
    };
    reposition();
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [anchor]);

  useEffect(() => {
    if (!anchor) return;
    const obs = new MutationObserver(() => {
      // Force un re-render si l'URL change (modif via formulaire).
      setPos((p) => (p ? { ...p } : p));
    });
    obs.observe(anchor, { attributes: true, attributeFilter: ["href"] });
    return () => obs.disconnect();
  }, [anchor]);

  if (!anchor) return null;
  const url = anchor.getAttribute("href") ?? "";
  const style = pos
    ? { left: pos.left, top: pos.top, visibility: "visible" as const }
    : { left: -9999, top: -9999, visibility: "hidden" as const };

  return (
    <div
      ref={ref}
      className="link-popover"
      style={style}
      onMouseDown={(e) => e.preventDefault()}
    >
      <span className="link-popover-url" title={url}>
        {url || "(sans URL)"}
      </span>
      <button
        type="button"
        className="link-popover-btn"
        title="Modifier le lien"
        onClick={onEdit}
      >
        <Icon.Pencil />
      </button>
      <button
        type="button"
        className="link-popover-btn"
        title="Retirer le lien"
        onClick={onRemove}
      >
        <Icon.LinkOff />
      </button>
    </div>
  );
}
