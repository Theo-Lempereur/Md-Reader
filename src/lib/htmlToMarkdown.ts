import TurndownService from "turndown";
import { normalizeMarkdown } from "../markdown/normalize";

const td = new TurndownService({
  bulletListMarker: "-",
  emDelimiter: "*",
  strongDelimiter: "**",
  codeBlockStyle: "fenced",
  linkStyle: "inlined",
  headingStyle: "atx",
});

// Strikethrough (turndown ne le supporte pas par défaut).
td.addRule("strikethrough", {
  filter: ["del", "s", "strike"] as unknown as (keyof HTMLElementTagNameMap)[],
  replacement: (content) => `~~${content}~~`,
});

td.addRule("math", {
  filter: (node) =>
    node.nodeType === 1 &&
    (node as HTMLElement).hasAttribute("data-tex") &&
    ((node as HTMLElement).classList.contains("math-inline") ||
      (node as HTMLElement).classList.contains("math-block")),
  replacement: (_content, node) => {
    const el = node as HTMLElement;
    const tex = el.getAttribute("data-tex") ?? "";
    const display = el.getAttribute("data-display") === "true";
    return display ? `\n\n$$\n${tex}\n$$\n\n` : `$${tex}$`;
  },
});

td.addRule("horizontalRule", {
  filter: "hr",
  replacement: () => "\n\n---\n\n",
});

// Tâches : <li><input type="checkbox" checked> texte</li> → "- [x] texte"
td.addRule("taskListItem", {
  filter: (node) => {
    if (node.nodeName !== "LI") return false;
    const first = node.firstElementChild as HTMLInputElement | null;
    return !!first && first.tagName === "INPUT" && first.type === "checkbox";
  },
  replacement: (_content, node) => {
    const li = node as HTMLElement;
    const cb = li.querySelector("input[type=checkbox]") as HTMLInputElement | null;
    const checked = cb?.checked ? "x" : " ";
    // On retire le checkbox du contenu interne pour ne pas le re-imprimer
    const clone = li.cloneNode(true) as HTMLElement;
    clone.querySelector("input[type=checkbox]")?.remove();
    const inner = td.turndown(clone.innerHTML).trim();
    return `- [${checked}] ${inner}\n`;
  },
});

td.addRule("table", {
  filter: "table",
  replacement: (_content, node) => {
    const table = node as HTMLTableElement;
    const allRows = Array.from(table.querySelectorAll("tr"));
    if (!allRows.length) return "";

    const headerRow = table.tHead?.rows[0] ?? allRows[0];
    const headerCells = Array.from(headerRow.cells);
    const bodyRows = table.tBodies.length
      ? Array.from(table.tBodies).flatMap((body) => Array.from(body.rows))
      : allRows.slice(headerRow === allRows[0] ? 1 : 0);

    const rows = bodyRows.map((row) => Array.from(row.cells));
    const colCount = Math.max(
      headerCells.length,
      ...rows.map((row) => row.length),
      1,
    );
    const headers = normalizeCells(headerCells.map(markdownCell), colCount);
    const aligns = normalizeCells(headerCells.map(cellAlignment), colCount);
    const separator = aligns.map((align) => {
      if (align === "center") return ":---:";
      if (align === "right") return "---:";
      if (align === "left") return ":---";
      return "---";
    });
    const body = rows.map((row) =>
      normalizeCells(row.map(markdownCell), colCount),
    );

    return `\n\n${[headers, separator, ...body]
      .map((row) => `| ${row.join(" | ")} |`)
      .join("\n")}\n\n`;
  },
});

function markdownCell(cell: HTMLTableCellElement): string {
  return td
    .turndown(cell.innerHTML)
    .replace(/\n+/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

function cellAlignment(cell: HTMLTableCellElement): string {
  const dataAlign = cell.getAttribute("data-align");
  if (dataAlign === "left" || dataAlign === "center" || dataAlign === "right") {
    return dataAlign;
  }

  const styleAlign = cell.style.textAlign;
  return styleAlign === "left" || styleAlign === "center" || styleAlign === "right"
    ? styleAlign
    : "";
}

function normalizeCells<T>(cells: T[], colCount: number): T[] {
  return cells.length >= colCount
    ? cells.slice(0, colCount)
    : [...cells, ...Array.from({ length: colCount - cells.length }, () => "" as T)];
}

export function htmlToMarkdown(html: string): string {
  return normalizeMarkdown(td.turndown(html)).trim() + "\n";
}
