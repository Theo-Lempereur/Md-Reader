import { useEffect } from "react";
import type { ReactNode } from "react";

type Variant = "warning" | "danger";

type Props = {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: Variant;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmModal({
  title,
  message,
  confirmLabel = "Continuer",
  cancelLabel = "Annuler",
  variant = "warning",
  onConfirm,
  onCancel,
}: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        onConfirm();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, onConfirm]);

  return (
    <div
      className="pdf-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-modal-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="pdf-modal confirm-modal">
        <div className="pdf-modal-head">
          <h2 id="confirm-modal-title">{title}</h2>
        </div>

        <div className="pdf-modal-body confirm-modal-body">{message}</div>

        <div className="pdf-modal-foot">
          <button type="button" className="pdf-btn" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`pdf-btn primary ${variant === "danger" ? "danger" : ""}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
