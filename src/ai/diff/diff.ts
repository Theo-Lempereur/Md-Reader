/** Calcul des hunks d'une modification IA : `diffLines` de jsdiff, regroupé
 * en hunks avec 3 lignes de contexte, puis raffinement mot à mot à
 * l'intérieur de chaque hunk. Code pur, sans DOM : testé par Vitest. */

import { diffLines, diffWordsWithSpace } from "diff";
import type { Hunk, HunkLine, WordSeg } from "../types";

export const CONTEXT_LINES = 3;

/** FNV-1a 32 bits : suffisant pour détecter qu'un document a bougé. */
export function hashContent(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0") + ":" + text.length.toString(36);
}

/** Forme canonique pour le diff : fins de ligne `\n`, un `\n` final. */
export function canonical(text: string): string {
  const t = text.replace(/\r\n?/g, "\n");
  return t.endsWith("\n") ? t : t + "\n";
}

/** Lignes d'un texte canonique (sans l'entrée vide après le `\n` final). */
export function toLines(text: string): string[] {
  const t = canonical(text);
  return t.slice(0, -1).split("\n");
}

export function fromLines(lines: string[]): string {
  return lines.join("\n") + "\n";
}

type Op = { kind: "ctx" | "del" | "add"; text: string };

function lineOps(base: string, next: string): Op[] {
  const ops: Op[] = [];
  for (const change of diffLines(canonical(base), canonical(next))) {
    const kind: Op["kind"] = change.added ? "add" : change.removed ? "del" : "ctx";
    const value = change.value.endsWith("\n") ? change.value.slice(0, -1) : change.value;
    for (const text of value.split("\n")) ops.push({ kind, text });
  }
  return ops;
}

/** Découpe mot à mot une paire (lignes supprimées, lignes ajoutées). */
function refineWords(dels: HunkLine[], adds: HunkLine[]) {
  if (!dels.length || !adds.length) return;
  const oldText = dels.map((l) => l.text).join("\n");
  const newText = adds.map((l) => l.text).join("\n");
  // Réécriture complète : le surlignage mot à mot n'apporte rien.
  if (oldText.length + newText.length > 20000) return;
  const parts = diffWordsWithSpace(oldText, newText);
  const oldSegs: WordSeg[][] = [[]];
  const newSegs: WordSeg[][] = [[]];
  const push = (target: WordSeg[][], text: string, changed: boolean) => {
    const pieces = text.split("\n");
    pieces.forEach((piece, i) => {
      if (i > 0) target.push([]);
      if (piece) target[target.length - 1].push({ text: piece, changed });
    });
  };
  for (const p of parts) {
    if (p.added) push(newSegs, p.value, true);
    else if (p.removed) push(oldSegs, p.value, true);
    else {
      push(oldSegs, p.value, false);
      push(newSegs, p.value, false);
    }
  }
  dels.forEach((l, i) => (l.words = oldSegs[i] ?? [{ text: l.text, changed: true }]));
  adds.forEach((l, i) => (l.words = newSegs[i] ?? [{ text: l.text, changed: true }]));
}

let hunkSeq = 0;

export function computeHunks(base: string, next: string, context = CONTEXT_LINES): Hunk[] {
  const ops = lineOps(base, next);
  // Numérotation des deux côtés.
  const numbered: HunkLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const op of ops) {
    const line: HunkLine = { kind: op.kind, text: op.text };
    if (op.kind !== "add") line.oldNo = oldNo++;
    if (op.kind !== "del") line.newNo = newNo++;
    numbered.push(line);
  }

  const changed = numbered
    .map((l, i) => (l.kind === "ctx" ? -1 : i))
    .filter((i) => i >= 0);
  if (!changed.length) return [];

  // Regroupe les changements séparés par au plus 2 × contexte lignes.
  const ranges: [number, number][] = [];
  let start = changed[0];
  let end = changed[0];
  for (const i of changed.slice(1)) {
    if (i - end - 1 <= context * 2) end = i;
    else {
      ranges.push([start, end]);
      start = end = i;
    }
  }
  ranges.push([start, end]);

  return ranges.map(([s, e]) => {
    const from = Math.max(0, s - context);
    const to = Math.min(numbered.length - 1, e + context);
    const lines = numbered.slice(from, to + 1).map((l) => ({ ...l }));

    // Raffinement mot à mot sur chaque bloc contigu « − puis + ».
    let i = 0;
    while (i < lines.length) {
      if (lines[i].kind === "ctx") {
        i++;
        continue;
      }
      const dels: HunkLine[] = [];
      const adds: HunkLine[] = [];
      while (i < lines.length && lines[i].kind === "del") dels.push(lines[i++]);
      while (i < lines.length && lines[i].kind === "add") adds.push(lines[i++]);
      refineWords(dels, adds);
    }

    const oldSide = lines.filter((l) => l.kind !== "add");
    const newSide = lines.filter((l) => l.kind !== "del");
    const firstOld = lines.find((l) => l.oldNo != null)?.oldNo;
    const firstNew = lines.find((l) => l.newNo != null)?.newNo;
    // Hunk d'insertion pure sans contexte (document vide) : ancrage déduit.
    const oldStart =
      firstOld ?? (lines[0].newNo ?? 0) - newNo + oldNo;
    const newStart = firstNew ?? 0;
    return {
      id: `h${Date.now().toString(36)}-${(hunkSeq++).toString(36)}`,
      oldStart: Math.max(0, oldStart),
      oldLines: oldSide.length,
      newStart,
      newLines: newSide.length,
      lines,
      status: "pending" as const,
    };
  });
}

export function hunkStats(hunks: Hunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.kind === "add") added++;
      else if (l.kind === "del") removed++;
    }
  }
  return { added, removed };
}
