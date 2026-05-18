import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

type Props = {
  anchor: HTMLImageElement | null;
  /** Notifie l'éditeur d'un redimensionnement validé (mouseup). */
  onCommit: () => void;
};

type Corner = "nw" | "ne" | "sw" | "se";

const MIN_WIDTH = 24;
const DRAG_THRESHOLD = 3;

export function ImageResizeOverlay({ anchor, onCommit }: Props) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const dragRef = useRef<{
    corner: Corner;
    startX: number;
    startY: number;
    startW: number;
    ratio: number;
    maxW: number;
    active: boolean;
    moved: boolean;
  } | null>(null);

  const recompute = useCallback(() => {
    if (!anchor) {
      setRect(null);
      return;
    }
    setRect(anchor.getBoundingClientRect());
  }, [anchor]);

  useLayoutEffect(() => {
    recompute();
    if (!anchor) return;
    window.addEventListener("scroll", recompute, true);
    window.addEventListener("resize", recompute);
    const obs = new MutationObserver(recompute);
    obs.observe(anchor, { attributes: true, attributeFilter: ["width", "src"] });
    return () => {
      window.removeEventListener("scroll", recompute, true);
      window.removeEventListener("resize", recompute);
      obs.disconnect();
    };
  }, [anchor, recompute]);

  useEffect(() => {
    if (!anchor) return;
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (!d.active) {
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) {
          return;
        }
        d.active = true;
      }
      d.moved = true;
      // Signe de l'extension horizontale selon le coin.
      const horizSign = d.corner === "ne" || d.corner === "se" ? 1 : -1;
      const vertSign = d.corner === "sw" || d.corner === "se" ? 1 : -1;
      const candidateFromX = d.startW + horizSign * dx;
      const candidateFromY = d.startW + vertSign * dy * d.ratio;
      const next = Math.max(candidateFromX, candidateFromY);
      const clamped = Math.max(MIN_WIDTH, Math.min(d.maxW, next));
      anchor.setAttribute("width", String(Math.round(clamped)));
      recompute();
    };
    const onUp = () => {
      const d = dragRef.current;
      if (!d) return;
      const moved = d.moved;
      dragRef.current = null;
      document.body.style.userSelect = "";
      if (moved) onCommit();
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [anchor, onCommit, recompute]);

  if (!anchor || !rect) return null;

  const startDrag = (corner: Corner) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const w = anchor.getBoundingClientRect().width;
    const h = anchor.getBoundingClientRect().height || 1;
    const ratio = w / h;
    const editor = anchor.closest('[contenteditable="true"]') as HTMLElement | null;
    const maxW = editor ? editor.getBoundingClientRect().width : window.innerWidth;
    dragRef.current = {
      corner,
      startX: e.clientX,
      startY: e.clientY,
      startW: w,
      ratio,
      maxW,
      active: false,
      moved: false,
    };
    document.body.style.userSelect = "none";
  };

  const handles: { corner: Corner; left: number; top: number; cursor: string }[] = [
    { corner: "nw", left: rect.left, top: rect.top, cursor: "nwse-resize" },
    { corner: "ne", left: rect.right, top: rect.top, cursor: "nesw-resize" },
    { corner: "sw", left: rect.left, top: rect.bottom, cursor: "nesw-resize" },
    { corner: "se", left: rect.right, top: rect.bottom, cursor: "nwse-resize" },
  ];

  return (
    <>
      <div
        className="image-resize-frame"
        style={{
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        }}
      />
      {handles.map((h) => (
        <div
          key={h.corner}
          className={`image-resize-handle image-resize-handle-${h.corner}`}
          style={{ left: h.left, top: h.top, cursor: h.cursor }}
          onMouseDown={startDrag(h.corner)}
        />
      ))}
    </>
  );
}
