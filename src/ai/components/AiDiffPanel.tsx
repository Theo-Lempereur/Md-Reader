import { useEffect, useState } from "react";
import { Icon } from "../../components/Icons";
import { applyPatchNow, discardPatch, getBridge } from "../actions";
import { obsoleteHunkIds } from "../diff/apply";
import { hunkStats } from "../diff/diff";
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

export function AiDiffPanel({ patchId, onClose }: { patchId: string; onClose: () => void }) {
  const patch = useAi((s) => s.patches[patchId]);
  const [obsolete, setObsolete] = useState<Set<string>>(new Set());

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
  const inReview = patch.state === "review";

  return (
    <div className="ai-diff">
      <div className="side-head">
        <span className="side-title">Modification IA</span>
        <span className="side-kind ai-add-count">+{stats.added}</span>
        <span className="side-kind ai-del-count">−{stats.removed}</span>
        <span className="side-spacer" />
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
        {patch.hunks.map((h, idx) => {
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
