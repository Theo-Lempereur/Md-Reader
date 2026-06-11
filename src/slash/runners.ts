import { convertFileSrc } from "@tauri-apps/api/core";
import type { ToolbarAction } from "../components/Toolbar";

/** Caractère marqueur utilisé dans les templates LaTeX pour indiquer les
 * positions de placeholders. Le premier devient la position du caret final ;
 * les suivants servent à la navigation Tab. */
export const MATH_PLACEHOLDER = "◆";

export type SlashCtx = {
  editor: HTMLElement;
  triggerNode: Node;
  triggerOffset: number;
  onInput?: () => void;
};

/** Supprime le texte allant de la position de déclenchement (juste avant `/`)
 * jusqu'au caret actuel. Positionne le caret au point de suppression. */
export function clearTriggerText(
  editor: HTMLElement,
  triggerNode: Node,
  triggerOffset: number,
): void {
  if (!editor.contains(triggerNode)) return;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const caret = sel.getRangeAt(0).cloneRange();
  const del = document.createRange();
  try {
    del.setStart(triggerNode, triggerOffset);
    del.setEnd(caret.endContainer, caret.endOffset);
  } catch {
    return;
  }
  del.deleteContents();
  sel.removeAllRanges();
  const collapse = document.createRange();
  collapse.setStart(triggerNode, triggerOffset);
  collapse.collapse(true);
  sel.addRange(collapse);
}

export function dispatchInput(editor: HTMLElement) {
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Place le caret au 1er MATH_PLACEHOLDER trouvé dans `root` (et supprime ce
 * marqueur). Si aucun placeholder n'existe, place le caret à la fin de `root`. */
export function placeCaretAtFirstPlaceholder(root: Node): void {
  const sel = window.getSelection();
  if (!sel) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let target: Text | null = null;
  let idx = -1;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const i = node.data.indexOf(MATH_PLACEHOLDER);
    if (i >= 0) {
      target = node;
      idx = i;
      break;
    }
  }
  const range = document.createRange();
  if (target && idx >= 0) {
    const data = target.data;
    target.data = data.slice(0, idx) + data.slice(idx + MATH_PLACEHOLDER.length);
    range.setStart(target, idx);
  } else {
    range.selectNodeContents(root);
    range.collapse(false);
  }
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Saute au MATH_PLACEHOLDER suivant à l'intérieur d'un conteneur. Renvoie
 * `true` s'il en a trouvé un, `false` sinon (et le caret reste en place). */
export function jumpToNextPlaceholder(root: Node): boolean {
  const sel = window.getSelection();
  if (!sel) return false;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let target: Text | null = null;
  let idx = -1;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const i = node.data.indexOf(MATH_PLACEHOLDER);
    if (i >= 0) {
      target = node;
      idx = i;
      break;
    }
  }
  if (!target || idx < 0) return false;
  const data = target.data;
  target.data = data.slice(0, idx) + data.slice(idx + MATH_PLACEHOLDER.length);
  const range = document.createRange();
  range.setStart(target, idx);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
}

/** Place le caret à la fin du contenu de `el`. */
function placeCaretAtEndOf(el: HTMLElement) {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Insère un nœud HTML au caret et place le caret à l'intérieur (premier
 * descendant éditable). */
function insertNodeAtCaret(node: Node) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  range.deleteContents();
  range.insertNode(node);
  const after = document.createRange();
  after.setStartAfter(node);
  after.collapse(true);
  sel.removeAllRanges();
  sel.addRange(after);
}

/* ------------------------------------------------------------------ */
/* Commandes alignées sur la toolbar (réutilisées par /raccourcis)     */
/* ------------------------------------------------------------------ */

export function runWysiwygCommand(editor: HTMLElement, action: ToolbarAction) {
  switch (action) {
    case "bold":
      document.execCommand("bold");
      return;
    case "italic":
      document.execCommand("italic");
      return;
    case "strike":
      document.execCommand("strikeThrough");
      return;
    case "code":
      wrapInCode(editor);
      return;
    case "h1":
      document.execCommand("formatBlock", false, "H1");
      return;
    case "h2":
      document.execCommand("formatBlock", false, "H2");
      return;
    case "h3":
      document.execCommand("formatBlock", false, "H3");
      return;
    case "quote":
      document.execCommand("formatBlock", false, "BLOCKQUOTE");
      return;
    case "ul":
      document.execCommand("insertUnorderedList");
      return;
    case "ol":
      document.execCommand("insertOrderedList");
      return;
    case "link":
      // Cas géré au niveau supérieur (ouvre le formulaire de lien).
      return;
    case "clearFormat":
      clearInlineFormat(editor);
      return;
    case "undo":
      document.execCommand("undo");
      return;
    case "redo":
      document.execCommand("redo");
      return;
  }
}

export function wrapInCode(editor: HTMLElement) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  if (!editor.contains(range.startContainer)) return;

  const code = document.createElement("code");

  if (range.collapsed) {
    const zwsp = document.createTextNode("​");
    code.appendChild(zwsp);
    range.insertNode(code);
    const inner = document.createRange();
    inner.setStart(zwsp, 1);
    inner.collapse(true);
    sel.removeAllRanges();
    sel.addRange(inner);
  } else {
    const fragment = range.extractContents();
    code.appendChild(fragment);
    range.insertNode(code);
    const after = document.createRange();
    after.selectNodeContents(code);
    sel.removeAllRanges();
    sel.addRange(after);
  }
}

/* ------------------------------------------------------------------ */
/* Helpers pour les commandes spécifiques aux slash                    */
/* ------------------------------------------------------------------ */

/** Bloc code fence : <pre><code></code></pre>, caret à l'intérieur. */
export function insertCodeFence(ctx: SlashCtx) {
  clearTriggerText(ctx.editor, ctx.triggerNode, ctx.triggerOffset);
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  const zwsp = document.createTextNode("​");
  code.appendChild(zwsp);
  pre.appendChild(code);
  insertNodeAtCaret(pre);
  const sel = window.getSelection();
  if (sel) {
    const r = document.createRange();
    r.setStart(zwsp, 1);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }
  dispatchInput(ctx.editor);
}

/** Insère une tâche Markdown, vide ou déjà cochée, avec le caret dans son texte. */
export function insertTaskCheckbox(ctx: SlashCtx, checked: boolean) {
  clearTriggerText(ctx.editor, ctx.triggerNode, ctx.triggerOffset);

  const li = document.createElement("li");
  li.className = checked ? "task-li done" : "task-li";

  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  if (checked) input.setAttribute("checked", "");

  const span = document.createElement("span");
  const zwsp = document.createTextNode("​");
  span.appendChild(zwsp);

  li.appendChild(input);
  li.appendChild(span);

  const currentListItem = getCurrentListItem(ctx.editor);
  const parentList = currentListItem?.parentElement;
  if (currentListItem && parentList?.matches("ul, ol")) {
    const text = (currentListItem.textContent ?? "").replace(/​/g, "").trim();
    if (text) currentListItem.after(li);
    else currentListItem.replaceWith(li);
  } else {
    const ul = document.createElement("ul");
    ul.appendChild(li);
    insertNodeAtCaret(ul);
  }

  const sel = window.getSelection();
  if (sel) {
    const r = document.createRange();
    r.setStart(zwsp, 1);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }
  dispatchInput(ctx.editor);
}

/* ------------------------------------------------------------------ */
/* Liens                                                               */
/* ------------------------------------------------------------------ */

const DIACRITICS = /[̀-ͯ]/g;

export function slugify(text: string): string {
  return text
    .normalize("NFD")
    .replace(DIACRITICS, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Liste les headings (h1..h6) de l'éditeur avec leur slug. */
export function collectHeadings(
  editor: HTMLElement,
): { label: string; slug: string }[] {
  const out: { label: string; slug: string }[] = [];
  const seen = new Map<string, number>();
  editor.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((h) => {
    const label = (h.textContent ?? "").trim();
    if (!label) return;
    let slug = h.id || slugify(label);
    if (!slug) return;
    const count = seen.get(slug) ?? 0;
    if (count > 0) slug = `${slug}-${count}`;
    seen.set(slug, count + 1);
    out.push({ label, slug });
  });
  return out;
}

/** Met à jour les `id` des headings de l'éditeur, en évitant les doublons. */
export function syncHeadingIds(editor: HTMLElement): void {
  const seen = new Map<string, number>();
  editor.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((h) => {
    const label = (h.textContent ?? "").trim();
    if (!label) {
      h.removeAttribute("id");
      return;
    }
    let slug = slugify(label);
    if (!slug) {
      h.removeAttribute("id");
      return;
    }
    const count = seen.get(slug) ?? 0;
    if (count > 0) slug = `${slug}-${count}`;
    seen.set(slug, count + 1);
    if (h.id !== slug) h.id = slug;
  });
}

/** Insère un <a href title>label</a> à la position de déclenchement.
 * Si une plage non-collapsed est fournie, son contenu est remplacé. */
export function insertLink(
  ctx: SlashCtx,
  opts: {
    url: string;
    label: string;
    /** Plage à remplacer (sélection initiale au moment du déclenchement). */
    range?: Range;
  },
): HTMLAnchorElement | null {
  const { editor } = ctx;
  const url = opts.url.trim();
  const label = opts.label.trim() || url;
  if (!url) return null;

  editor.focus();
  const sel = window.getSelection();
  if (!sel) return null;

  // Restaure la plage cible si fournie, sinon utilise la sélection courante.
  if (opts.range) {
    sel.removeAllRanges();
    sel.addRange(opts.range);
  } else if (sel.rangeCount === 0) {
    return null;
  }

  const range = sel.getRangeAt(0);
  range.deleteContents();

  const a = document.createElement("a");
  a.href = url;
  a.title = url;
  a.textContent = label;
  range.insertNode(a);

  const after = document.createRange();
  after.setStartAfter(a);
  after.collapse(true);
  sel.removeAllRanges();
  sel.addRange(after);

  dispatchInput(editor);
  return a;
}

/** Vrai si `src` est une URL distante / data URI (et donc non convertible
 * via `convertFileSrc`). */
export function isRemoteImageSrc(src: string): boolean {
  return /^(https?:|data:|blob:|asset:|http:\/\/asset\.localhost)/i.test(src);
}

/** Pour un `src` markdown (chemin absolu local ou URL distante), renvoie la
 * valeur à utiliser comme `src` DOM dans la webview (asset protocol pour les
 * chemins locaux). */
export function resolveImageSrcForDom(src: string): string {
  if (!src) return src;
  if (isRemoteImageSrc(src)) return src;
  try {
    return convertFileSrc(src);
  } catch {
    return src;
  }
}

/** Insère un <img> à la position du caret (ou remplace la plage fournie).
 * Le `data-src` conserve la forme « markdown » (chemin absolu ou URL) ;
 * `src` est la forme DOM (asset URL pour les locaux). */
export function insertImage(
  ctx: SlashCtx,
  opts: {
    src: string;
    alt: string;
    /** Plage à remplacer (sélection capturée au moment du déclenchement). */
    range?: Range;
  },
): HTMLImageElement | null {
  const { editor } = ctx;
  const src = opts.src.trim();
  if (!src) return null;
  const alt = opts.alt.trim();

  editor.focus();
  const sel = window.getSelection();
  if (!sel) return null;
  if (opts.range) {
    sel.removeAllRanges();
    sel.addRange(opts.range);
  } else if (sel.rangeCount === 0) {
    return null;
  }

  const range = sel.getRangeAt(0);
  range.deleteContents();

  const img = document.createElement("img");
  img.setAttribute("data-src", src);
  img.setAttribute("src", resolveImageSrcForDom(src));
  if (alt) img.setAttribute("alt", alt);
  img.setAttribute("draggable", "false");
  range.insertNode(img);

  const after = document.createRange();
  after.setStartAfter(img);
  after.collapse(true);
  sel.removeAllRanges();
  sel.addRange(after);

  dispatchInput(editor);
  return img;
}

/** Met à jour href/title/label d'un <a> existant. */
export function updateLink(
  editor: HTMLElement,
  anchor: HTMLAnchorElement,
  opts: { url: string; label: string },
): void {
  const url = opts.url.trim();
  const label = opts.label.trim() || url;
  if (!url) return;
  anchor.setAttribute("href", url);
  anchor.setAttribute("title", url);
  anchor.textContent = label;
  dispatchInput(editor);
}

/** Remplace un <a>texte</a> par son contenu textuel (rétrograde en texte normal). */
export function unlinkAnchor(
  editor: HTMLElement,
  anchor: HTMLAnchorElement,
): void {
  const parent = anchor.parentNode;
  if (!parent) return;
  while (anchor.firstChild) parent.insertBefore(anchor.firstChild, anchor);
  parent.removeChild(anchor);
  dispatchInput(editor);
}

function getCurrentListItem(editor: HTMLElement): HTMLLIElement | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const node = sel.getRangeAt(0).startContainer;
  if (!editor.contains(node)) return null;
  const start = node.nodeType === 1 ? (node as Element) : node.parentElement;
  const li = start?.closest("li");
  return li instanceof HTMLLIElement && editor.contains(li) ? li : null;
}

/** Insère un tableau standard avec une ligne d'en-tête + (rows-1) lignes. */
export function insertTable(
  ctx: SlashCtx,
  rows: number,
  cols: number,
) {
  clearTriggerText(ctx.editor, ctx.triggerNode, ctx.triggerOffset);
  const safeRows = Math.max(1, Math.min(50, Math.floor(rows)));
  const safeCols = Math.max(1, Math.min(20, Math.floor(cols)));

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const trh = document.createElement("tr");
  for (let c = 0; c < safeCols; c++) {
    const th = document.createElement("th");
    th.appendChild(document.createTextNode("​"));
    trh.appendChild(th);
  }
  thead.appendChild(trh);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (let r = 1; r < safeRows; r++) {
    const tr = document.createElement("tr");
    for (let c = 0; c < safeCols; c++) {
      const td = document.createElement("td");
      td.appendChild(document.createTextNode("​"));
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  if (!tbody.childNodes.length) {
    const tr = document.createElement("tr");
    for (let c = 0; c < safeCols; c++) {
      const td = document.createElement("td");
      td.appendChild(document.createTextNode("​"));
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  // Même structure que le rendu markdown (render.tsx) : sans ce wrapper, le
  // tableau fraîchement inséré n'a ni cadre ni largeur minimale et s'affiche
  // différemment jusqu'au prochain aller-retour par la source.
  const wrap = document.createElement("div");
  wrap.className = "md-table-wrap";
  wrap.appendChild(table);
  insertNodeAtCaret(wrap);

  const firstTh = table.querySelector("th");
  if (firstTh) {
    const sel = window.getSelection();
    const r = document.createRange();
    r.selectNodeContents(firstTh);
    r.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(r);
  }
  dispatchInput(ctx.editor);
}

/** Cellule de tableau directement sous le caret, ou `null` si le caret n'est
 * pas dans un `<td>`/`<th>` à l'intérieur de l'éditeur. */
export function getCurrentTableCell(
  editor: HTMLElement,
): HTMLTableCellElement | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const node = sel.getRangeAt(0).startContainer;
  if (!editor.contains(node)) return null;
  const start = node.nodeType === 1 ? (node as Element) : node.parentElement;
  if (!start) return null;
  const cell = start.closest("td, th");
  return cell instanceof HTMLTableCellElement ? cell : null;
}

/** Cherche le <table> pertinent depuis le caret : ancêtre direct,
 * ou bloc précédent immédiat (si le caret est juste sous un tableau). */
export function findTableContext(editor: HTMLElement): HTMLTableElement | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const node = sel.getRangeAt(0).startContainer;
  if (!editor.contains(node)) return null;

  const start = node.nodeType === 1 ? (node as Element) : node.parentElement;
  if (!start) return null;
  const ancestor = start.closest("table");
  if (ancestor) return ancestor as HTMLTableElement;

  // Tableau juste au-dessus ?
  let cursor: Element | null = start;
  while (cursor && cursor !== editor) {
    if (cursor.previousElementSibling?.tagName === "TABLE") {
      return cursor.previousElementSibling as HTMLTableElement;
    }
    if (cursor.parentElement === editor) {
      if (cursor.previousElementSibling?.tagName === "TABLE") {
        return cursor.previousElementSibling as HTMLTableElement;
      }
      break;
    }
    cursor = cursor.parentElement;
  }
  return null;
}

/** Ajoute une colonne (cellule vide à la fin) sur chaque ligne du tableau. */
export function addTableColumn(ctx: SlashCtx, table: HTMLTableElement) {
  clearTriggerText(ctx.editor, ctx.triggerNode, ctx.triggerOffset);
  const rows = Array.from(table.querySelectorAll("tr"));
  rows.forEach((tr) => {
    const isHeader = !!tr.closest("thead") || !!tr.querySelector("th");
    const cell = document.createElement(isHeader ? "th" : "td");
    cell.appendChild(document.createTextNode("​"));
    tr.appendChild(cell);
  });
  dispatchInput(ctx.editor);
}

/** Ajoute une ligne au tbody (ou crée un tbody) — manipulation DOM pure,
 * sans nettoyage de trigger slash. Utilisable hors contexte slash (navigation
 * Ctrl+Entrée). Renvoie la ligne créée. */
export function appendTableRow(
  table: HTMLTableElement,
  asHeader: boolean,
): HTMLTableRowElement {
  const colCount = computeColCount(table);

  const tr = document.createElement("tr");
  for (let c = 0; c < colCount; c++) {
    const cell = document.createElement(asHeader ? "th" : "td");
    cell.appendChild(document.createTextNode("​"));
    tr.appendChild(cell);
  }

  if (asHeader) {
    let thead = table.tHead;
    if (!thead) {
      thead = table.createTHead();
      // Repositionne thead avant tbody / autres
      table.insertBefore(thead, table.firstChild);
    }
    thead.appendChild(tr);
  } else {
    let tbody = table.tBodies[0];
    if (!tbody) {
      tbody = document.createElement("tbody");
      table.appendChild(tbody);
    }
    tbody.appendChild(tr);
  }
  return tr;
}

/** Ajoute une ligne au tableau depuis une commande slash : nettoie d'abord le
 * texte `/commande` tapé. NE PAS appeler avec un trigger synthétique
 * (editor, 0) — clearTriggerText supprimerait tout le début du document. */
export function addTableRow(
  ctx: SlashCtx,
  table: HTMLTableElement,
  asHeader: boolean,
) {
  clearTriggerText(ctx.editor, ctx.triggerNode, ctx.triggerOffset);
  appendTableRow(table, asHeader);
  dispatchInput(ctx.editor);
}

function computeColCount(table: HTMLTableElement): number {
  let max = 0;
  table.querySelectorAll("tr").forEach((tr) => {
    if (tr.cells.length > max) max = tr.cells.length;
  });
  return Math.max(1, max);
}

/** Wrapper unique pour les commandes 1:1 toolbar : nettoie le `/query`,
 * focus l'éditeur, exécute, notifie. */
export function runMappedCommand(ctx: SlashCtx, action: ToolbarAction) {
  clearTriggerText(ctx.editor, ctx.triggerNode, ctx.triggerOffset);
  ctx.editor.focus();
  runWysiwygCommand(ctx.editor, action);
  dispatchInput(ctx.editor);
}

/** /liste, /liste1 : convertit le bloc en liste puis place le caret en FIN
 * d'item — execCommand le laisse collé au marqueur, en début de contenu. */
export function runListCommand(ctx: SlashCtx, action: "ul" | "ol") {
  clearTriggerText(ctx.editor, ctx.triggerNode, ctx.triggerOffset);
  ctx.editor.focus();
  document.execCommand(
    action === "ul" ? "insertUnorderedList" : "insertOrderedList",
  );
  const li = getCurrentListItem(ctx.editor);
  if (li) placeCaretAtEndOf(li);
  dispatchInput(ctx.editor);
}

/** Retire tous les effets inline (gras, italique, barré, code, lien…) de la
 * sélection courante. Les blocs (titres, listes) ne sont pas touchés —
 * c'est le rôle de /clear sur le paragraphe. */
export function clearInlineFormat(editor: HTMLElement): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
  if (!editor.contains(sel.getRangeAt(0).commonAncestorContainer)) return;

  document.execCommand("removeFormat");
  document.execCommand("unlink");

  // removeFormat ne déballe pas toujours <code>/<del> : on les retire
  // manuellement s'ils intersectent encore la sélection.
  if (sel.rangeCount > 0) {
    const range = sel.getRangeAt(0);
    editor
      .querySelectorAll<HTMLElement>("code, del, s, strike")
      .forEach((el) => {
        if (el.closest("pre")) return; // blocs de code intacts
        if (!range.intersectsNode(el)) return;
        const parent = el.parentNode;
        if (!parent) return;
        while (el.firstChild) parent.insertBefore(el.firstChild, el);
        parent.removeChild(el);
      });
  }
  dispatchInput(editor);
}

/* ------------------------------------------------------------------ */
/* Mode format « live » (/gras, /italique, /barré)                     */
/* Le texte tapé prend l'effet immédiatement, avec un marqueur visuel ; */
/* Entrée (ou déplacement du caret hors de la zone) sort du mode.       */
/* ------------------------------------------------------------------ */

const LIVE_FORMAT_TAGS = {
  bold: "strong",
  italic: "em",
  strike: "del",
} as const;

export type LiveFormatKind = keyof typeof LIVE_FORMAT_TAGS;

export function startLiveFormat(ctx: SlashCtx, kind: LiveFormatKind) {
  clearTriggerText(ctx.editor, ctx.triggerNode, ctx.triggerOffset);
  ctx.editor.focus();
  const el = document.createElement(LIVE_FORMAT_TAGS[kind]);
  el.className = "fmt-live";
  const zwsp = document.createTextNode("​");
  el.appendChild(zwsp);
  insertNodeAtCaret(el);
  const sel = window.getSelection();
  if (sel) {
    const r = document.createRange();
    r.setStart(zwsp, 1);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }
  dispatchInput(ctx.editor);
}

/** L'élément .fmt-live contenant le caret, ou null. */
export function getActiveLiveFormat(editor: HTMLElement): HTMLElement | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const node = sel.getRangeAt(0).startContainer;
  if (!editor.contains(node)) return null;
  const start = node.nodeType === 1 ? (node as Element) : node.parentElement;
  const live = start?.closest(".fmt-live");
  return live instanceof HTMLElement && editor.contains(live) ? live : null;
}

/** Sort du mode live : retire le marqueur visuel et les ZWSP placeholder ;
 * supprime l'élément s'il est resté vide. Si `placeCaretAfter`, le caret
 * ressort juste après l'élément (sur un ZWSP neutre, pour que la frappe
 * suivante n'hérite pas du format). */
export function commitLiveFormat(
  editor: HTMLElement,
  live: HTMLElement,
  placeCaretAfter: boolean,
): void {
  live.classList.remove("fmt-live");
  if (!live.getAttribute("class")) live.removeAttribute("class");

  const walker = document.createTreeWalker(live, NodeFilter.SHOW_TEXT);
  const empties: Text[] = [];
  while (walker.nextNode()) {
    const t = walker.currentNode as Text;
    if (t.data.includes("​")) t.data = t.data.replace(/​/g, "");
    if (!t.data.length) empties.push(t);
  }
  empties.forEach((t) => t.remove());

  const isEmpty = !(live.textContent || "").length;
  const parent = live.parentNode;
  if ((placeCaretAfter || isEmpty) && parent) {
    const sel = window.getSelection();
    if (sel) {
      const after = document.createTextNode("​");
      parent.insertBefore(after, live.nextSibling);
      const r = document.createRange();
      r.setStart(after, 1);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    }
  }
  if (isEmpty) live.remove();
  dispatchInput(editor);
}

/** Échappe : ramène la « ligne » courante à un paragraphe normal et la sort
 * de tout conteneur (blockquote, ul, ol, etc.). Utile quand on est coincé
 * dans une citation ou un titre et qu'on veut repartir basique sans
 * passer par la source. */
export function clearBlockFormat(ctx: SlashCtx) {
  clearTriggerText(ctx.editor, ctx.triggerNode, ctx.triggerOffset);
  ctx.editor.focus();

  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) {
    dispatchInput(ctx.editor);
    return;
  }

  // Retire les formatages inline (gras, italique, etc.) sur la sélection.
  document.execCommand("removeFormat");

  if (!sel.rangeCount) {
    dispatchInput(ctx.editor);
    return;
  }
  const caretNode = sel.getRangeAt(0).startContainer;
  if (!ctx.editor.contains(caretNode)) {
    dispatchInput(ctx.editor);
    return;
  }

  // Cherche la « ligne » : le plus proche élément paragraphe-like (P, LI,
  // H1-6, DIV, BLOCKQUOTE en dernier recours). S'il n'y a aucun bloc
  // intermédiaire entre caret et éditeur, on crée un <p> qui enveloppe le
  // contenu de l'ancêtre direct (le wrapper de plus haut niveau).
  let line = findLineBlock(caretNode, ctx.editor);
  if (!line) {
    // Aucun bloc trouvé : enrobe le contenu du parent direct (top-block)
    // dans un <p>, puis utilise-le comme ligne.
    const top = findTopChild(caretNode, ctx.editor);
    if (!top) {
      dispatchInput(ctx.editor);
      return;
    }
    const wrap = document.createElement("p");
    while (top.firstChild) wrap.appendChild(top.firstChild);
    top.appendChild(wrap);
    line = wrap;
  }

  // Convertit la ligne en <p> simple (perd la sémantique LI/H1-6).
  // On le fait avant les splits parce que `replaceWithTag` retourne le
  // nouvel élément avec exactement le même contenu (donc l'offset reste OK).
  const caretOffset = getRelativeCaretOffset(line);
  let current = line;
  if (current.tagName !== "P") {
    current = replaceWithTag(current, "p");
  }

  // Itère : tant que `current` n'est pas un enfant direct de l'éditeur,
  // sort-le de son parent (split autour). Cela traite blockquote, ul, ol,
  // div imbriqués, etc.
  let safety = 32;
  while (
    current.parentElement &&
    current.parentElement !== ctx.editor &&
    safety-- > 0
  ) {
    splitParentAround(current);
  }

  setCaretAtOffset(current, caretOffset);
  dispatchInput(ctx.editor);
}

function findLineBlock(start: Node, editor: HTMLElement): HTMLElement | null {
  let el: Node | null = start;
  while (el && el !== editor) {
    if (el.nodeType === 1) {
      const tag = (el as Element).tagName;
      if (/^(P|LI|H[1-6]|PRE)$/.test(tag)) return el as HTMLElement;
    }
    el = el.parentNode;
  }
  return null;
}

function findTopChild(start: Node, editor: HTMLElement): HTMLElement | null {
  let el: Node | null = start;
  while (el && el.parentNode !== editor) {
    if (!el.parentNode) return null;
    el = el.parentNode;
  }
  return el && el.nodeType === 1 ? (el as HTMLElement) : null;
}

function replaceWithTag(el: HTMLElement, tag: string): HTMLElement {
  const nu = document.createElement(tag);
  while (el.firstChild) nu.appendChild(el.firstChild);
  el.parentElement?.replaceChild(nu, el);
  return nu;
}

/** Sort `child` de son parent en split­tant le parent autour : tout ce qui
 * était avant `child` reste dans `parent`, tout ce qui était après part dans
 * un clone vide de `parent`, et `child` se place entre les deux dans le
 * grand-parent. Si `parent` devient vide il est retiré. */
function splitParentAround(child: HTMLElement) {
  const parent = child.parentElement;
  if (!parent) return;
  const grand = parent.parentElement;
  if (!grand) return;

  const after = parent.cloneNode(false) as HTMLElement;
  let next = child.nextSibling;
  while (next) {
    const cur = next;
    next = next.nextSibling;
    after.appendChild(cur);
  }

  grand.insertBefore(child, parent.nextSibling);
  if (after.childNodes.length) {
    grand.insertBefore(after, child.nextSibling);
  }
  if (!parent.childNodes.length) {
    parent.remove();
  }
}

function getRelativeCaretOffset(block: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return 0;
  const r = sel.getRangeAt(0);
  if (!block.contains(r.endContainer)) return 0;
  const pre = document.createRange();
  pre.selectNodeContents(block);
  try {
    pre.setEnd(r.endContainer, r.endOffset);
  } catch {
    return 0;
  }
  return pre.toString().length;
}

function setCaretAtOffset(block: HTMLElement, offset: number) {
  const sel = window.getSelection();
  if (!sel) return;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let target: Text | null = null;
  let targetOffset = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const len = node.data.length;
    if (remaining <= len) {
      target = node;
      targetOffset = remaining;
      break;
    }
    remaining -= len;
  }
  const range = document.createRange();
  if (target) {
    range.setStart(target, targetOffset);
  } else {
    range.selectNodeContents(block);
    range.collapse(false);
  }
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}
