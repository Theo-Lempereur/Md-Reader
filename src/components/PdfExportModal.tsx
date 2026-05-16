import { useEffect, useState } from "react";
import type { PdfPageFormat, PdfColorMode } from "../types";

type Props = {
  initialFormat: PdfPageFormat;
  initialColorMode: PdfColorMode;
  onCancel: () => void;
  onConfirm: (opts: { format: PdfPageFormat; colorMode: PdfColorMode }) => void;
};

const FORMAT_LABELS: Record<PdfPageFormat, string> = {
  a4: "A4",
  letter: "Letter",
};

const FORMAT_DESCRIPTIONS: Record<PdfPageFormat, string> = {
  a4: "210 × 297 mm — standard international",
  letter: "8.5 × 11 in — standard nord-américain",
};

const COLOR_LABELS: Record<PdfColorMode, string> = {
  bw: "Noir & blanc",
  "palette-light": "Palette claire",
  "palette-exact": "Capture fidèle",
};

const COLOR_DESCRIPTIONS: Record<PdfColorMode, string> = {
  bw: "Texte noir sur fond blanc. Économe en encre.",
  "palette-light":
    "Accents et titres dans la palette du thème, fond clair forcé.",
  "palette-exact":
    "Reproduit exactement l'apparence à l'écran (fond sombre si dark mode).",
};

export function PdfExportModal({
  initialFormat,
  initialColorMode,
  onCancel,
  onConfirm,
}: Props) {
  const [format, setFormat] = useState<PdfPageFormat>(initialFormat);
  const [colorMode, setColorMode] = useState<PdfColorMode>(initialColorMode);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        onConfirm({ format, colorMode });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, onConfirm, format, colorMode]);

  return (
    <div
      className="pdf-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pdf-modal-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="pdf-modal">
        <div className="pdf-modal-head">
          <h2 id="pdf-modal-title">Exporter en PDF</h2>
        </div>

        <div className="pdf-modal-body">
          <section className="pdf-section">
            <h3>Format de page</h3>
            <div className="pdf-options">
              {(Object.keys(FORMAT_LABELS) as PdfPageFormat[]).map((f) => (
                <label
                  key={f}
                  className={`pdf-option ${format === f ? "selected" : ""}`}
                >
                  <input
                    type="radio"
                    name="pdf-format"
                    value={f}
                    checked={format === f}
                    onChange={() => setFormat(f)}
                  />
                  <div className="pdf-option-text">
                    <span className="pdf-option-label">{FORMAT_LABELS[f]}</span>
                    <span className="pdf-option-desc">
                      {FORMAT_DESCRIPTIONS[f]}
                    </span>
                  </div>
                </label>
              ))}
            </div>
          </section>

          <section className="pdf-section">
            <h3>Couleurs</h3>
            <div className="pdf-options">
              {(Object.keys(COLOR_LABELS) as PdfColorMode[]).map((c) => (
                <label
                  key={c}
                  className={`pdf-option ${colorMode === c ? "selected" : ""}`}
                >
                  <input
                    type="radio"
                    name="pdf-colors"
                    value={c}
                    checked={colorMode === c}
                    onChange={() => setColorMode(c)}
                  />
                  <div className="pdf-option-text">
                    <span className="pdf-option-label">{COLOR_LABELS[c]}</span>
                    <span className="pdf-option-desc">
                      {COLOR_DESCRIPTIONS[c]}
                    </span>
                  </div>
                </label>
              ))}
            </div>
          </section>
        </div>

        <div className="pdf-modal-foot">
          <button type="button" className="pdf-btn" onClick={onCancel}>
            Annuler
          </button>
          <button
            type="button"
            className="pdf-btn primary"
            onClick={() => onConfirm({ format, colorMode })}
          >
            Exporter…
          </button>
        </div>
      </div>
    </div>
  );
}
