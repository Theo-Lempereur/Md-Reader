import type { ToolbarAction } from "../components/Toolbar";

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

function dispatchInput(editor: HTMLElement) {
  editor.dispatchEvent(new Event("input", { bubbles: true }));
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
    case "link": {
      const url = window.prompt("URL ?");
      if (url) document.execCommand("createLink", false, url);
      return;
    }
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

  insertNodeAtCaret(table);

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

/** Ajoute une ligne au tbody (ou crée un tbody). */
export function addTableRow(
  ctx: SlashCtx,
  table: HTMLTableElement,
  asHeader: boolean,
) {
  clearTriggerText(ctx.editor, ctx.triggerNode, ctx.triggerOffset);
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
