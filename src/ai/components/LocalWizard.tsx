/** Assistant « modèle local » : analyse de la machine, recommandation depuis
 * le catalogue embarqué, installation via Ollama avec progression, puis
 * mesure réelle (premier token, débit) plutôt qu'une promesse. */

import { useEffect, useMemo, useState } from "react";
import { aiApi, type Catalog, type CatalogModel, type HardwareInfo } from "../client";
import { refreshDetection, recomputeStatus } from "../status";
import { runBench, startPull, stopPull } from "../pull";
import { AUTO_TTFT_MS, benchKey, notify, updateSettings, useAi } from "../useAi";

const GB = 1024 ** 3;
const gb = (bytes: number) => `${(bytes / GB).toFixed(bytes < 10 * GB ? 1 : 0)} Go`;

type Fit = "gpu" | "cpu" | "no";
type Candidate = { model: CatalogModel; variant: CatalogModel["variants"][number]; fit: Fit };

/** Règle : le fichier doit tenir dans VRAM − marge pour tourner sur GPU,
 * sinon repli en RAM (lent) s'il reste de la place, sinon refus. */
export function fitOf(sizeGb: number, hw: HardwareInfo, headroomGb: number): Fit {
  const vram = (hw.gpus[0]?.vram ?? 0) / GB;
  if (sizeGb <= vram - headroomGb) return "gpu";
  if (sizeGb + 4 <= (hw.totalRam / GB) * 0.75) return "cpu";
  return "no";
}

export function recommend(
  hw: HardwareInfo,
  catalog: Catalog,
  role: "chat" | "complete",
): Candidate | null {
  const all: Candidate[] = [];
  for (const model of catalog.models.filter((m) => m.roles.includes(role))) {
    for (const variant of model.variants) {
      if (hw.freeDisk != null && variant.sizeGb * GB > hw.freeDisk) continue;
      all.push({ model, variant, fit: fitOf(variant.sizeGb, hw, catalog.gpuHeadroomGb) });
    }
  }
  const gpu = all.filter((c) => c.fit === "gpu");
  if (role === "complete") {
    // La latence prime : sur GPU, le plus capable parmi les petits (≤ 2 Go
    // reste très rapide) ; sans GPU, le plus petit de tous.
    const small = gpu.filter((c) => c.variant.sizeGb <= 2);
    if (small.length) return small.sort((a, b) => b.variant.sizeGb - a.variant.sizeGb)[0];
    const pool = gpu.length ? gpu : all.filter((c) => c.fit !== "no");
    return pool.sort((a, b) => a.variant.sizeGb - b.variant.sizeGb)[0] ?? null;
  }
  // Chat : le plus gros qui tient sur GPU (Q4 de préférence), sinon le plus petit en RAM.
  if (gpu.length) {
    const q4 = gpu.filter((c) => c.variant.quant.startsWith("Q4"));
    return (q4.length ? q4 : gpu).sort((a, b) => b.variant.sizeGb - a.variant.sizeGb)[0];
  }
  return all.filter((c) => c.fit === "cpu").sort((a, b) => a.variant.sizeGb - b.variant.sizeGb)[0] ?? null;
}

function FitBadge({ fit }: { fit: Fit }) {
  const label = fit === "gpu" ? "GPU" : fit === "cpu" ? "CPU (lent)" : "trop gros";
  return <span className={`ai-badge fit-${fit}`}>{label}</span>;
}

export function LocalWizard() {
  const det = useAi((s) => s.detection);
  const settings = useAi((s) => s.settings);
  const [hw, setHw] = useState<HardwareInfo | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  // Téléchargement et mesure vivent dans le store : ils continuent (et restent
  // visibles au retour) quand on change d'onglet ou qu'on ferme cet écran.
  const pull = useAi((s) => s.pull);
  const benching = useAi((s) => s.benching);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    aiApi.hardware().then(setHw).catch((e) => notify(`Analyse de la machine impossible : ${e}`, "error"));
    aiApi.catalog().then(setCatalog).catch(() => {});
  }, []);

  // Ollama absent ou arrêté : on vérifie l'installation automatiquement.
  const ollamaRunning = !!det?.ollama.running;
  useEffect(() => {
    if (ollamaRunning) return;
    const t = window.setInterval(() => void refreshDetection(), 4000);
    return () => window.clearInterval(t);
  }, [ollamaRunning]);

  const installed = useMemo(
    () => new Set(det?.ollama.models.map((m) => m.name.replace(/:latest$/, "")) ?? []),
    [det],
  );
  const isInstalled = (tag: string) => installed.has(tag) || installed.has(tag.replace(/:latest$/, ""));

  const chat = hw && catalog ? recommend(hw, catalog, "chat") : null;
  const complete = hw && catalog ? recommend(hw, catalog, "complete") : null;
  const gpu = hw?.gpus[0];

  const assignModel = (tag: string, role: "chat" | "complete") => {
    if (role === "chat") {
      updateSettings((s) => ({ ...s, activeProvider: "ollama", models: { ...s.models, ollama: tag } }));
      recomputeStatus();
      notify(`Assistant branché sur Ollama · ${tag}.`);
    } else {
      updateSettings((s) => ({
        ...s,
        autocomplete: { enabled: true, provider: "ollama", model: tag },
      }));
      notify(`Autocomplétion : ${tag}.`);
    }
  };

  const row = (c: Candidate, role: "chat" | "complete", highlight: boolean) => {
    const tag = c.variant.tag;
    const bench = settings.benchmarks[benchKey("ollama", tag)];
    const pulling = pull?.tag === tag;
    return (
      <div key={`${role}-${tag}`} className={`ai-model-row${highlight ? " recommended" : ""}`}>
        <div className="ai-model-main">
          <div>
            <strong>{c.model.label}</strong> <span className="ai-muted">{c.variant.quant} · {c.variant.sizeGb} Go</span>{" "}
            <FitBadge fit={c.fit} />
            {c.model.vision && <span className="ai-badge">images</span>}
          </div>
          {c.model.notes && <div className="ai-muted">{c.model.notes}</div>}
          {bench && (
            <div className="ai-muted">
              Mesuré : 1er token {bench.ttftMs} ms · {bench.tokensPerSec} tokens/s
              {role === "complete" &&
                (bench.ttftMs < AUTO_TTFT_MS
                  ? " — autocomplétion automatique possible"
                  : " — trop lent pour l'automatique : à la demande seulement")}
            </div>
          )}
          {pulling && (
            <div className="ai-progress">
              <div className="ai-gauge-bar">
                <i style={{ width: `${Math.round((pull.ratio ?? 0) * 100)}%` }} />
              </div>
              <span className="ai-muted">
                {pull.status}
                {pull.ratio != null ? ` · ${Math.round(pull.ratio * 100)} %` : ""}
              </span>
            </div>
          )}
        </div>
        <div className="ai-model-actions">
          {!ollamaRunning ? null : isInstalled(tag) ? (
            <>
              <button type="button" className="pdf-btn" disabled={benching === tag} onClick={() => void runBench(tag)}>
                {benching === tag ? "Mesure…" : "Mesurer"}
              </button>
              <button type="button" className="pdf-btn primary" onClick={() => assignModel(tag, role)}>
                {role === "chat" ? "Utiliser" : "Pour l'autocomplétion"}
              </button>
            </>
          ) : pulling ? (
            <button type="button" className="pdf-btn" onClick={stopPull}>
              Annuler
            </button>
          ) : (
            <button type="button" className="pdf-btn" disabled={!!pull || c.fit === "no"} onClick={() => startPull(tag)}>
              Installer
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="ai-wizard">
      {hw ? (
        <p className="ai-machine">
          Votre machine : {gpu ? `${gpu.name}, ${gb(gpu.vram)} de VRAM` : "pas de carte graphique dédiée"},{" "}
          {gb(hw.totalRam)} de RAM, {hw.cpuCores ?? hw.cpuThreads} cœurs
          {hw.freeDisk != null ? `, ${gb(hw.freeDisk)} libres` : ""}.
        </p>
      ) : (
        <p className="ai-muted">Analyse de la machine…</p>
      )}
      {!det?.ollama.installed && (
        <div className="ai-banner">
          Ollama n'est pas installé.
          <button
            type="button"
            onClick={() =>
              void import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl("https://ollama.com/download"))
            }
          >
            Télécharger Ollama
          </button>
        </div>
      )}
      {det?.ollama.installed && !ollamaRunning && (
        <div className="ai-banner">Lancez Ollama : la détection se fait automatiquement.</div>
      )}
      {chat && (
        <>
          <h5>Recommandé pour le chat</h5>
          {row(chat, "chat", true)}
        </>
      )}
      {complete && (
        <>
          <h5>Recommandé pour l'autocomplétion</h5>
          {row(complete, "complete", true)}
        </>
      )}
      {hw && catalog && !chat && (
        <p className="ai-warn">Aucun modèle du catalogue ne tient confortablement sur cette machine.</p>
      )}
      {catalog && hw && (
        <details className="ai-advanced" open={showAll} onToggle={(e) => setShowAll(e.currentTarget.open)}>
          <summary>Tout le catalogue</summary>
          {catalog.models.flatMap((m) =>
            m.variants.map((v) =>
              row(
                { model: m, variant: v, fit: fitOf(v.sizeGb, hw, catalog.gpuHeadroomGb) },
                m.roles.includes("chat") ? "chat" : "complete",
                false,
              ),
            ),
          )}
        </details>
      )}
    </div>
  );
}
