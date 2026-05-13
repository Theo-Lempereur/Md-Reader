import TurndownService from "turndown";

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

export function htmlToMarkdown(html: string): string {
  return td.turndown(html).trim() + "\n";
}
