import { useEffect, useMemo, useState } from "react";
import { Icon } from "../../components/Icons";
import { applyPatchNow, discardPatch, getBridge } from "../actions";
import { obsoleteHunkIds } from "../diff/apply";
import { hunkStats } from "../diff/diff";
import { buildPreview, type PvCard } from "../diff/preview";
import { AiDiffPreview } from "./AiDiffPreview";
import { updatePatch, useAi } from "../useAi";
import type { Hunk, HunkLine, HunkStatus } from "../types";

function LineText({ line }: { line: HunkLine }) {
  if (!line.words || line.kind === "ctx") return <>{line.text || " "}</>;
  return (
    <>
      {line.words.length
        ? line.words.map((w, i) =>
            w.changed ? (
              <mark key={i} className="ai-word">
                {w.text}
              </mark>
            ) : (
              <span key={i}>{w.text}</span>
            ),
          )
        : " "}
    </>
  );
}

const CONTEXT_KEEP = 2;

/** Lignes d'un hunk, avec repliage des longues plages de contexte. */
function HunkBody({ hunk }: { hunk: Hunk }) {
  const [expanded, setExpanded] = useState(false);
  const rows: (HunkLine | { fold: number; key: string })[] = [];
  let i = 0;
  while (i < hunk.lines.length) {
    if (hunk.lines[i].kind !== "ctx") {
      rows.push(hunk.lines[i++]);
      continue;
    }
    let j = i;
    while (j < hunk.lines.length && hunk.lines[j].kind === "ctx") j++;
    const run = hunk.lines.slice(i, j);
    // On garde les lignes voisines d'un changement, on replie le reste.
    const head = i === 0 ? 0 : CONTEXT_KEEP;
    const tail = j === hunk.lines.length ? 0 : CONTEXT_KEEP;
    const hidden = run.length - head - tail;
    if (!expanded && hidden > 1) {
      rows.push(...run.slice(0, head));
      rows.push({ fold: hidden, key: `f${i}` });
      rows.push(...run.slice(run.length - tail));
    } else {
      rows.push(...run);
    }
    i = j;
  }
  return (
    <div className="ai-hunk-body">
      {rows.map((row, idx) =>
        "fold" in row ? (
          <button key={row.key} type="button" className="ai-fold" onClick={() => setExpanded(true)}>
            ⋯ {row.fold} ligne{row.fold > 1 ? "s" : ""} inchangée{row.fold > 1 ? "s" : ""}
          </button>
        ) : (
          <div key={idx} className={`ai-line ${row.kind}`}>
            <span className="ai-gutter">{row.oldNo != null ? row.oldNo + 1 : ""}</span>
            <span className="ai-gutter">{row.newNo != null ? row.newNo + 1 : ""}</span>
            <span className="ai-sign">{row.kind === "add" ? "+" : row.kind === "del" ? "−" : ""}</span>
            <span className="ai-text">
              <LineText line={row} />
            </span>
          </div>
        ),
      )}
    </div>
  );
}

const statusLabel: Record<HunkStatus, string> = {
  pending: "",
  accepted: "Accepté",
  rejected: "Refusé",
  obsolete: "Obsolète",
};

type DiffView = "preview" | "source";
const VIEW_KEY = "md-reader.ai.diffView";

function loadView(): DiffView {
  try {
    return localStorage.getItem(VIEW_KEY) === "source" ? "source" : "preview";
  } catch {
    return "preview";
  }
}

export function AiDiffPanel({ patchId, onClose }: { patchId: string; onClose: () => void }) {
  const patch = useAi((s) => s.patches[patchId]);
  const [obsolete, setObsolete] = useState<Set<string>>(new Set());
  const [view, setViewState] = useState<DiffView>(loadView);
  const setView = (v: DiffView) => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* stockage indisponible : le choix vaut pour la session */
    }
  };
  // Le contenu d'un patch ne change jamais, seuls les statuts des hunks bougent.
  const cards = useMemo(
    () => (patch ? buildPreview(patch.baseContent, patch.nextContent, patch.hunks) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [patch?.id],
  );

  // L'utilisateur peut continuer à écrire pendant la relecture : on vérifie
  // régulièrement quels hunks ne s'appliquent plus.
  useEffect(() => {
    if (!patch || patch.state !== "review") return;
    const check = () => {
      const current = getBridge().getTabMarkdown(patch.tabId);
      setObsolete(current == null ? new Set(patch.hunks.map((h) => h.id)) : obsoleteHunkIds(patch, current));
    };
    check();
    const t = window.setInterval(check, 1500);
    return () => window.clearInterval(t);
  }, [patch]);

  if (!patch) {
    return (
      <div className="ai-diff">
        <div className="side-head">
          <span className="side-title">Modification IA</span>
          <span className="side-spacer" />
          <button className="icon-btn" title="Fermer" onClick={onClose}>
            <Icon.Close />
          </button>
        </div>
        <p className="ai-muted ai-pad">Cette modification n'existe plus.</p>
      </div>
    );
  }

  const stats = hunkStats(patch.hunks);
  const effective = (h: Hunk): HunkStatus =>
    obsolete.has(h.id) && h.status !== "rejected" ? "obsolete" : h.status;
  const accepted = patch.hunks.filter((h) => effective(h) === "accepted").length;
  const applicable = patch.hunks.filter((h) => effective(h) !== "obsolete");
  const setStatus = (id: string, status: HunkStatus) =>
    updatePatch(patch.id, (p) => ({
      ...p,
      hunks: p.hunks.map((h) => (h.id === id ? { ...h, status: h.status === status ? "pending" : status } : h)),
    }));
  const byId = new Map(patch.hunks.map((h) => [h.id, h]));
  /** Statut d'une carte : celui de ses hunks s'ils concordent. */
  const cardStatus = (card: PvCard): HunkStatus | "mixed" => {
    const sts = card.hunkIds.map((id) => effective(byId.get(id)!));
    const live = sts.filter((st) => st !== "obsolete");
    if (!live.length) return "obsolete";
    return live.every((st) => st === live[0]) ? live[0] : "mixed";
  };
  const setCardStatus = (card: PvCard, status: HunkStatus) => {
    const next = cardStatus(card) === status ? "pending" : status;
    const ids = new Set(card.hunkIds.filter((id) => !obsolete.has(id)));
    updatePatch(patch.id, (p) => ({
      ...p,
      hunks: p.hunks.map((h) => (ids.has(h.id) ? { ...h, status: next } : h)),
    }));
  };
  const inReview = patch.state === "review";

  return (
    <div className="ai-diff">
      <div className="side-head">
        <span className="side-title">Modification IA</span>
        <span className="side-kind ai-add-count">+{stats.added}</span>
        <span className="side-kind ai-del-count">−{stats.removed}</span>
        <span className="side-spacer" />
        <div className="ai-view-toggle" role="tablist" aria-label="Affichage des modifications">
          <button
            type="button"
            role="tab"
            aria-selected={view === "preview"}
            className={view === "preview" ? "on" : ""}
            title="Voir les modifications telles qu'elles apparaîtront dans le document"
            onClick={() => setView("preview")}
          >
            Aperçu
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "source"}
            className={view === "source" ? "on" : ""}
            title="Voir les modifications ligne à ligne dans le markdown"
            onClick={() => setView("source")}
          >
            Source
          </button>
        </div>
        <button className="icon-btn" title="Fermer (la modification reste disponible dans le chat)" onClick={onClose}>
          <Icon.Close />
        </button>
      </div>
      <div className="ai-diff-label">{patch.label}</div>
      {obsolete.size > 0 && inReview && (
        <div className="ai-warn ai-pad-x">
          Le document a changé depuis la génération : {obsolete.size} bloc{obsolete.size > 1 ? "s ne peuvent" : " ne peut"} plus
          s'appliquer et {obsolete.size > 1 ? "sont grisés" : "est grisé"}.
        </div>
      )}
      <div className="ai-diff-body">
        {view === "preview" &&
          cards.map((card, idx) => {
            const st = cardStatus(card);
            const shown: HunkStatus = st === "mixed" ? "pending" : st;
            return (
              <div key={card.hunkIds.join(" ")} className={`ai-hunk ${shown}`}>
                <div className="ai-hunk-head">
                  <span>Modification {idx + 1}</span>
                  {st === "mixed" ? (
                    <span className="ai-hunk-status">Partiel</span>
                  ) : (
                    statusLabel[st] && <span className={`ai-hunk-status ${st}`}>{statusLabel[st]}</span>
                  )}
                  <span className="ai-spacer" />
                  <button
                    type="button"
                    title="Aller à ce passage dans le document"
                    onClick={() => getBridge().revealLine(patch.tabId, card.revealLine)}
                  >
                    <Icon.Target />
                  </button>
                  {inReview && st !== "obsolete" && (
                    <>
                      <button
                        type="button"
                        className={st === "rejected" ? "on reject" : ""}
                        onClick={() => setCardStatus(card, "rejected")}
                      >
                        Refuser
                      </button>
                      <button
                        type="button"
                        className={st === "accepted" ? "on accept" : ""}
                        onClick={() => setCardStatus(card, "accepted")}
                      >
                        <Icon.Check /> Accepter
                      </button>
                    </>
                  )}
                </div>
                <AiDiffPreview card={card} />
              </div>
            );
          })}
        {view === "source" && patch.hunks.map((h, idx) => {
          const st = effective(h);
          return (
            <div key={h.id} className={`ai-hunk ${st}`}>
              <div className="ai-hunk-head">
                <span>
                  Bloc {idx + 1} · lignes {h.oldStart + 1}–{h.oldStart + Math.max(1, h.oldLines)}
                </span>
                {statusLabel[st] && <span className={`ai-hunk-status ${st}`}>{statusLabel[st]}</span>}
                <span className="ai-spacer" />
                <button
                  type="button"
                  title="Aller à ce passage dans le document"
                  onClick={() => getBridge().revealLine(patch.tabId, h.oldStart + 3)}
                >
                  <Icon.Target />
                </button>
                {inReview && st !== "obsolete" && (
                  <>
                    <button
                      type="button"
                      className={st === "rejected" ? "on reject" : ""}
                      onClick={() => setStatus(h.id, "rejected")}
                    >
                      Refuser
                    </button>
                    <button
                      type="button"
                      className={st === "accepted" ? "on accept" : ""}
                      onClick={() => setStatus(h.id, "accepted")}
                    >
                      <Icon.Check /> Accepter
                    </button>
                  </>
                )}
              </div>
              <HunkBody hunk={h} />
            </div>
          );
        })}
      </div>
      {inReview ? (
        <div className="ai-diff-foot">
          <button type="button" className="pdf-btn" onClick={() => discardPatch(patch.id)}>
            Tout refuser
          </button>
          <span className="ai-spacer" />
          <button
            type="button"
            className="pdf-btn"
            disabled={!applicable.length}
            onClick={() => {
              updatePatch(patch.id, (p) => ({
                ...p,
                hunks: p.hunks.map((h) => (obsolete.has(h.id) ? h : { ...h, status: "accepted" })),
              }));
              // L'état vient d'être mis à jour de façon synchrone dans le store.
              applyPatchNow(patch.id);
            }}
          >
            Tout accepter
          </button>
          <button
            type="button"
            className="pdf-btn primary"
            disabled={!accepted}
            title="Applique les blocs acceptés en une seule étape (un Ctrl+Z l'annule)"
            onClick={() => applyPatchNow(patch.id)}
          >
            Appliquer {accepted ? `(${accepted})` : ""}
          </button>
        </div>
      ) : (
        <div className="ai-diff-foot">
          <span className="ai-muted">
            {patch.state === "applied" ? "Modification appliquée." : "Modification ignorée."}
          </span>
        </div>
      )}
    </div>
  );
}
