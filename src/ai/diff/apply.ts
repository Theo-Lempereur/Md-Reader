/** Application des hunks acceptés.
 *
 * Cas nominal : le document n'a pas bougé depuis la génération (empreinte
 * identique) → on reconstruit depuis `baseContent`. Sinon (l'utilisateur a
 * tapé pendant la génération), chaque hunk est ré-ancré par correspondance
 * de son côté « ancien » (contexte + lignes supprimées) ; ceux qui ne se
 * retrouvent pas sont marqués obsolètes et jamais appliqués de force. */

import type { AiPatch, Hunk } from "../types";
import { computeHunks, fromLines, hashContent, canonical, toLines } from "./diff";

const oldSide = (h: Hunk) => h.lines.filter((l) => l.kind !== "add").map((l) => l.text);
const newSide = (h: Hunk) => h.lines.filter((l) => l.kind !== "del").map((l) => l.text);

export function isBaseUnchanged(patch: Pick<AiPatch, "baseHash">, current: string): boolean {
  return hashContent(canonical(current)) === patch.baseHash;
}

/** Reconstruit le texte depuis la base : hunks acceptés côté nouveau, les
 * autres côté ancien. */
export function applyHunks(base: string, hunks: Hunk[], accepted: Set<string>): string {
  const lines = toLines(base);
  const out: string[] = [];
  let cursor = 0;
  for (const h of [...hunks].sort((a, b) => a.oldStart - b.oldStart)) {
    if (h.oldStart < cursor) continue; // chevauchement impossible en théorie
    out.push(...lines.slice(cursor, h.oldStart));
    out.push(...(accepted.has(h.id) ? newSide(h) : oldSide(h)));
    cursor = h.oldStart + h.oldLines;
  }
  out.push(...lines.slice(cursor));
  return fromLines(out);
}

function matchesAt(lines: string[], needle: string[], at: number): boolean {
  if (at < 0 || at + needle.length > lines.length) return false;
  for (let i = 0; i < needle.length; i++) {
    if (lines[at + i] !== needle[i]) return false;
  }
  return true;
}

/** Position de `needle` dans `lines` la plus proche de `expected`, à partir
 * de `from`. `-1` si introuvable. */
function findNearest(lines: string[], needle: string[], expected: number, from: number): number {
  if (!needle.length) return -1;
  let best = -1;
  let bestDist = Infinity;
  for (let at = from; at + needle.length <= lines.length; at++) {
    if (lines[at] !== needle[0] || !matchesAt(lines, needle, at)) continue;
    const dist = Math.abs(at - expected);
    if (dist < bestDist) {
      best = at;
      bestDist = dist;
    }
  }
  return best;
}

export type ReanchorResult = {
  content: string;
  applied: string[];
  obsolete: string[];
};

/** Applique `hunks` (tous considérés acceptés) sur un texte `current` qui a
 * pu diverger de la base. */
export function reanchorHunks(current: string, hunks: Hunk[]): ReanchorResult {
  const lines = toLines(current);
  const ordered = [...hunks].sort((a, b) => a.oldStart - b.oldStart);
  const placements: { hunk: Hunk; at: number }[] = [];
  const obsolete: string[] = [];
  let from = 0;
  let drift = 0;
  for (const h of ordered) {
    const at = findNearest(lines, oldSide(h), h.oldStart + drift, from);
    if (at < 0) {
      obsolete.push(h.id);
      continue;
    }
    placements.push({ hunk: h, at });
    drift = at - h.oldStart;
    from = at + h.oldLines;
  }
  const out: string[] = [];
  let cursor = 0;
  for (const { hunk, at } of placements) {
    out.push(...lines.slice(cursor, at));
    out.push(...newSide(hunk));
    cursor = at + hunk.oldLines;
  }
  out.push(...lines.slice(cursor));
  return {
    content: fromLines(out),
    applied: placements.map((p) => p.hunk.id),
    obsolete,
  };
}

/** Hunks qui ne peuvent plus s'appliquer sur `current` (pour les griser). */
export function obsoleteHunkIds(patch: AiPatch, current: string): Set<string> {
  if (isBaseUnchanged(patch, current)) return new Set();
  const live = patch.hunks.filter((h) => h.status !== "rejected");
  return new Set(reanchorHunks(current, live).obsolete);
}

export type ApplyOutcome = {
  content: string;
  applied: string[];
  obsolete: string[];
};

/** Calcule le contenu final à écrire pour les hunks acceptés du patch. */
export function applyPatch(patch: AiPatch, current: string): ApplyOutcome {
  const accepted = patch.hunks.filter((h) => h.status === "accepted");
  if (isBaseUnchanged(patch, current)) {
    return {
      content: applyHunks(patch.baseContent, patch.hunks, new Set(accepted.map((h) => h.id))),
      applied: accepted.map((h) => h.id),
      obsolete: [],
    };
  }
  return reanchorHunks(current, accepted);
}

/** Annule une modification appliquée, même longtemps après, par application
 * du patch inverse (après → avant) ré-ancré sur le texte courant. */
export function revertChange(
  before: string,
  after: string,
  current: string,
): { content: string; complete: boolean } {
  if (canonical(current) === canonical(after)) {
    return { content: canonical(before), complete: true };
  }
  const inverse = computeHunks(after, before);
  const res = reanchorHunks(current, inverse);
  return { content: res.content, complete: res.obsolete.length === 0 };
}
