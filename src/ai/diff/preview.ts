/** Diff « aperçu » d'une modification IA : au lieu de lignes markdown brutes,
 * on compare les blocs rendus (paragraphes, titres, listes, tableaux…).
 *
 * - Les blocs sont appariés par `diffArrays` sur leur source, puis les blocs
 *   modifiés sont rapprochés par similarité.
 * - Un bloc modifié devient une source markdown « fusionnée » où les passages
 *   supprimés / ajoutés sont balisés par des caractères sentinelles (zone
 *   d'usage privé Unicode). Le composant les transforme en <del>/<ins> après
 *   rendu ; si la fusion casserait la syntaxe, on retombe sur « ancien bloc
 *   barré + nouveau bloc ».
 * - Les blocs sont regroupés en cartes, chacune reliée aux hunks ligne à
 *   ligne qu'elle recouvre : accepter une carte accepte ses hunks.
 *
 * Code pur, sans DOM : testé par Vitest. */

import { diffArrays, diffWordsWithSpace } from "diff";
import { parseBlockBounds, splitTableRow } from "../../markdown/render";
import type { Hunk } from "../types";

export const DEL_START = "\uE000";
export const DEL_END = "\uE001";
export const INS_START = "\uE002";
export const INS_END = "\uE003";
export const MARK_RE = /[\uE000-\uE003]/g;

export type PvBlock = { kind: string; lineStart: number; lineEnd: number; source: string };

export type PvItem =
  | { type: "same" | "del" | "add"; block: PvBlock }
  /** `merged` : source du nouveau bloc balisée par les sentinelles. */
  | { type: "edit"; old: PvBlock; next: PvBlock; merged: string };

export type PvCard = {
  hunkIds: string[];
  items: PvItem[];
  /** Ligne (côté ancien) du premier changement, pour « aller au passage ». */
  revealLine: number;
};

const SIM_MIN = 0.4;
const MAX_WORD_DIFF = 20000;
/** Un passage modifié contenant de la syntaxe inline ne peut pas être balisé
 * sans risquer de casser le rendu : on montre alors ancien / nouveau bloc. */
const UNSAFE = /[\n*_`[\]()<>$~|\\!]/;
const LINE_PREFIX = /^(?:[-*]\s+(?:\[[ xX]\]\s+)?|\d+\\*\.\s+|>\s?)/;
const ORDERED_NO = /^\d+(\\*\.\s+)/;

function blocksOf(text: string): PvBlock[] {
  const lines = text.split("\n");
  return parseBlockBounds(text).map((b) => ({
    ...b,
    source: lines.slice(b.lineStart, b.lineEnd + 1).join("\n"),
  }));
}

/** « liste », « liste numérotée », « liste de tâches » → « liste ». */
const family = (kind: string) => kind.split(" ")[0];

/** Part du texte commun aux deux versions (0 → rien en commun, 1 → identique). */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length || a.length + b.length > MAX_WORD_DIFF) return 0;
  let common = 0;
  for (const p of diffWordsWithSpace(a, b)) {
    if (!p.added && !p.removed) common += p.value.length;
  }
  return (2 * common) / (a.length + b.length);
}

/** Fusion mot à mot de deux textes d'une ligne. `null` si trop différents ou
 * si un passage modifié touche à la syntaxe markdown. */
export function mergeText(oldText: string, newText: string): string | null {
  if (oldText === newText) return newText;
  if (oldText.length + newText.length > MAX_WORD_DIFF) return null;
  const parts = diffWordsWithSpace(oldText, newText);
  let common = 0;
  for (const p of parts) {
    if (p.added || p.removed) {
      if (UNSAFE.test(p.value)) return null;
    } else common += p.value.length;
  }
  if ((2 * common) / (oldText.length + newText.length) < SIM_MIN) return null;

  // Regroupe les changements voisins : « a b c » → « x y z » se lit mieux
  // comme un seul passage barré suivi d'un seul passage ajouté qu'en
  // alternance mot par mot. Un espace isolé entre deux changements est absorbé.
  let out = "";
  let del = "";
  let ins = "";
  const flush = () => {
    if (del) out += DEL_START + del + DEL_END;
    if (ins) out += INS_START + ins + INS_END;
    del = ins = "";
  };
  parts.forEach((p, i) => {
    if (p.removed) del += p.value;
    else if (p.added) ins += p.value;
    else {
      const nextPart = parts[i + 1];
      const between =
        (del || ins) && (nextPart?.added || nextPart?.removed) && /^\s+$/.test(p.value);
      if (between) {
        del += p.value;
        ins += p.value;
      } else {
        flush();
        out += p.value;
      }
    }
  });
  flush();
  return out;
}

function wrap(text: string, start: string, end: string): string {
  return start + text + end;
}

/** Balise tout le contenu d'une ligne de liste / citation, sans toucher au
 * marqueur de début de ligne (sinon la liste ne serait plus reconnue). */
function wrapLine(line: string, start: string, end: string): string {
  const prefix = LINE_PREFIX.exec(line)?.[0] ?? "";
  return prefix + wrap(line.slice(prefix.length), start, end);
}

function mergeLine(oldLine: string, newLine: string): string | null {
  const op = LINE_PREFIX.exec(oldLine)?.[0] ?? "";
  const np = LINE_PREFIX.exec(newLine)?.[0] ?? "";
  // Case cochée / décochée, puce changée… : visible seulement en entier.
  if (op.replace(ORDERED_NO, "1$1") !== np.replace(ORDERED_NO, "1$1")) return null;
  const content = mergeText(oldLine.slice(op.length), newLine.slice(np.length));
  return content == null ? null : np + content;
}

const escapeCell = (cell: string) => cell.replace(/\|/g, "\\|");
const buildRow = (cells: string[]) => `| ${cells.join(" | ")} |`;

function wrapRow(line: string, start: string, end: string): string {
  return buildRow(splitTableRow(line).map((c) => wrap(escapeCell(c), start, end)));
}

function mergeRow(oldLine: string, newLine: string): string | null {
  const oc = splitTableRow(oldLine);
  const nc = splitTableRow(newLine);
  if (oc.length !== nc.length) return null;
  const cells: string[] = [];
  for (let i = 0; i < nc.length; i++) {
    const m = mergeText(escapeCell(oc[i]), escapeCell(nc[i]));
    if (m == null) return null;
    cells.push(m);
  }
  return buildRow(cells);
}

type Pairing<T> = { type: "pair"; a: T; b: T } | { type: "del"; a: T } | { type: "add"; b: T };

/** Rapproche deux suites d'éléments modifiés : un élément ancien et un nouveau
 * suffisamment semblables forment une paire, les autres sont supprimés /
 * ajoutés. Glouton, avec un pas d'avance pour les insertions / suppressions. */
function pairUp<T>(olds: T[], news: T[], match: (a: T, b: T) => boolean): Pairing<T>[] {
  const out: Pairing<T>[] = [];
  let i = 0;
  let j = 0;
  while (i < olds.length && j < news.length) {
    if (match(olds[i], news[j])) {
      out.push({ type: "pair", a: olds[i++], b: news[j++] });
    } else if (j + 1 < news.length && match(olds[i], news[j + 1])) {
      out.push({ type: "add", b: news[j++] });
    } else if (i + 1 < olds.length && match(olds[i + 1], news[j])) {
      out.push({ type: "del", a: olds[i++] });
    } else {
      out.push({ type: "del", a: olds[i++] });
      out.push({ type: "add", b: news[j++] });
    }
  }
  while (i < olds.length) out.push({ type: "del", a: olds[i++] });
  while (j < news.length) out.push({ type: "add", b: news[j++] });
  return out;
}

/** Fusion ligne à ligne d'un bloc multi-lignes (liste, citation, lignes d'un
 * tableau) : lignes identiques reprises telles quelles, lignes modifiées
 * fusionnées mot à mot, lignes ajoutées / supprimées balisées en entier. */
function mergeLines(
  oldLines: string[],
  newLines: string[],
  merge: (a: string, b: string) => string | null,
  wrapWhole: (line: string, start: string, end: string) => string,
): string[] {
  const norm = (l: string) => l.replace(ORDERED_NO, "1$1");
  const out: string[] = [];
  let oi = 0;
  let ni = 0;
  let dels: string[] = [];
  let adds: string[] = [];
  const flush = () => {
    const pairs = pairUp(dels, adds, (a, b) => similarity(norm(a), norm(b)) >= SIM_MIN);
    for (const p of pairs) {
      const merged = p.type === "pair" ? merge(p.a, p.b) : null;
      if (merged != null) out.push(merged);
      else {
        if (p.type !== "add") out.push(wrapWhole(p.a, DEL_START, DEL_END));
        if (p.type !== "del") out.push(wrapWhole(p.b, INS_START, INS_END));
      }
    }
    dels = [];
    adds = [];
  };
  for (const c of diffArrays(oldLines.map(norm), newLines.map(norm))) {
    const n = c.count ?? c.value.length;
    if (c.removed) {
      dels.push(...oldLines.slice(oi, oi + n));
      oi += n;
    } else if (c.added) {
      adds.push(...newLines.slice(ni, ni + n));
      ni += n;
    } else {
      flush();
      // Côté nouveau : la numérotation d'une liste peut avoir bougé.
      out.push(...newLines.slice(ni, ni + n));
      oi += n;
      ni += n;
    }
  }
  flush();
  return out;
}

/** Source fusionnée d'un bloc modifié, ou `null` s'il vaut mieux montrer
 * l'ancien et le nouveau bloc séparément. */
export function mergeBlock(old: PvBlock, next: PvBlock): string | null {
  if (family(old.kind) !== family(next.kind)) return null;
  let merged: string | null = null;
  switch (family(next.kind)) {
    case "paragraphe":
      // Le rendu joint les lignes d'un paragraphe par une espace.
      merged = mergeText(old.source.replace(/\n/g, " "), next.source.replace(/\n/g, " "));
      break;
    case "titre":
      merged = mergeText(old.source, next.source);
      break;
    case "liste":
    case "citation":
      merged = mergeLines(old.source.split("\n"), next.source.split("\n"), mergeLine, wrapLine).join("\n");
      break;
    case "tableau": {
      const ol = old.source.split("\n");
      const nl = next.source.split("\n");
      const header = mergeRow(ol[0], nl[0]);
      if (header == null) return null;
      merged = [header, nl[1], ...mergeLines(ol.slice(2), nl.slice(2), mergeRow, wrapRow)].join("\n");
      break;
    }
    default:
      return null; // code, formules : ancien / nouveau en entier
  }
  if (merged == null) return null;
  // Garde-fou : la fusion doit rester un seul bloc de même nature.
  const check = parseBlockBounds(merged);
  if (check.length !== 1 || family(check[0].kind) !== family(next.kind)) return null;
  return merged;
}

function blockItems(olds: PvBlock[], news: PvBlock[]): PvItem[] {
  const items: PvItem[] = [];
  const pairs = pairUp(
    olds,
    news,
    (a, b) => family(a.kind) === family(b.kind) && similarity(a.source, b.source) >= SIM_MIN,
  );
  for (const p of pairs) {
    if (p.type === "pair") {
      const merged = mergeBlock(p.a, p.b);
      if (merged != null) {
        items.push({ type: "edit", old: p.a, next: p.b, merged });
        continue;
      }
    }
    if (p.type !== "add") items.push({ type: "del", block: p.a });
    if (p.type !== "del") items.push({ type: "add", block: p.b });
  }
  return items;
}

type Seg =
  | { type: "same"; o: number; n: number }
  | { type: "change"; removed: number[]; added: number[] };

type Group = {
  seg: number;
  removed: PvBlock[];
  added: PvBlock[];
  /** Plages (inclusives) entre les blocs inchangés qui encadrent le groupe. */
  oldGap: [number, number];
  newGap: [number, number];
  hunkIds: string[];
};

function changedLines(h: Hunk) {
  return {
    olds: h.lines.filter((l) => l.kind === "del").map((l) => l.oldNo!),
    news: h.lines.filter((l) => l.kind === "add").map((l) => l.newNo!),
  };
}

/** Première ligne ancienne touchée par un hunk (ou point d'insertion). */
function firstChangedOld(h: Hunk): number {
  let last = h.oldStart;
  for (const l of h.lines) {
    if (l.kind !== "ctx") return l.oldNo ?? last;
    if (l.oldNo != null) last = l.oldNo + 1;
  }
  return h.oldStart;
}

export function buildPreview(base: string, next: string, hunks: Hunk[]): PvCard[] {
  const ob = blocksOf(base);
  const nb = blocksOf(next);
  const oldCount = base.split("\n").length;
  const newCount = next.split("\n").length;

  const segs: Seg[] = [];
  let oi = 0;
  let ni = 0;
  for (const c of diffArrays(
    ob.map((b) => b.source),
    nb.map((b) => b.source),
  )) {
    const n = c.count ?? c.value.length;
    if (!c.added && !c.removed) {
      for (let k = 0; k < n; k++) segs.push({ type: "same", o: oi++, n: ni++ });
      continue;
    }
    let last = segs[segs.length - 1];
    if (last?.type !== "change") {
      last = { type: "change", removed: [], added: [] };
      segs.push(last);
    }
    for (let k = 0; k < n; k++) {
      if (c.removed) last.removed.push(oi++);
      else last.added.push(ni++);
    }
  }

  const touched = hunks.map((h) => ({ h, ...changedLines(h) }));
  const groups: Group[] = [];
  segs.forEach((s, idx) => {
    if (s.type !== "change") return;
    const prev = segs[idx - 1] as Extract<Seg, { type: "same" }> | undefined;
    const nextSame = segs[idx + 1] as Extract<Seg, { type: "same" }> | undefined;
    const oldGap: [number, number] = [
      prev ? ob[prev.o].lineEnd + 1 : 0,
      nextSame ? ob[nextSame.o].lineStart - 1 : oldCount - 1,
    ];
    const newGap: [number, number] = [
      prev ? nb[prev.n].lineEnd + 1 : 0,
      nextSame ? nb[nextSame.n].lineStart - 1 : newCount - 1,
    ];
    const inGap = (x: number, [a, b]: [number, number]) => x >= a && x <= b;
    let hunkIds = touched
      .filter((t) => t.olds.some((x) => inGap(x, oldGap)) || t.news.some((x) => inGap(x, newGap)))
      .map((t) => t.h.id);
    if (!hunkIds.length && hunks.length) {
      // Ne devrait pas arriver ; on rattache au hunk le plus proche.
      const nearest = [...hunks].sort(
        (a, b) => Math.abs(a.oldStart - oldGap[0]) - Math.abs(b.oldStart - oldGap[0]),
      )[0];
      hunkIds = [nearest.id];
    }
    groups.push({
      seg: idx,
      removed: s.removed.map((i) => ob[i]),
      added: s.added.map((i) => nb[i]),
      oldGap,
      newGap,
      hunkIds,
    });
  });

  // Composantes connexes groupes ↔ hunks : une carte par composante.
  type Draft = { hunkIds: Set<string>; groups: Group[] };
  const drafts: Draft[] = [];
  for (const g of groups) {
    const linked = drafts.filter((d) => g.hunkIds.some((id) => d.hunkIds.has(id)));
    const merged: Draft = { hunkIds: new Set(g.hunkIds), groups: [g] };
    for (const d of linked) {
      d.hunkIds.forEach((id) => merged.hunkIds.add(id));
      merged.groups.unshift(...d.groups);
      drafts.splice(drafts.indexOf(d), 1);
    }
    merged.groups.sort((a, b) => a.seg - b.seg);
    drafts.push(merged);
  }
  // Hunks sans effet visible (lignes vides ajoutées / retirées…).
  for (const h of hunks) {
    if (!drafts.some((d) => d.hunkIds.has(h.id))) drafts.push({ hunkIds: new Set([h.id]), groups: [] });
  }

  const order = new Map(hunks.map((h, i) => [h.id, i]));
  const cards = drafts.map((d): PvCard => {
    const ids = [...d.hunkIds].sort((a, b) => order.get(a)! - order.get(b)!);
    const items: PvItem[] = [];
    d.groups.forEach((g, gi) => {
      if (gi > 0) {
        // Blocs inchangés entre deux groupes de la même carte.
        for (let k = d.groups[gi - 1].seg + 1; k < g.seg; k++) {
          const s = segs[k];
          if (s.type === "same") items.push({ type: "same", block: nb[s.n] });
        }
      }
      items.push(...blockItems(g.removed, g.added));
    });
    const first = hunks.find((h) => h.id === ids[0]);
    return { hunkIds: ids, items, revealLine: first ? firstChangedOld(first) : 0 };
  });
  return cards.sort((a, b) => order.get(a.hunkIds[0])! - order.get(b.hunkIds[0])!);
}

/** Nombre de sentinelles d'une source fusionnée. */
export function markCount(merged: string): number {
  return merged.match(MARK_RE)?.length ?? 0;
}
