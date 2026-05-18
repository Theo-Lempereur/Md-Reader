import { useEffect, useLayoutEffect, useRef, useState } from "react";

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
      <div className="link-popover-title">Lien</div>
      <a
        className="link-popover-url"
        href={url || undefined}
        title={url}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.preventDefault()}
      >
        {url || "(sans URL)"}
      </a>
      <div className="link-popover-actions">
        <button type="button" onClick={onRemove}>
          Retirer
        </button>
        <button type="button" className="primary" onClick={onEdit}>
          Modifier
        </button>
      </div>
    </div>
  );
}
