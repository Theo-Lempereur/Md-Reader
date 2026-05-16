import type { ToolbarAction } from "../components/Toolbar";
import {
  addTableColumn,
  addTableRow,
  clearBlockFormat,
  findTableContext,
  insertCodeFence,
  runMappedCommand,
  type SlashCtx,
} from "./runners";

export type SlashGroup = "format" | "block" | "table" | "math";

export type SlashCommand = {
  id: string;
  /** Alias de saisie (sans le `/`). Le premier sert d'affichage si `label` absent. */
  names: string[];
  label: string;
  hint?: string;
  group: SlashGroup;
  /** Action standard : exécutée à la validation. */
  run?: (ctx: SlashCtx) => void;
  /** Si défini, la validation déclenche un sous-mode dans le popup au lieu
   * d'exécuter immédiatement. Le composant SlashMenu gère ces modes. */
  needsForm?: "table";
  /** Activable seulement dans certains contextes (vérifié par `isEnabled`). */
  isEnabled?: (editor: HTMLElement) => boolean;
};

function mapped(action: ToolbarAction) {
  return (ctx: SlashCtx) => runMappedCommand(ctx, action);
}

export const SLASH_COMMANDS: SlashCommand[] = [
  // ---------------- Titres ----------------
  {
    id: "h1",
    names: ["titre1", "title1", "h1", "titre"],
    label: "Titre 1",
    hint: "# ",
    group: "block",
    run: mapped("h1"),
  },
  {
    id: "h2",
    names: ["titre2", "title2", "h2"],
    label: "Titre 2",
    hint: "## ",
    group: "block",
    run: mapped("h2"),
  },
  {
    id: "h3",
    names: ["titre3", "title3", "h3"],
    label: "Titre 3",
    hint: "### ",
    group: "block",
    run: mapped("h3"),
  },

  // ---------------- Format inline ----------------
  {
    id: "bold",
    names: ["gras", "bold", "b"],
    label: "Gras",
    hint: "**…**",
    group: "format",
    run: mapped("bold"),
  },
  {
    id: "italic",
    names: ["italique", "italic", "i", "em"],
    label: "Italique",
    hint: "*…*",
    group: "format",
    run: mapped("italic"),
  },
  {
    id: "strike",
    names: ["barre", "barré", "strike", "strikethrough"],
    label: "Barré",
    hint: "~~…~~",
    group: "format",
    run: mapped("strike"),
  },
  {
    id: "inline-code",
    names: ["inline", "monospace", "tt"],
    label: "Code inline",
    hint: "`…`",
    group: "format",
    run: mapped("code"),
  },
  {
    id: "link",
    names: ["lien", "link", "url"],
    label: "Lien",
    hint: "[…](url)",
    group: "format",
    run: mapped("link"),
  },

  // ---------------- Blocs ----------------
  {
    id: "quote",
    names: ["citation", "quote", "cite"],
    label: "Citation",
    hint: "> ",
    group: "block",
    run: mapped("quote"),
  },
  {
    id: "ul",
    names: ["list", "liste", "puce", "ul"],
    label: "Liste à puces",
    hint: "- ",
    group: "block",
    run: mapped("ul"),
  },
  {
    id: "ol",
    names: ["list1", "liste1", "ordered", "ol", "numerote"],
    label: "Liste numérotée",
    hint: "1. ",
    group: "block",
    run: mapped("ol"),
  },
  {
    id: "code-block",
    names: ["code", "codeblock", "bloc", "block", "fence"],
    label: "Bloc de code",
    hint: "``` ```",
    group: "block",
    run: insertCodeFence,
  },
  {
    id: "clear",
    names: ["clear", "basique", "reset", "clean", "vide", "plain", "normal"],
    label: "Paragraphe basique",
    hint: "retire titre / liste / format",
    group: "block",
    run: clearBlockFormat,
  },

  // ---------------- Tableau ----------------
  {
    id: "table",
    names: ["table", "tableau"],
    label: "Tableau…",
    hint: "lignes × colonnes",
    group: "table",
    needsForm: "table",
  },
  {
    id: "column",
    names: ["colonne", "column", "col"],
    label: "Ajouter une colonne",
    hint: "+ colonne au tableau",
    group: "table",
    isEnabled: (editor) => !!findTableContext(editor),
    run: (ctx) => {
      const table = findTableContext(ctx.editor);
      if (table) addTableColumn(ctx, table);
    },
  },
  {
    id: "row",
    names: ["ligne", "line", "row"],
    label: "Ajouter une ligne",
    hint: "+ ligne au tableau",
    group: "table",
    isEnabled: (editor) => !!findTableContext(editor),
    run: (ctx) => {
      const table = findTableContext(ctx.editor);
      if (table) addTableRow(ctx, table, false);
    },
  },
  {
    id: "row-header",
    names: ["lignet", "linet", "rowt", "entete", "header"],
    label: "Ajouter une ligne d'en-tête",
    hint: "+ ligne <th> au tableau",
    group: "table",
    isEnabled: (editor) => !!findTableContext(editor),
    run: (ctx) => {
      const table = findTableContext(ctx.editor);
      if (table) addTableRow(ctx, table, true);
    },
  },
];

const COMBINING_MARKS = /[̀-ͯ]/g;
const stripDiacritics = (s: string): string =>
  s.normalize("NFD").replace(COMBINING_MARKS, "").toLowerCase();

export function matchCommands(
  query: string,
  registry: SlashCommand[] = SLASH_COMMANDS,
): SlashCommand[] {
  const q = stripDiacritics(query.trim());
  if (!q) return registry;
  const starts: SlashCommand[] = [];
  const contains: SlashCommand[] = [];
  for (const cmd of registry) {
    let kind: "start" | "contain" | "none" = "none";
    for (const name of cmd.names) {
      const n = stripDiacritics(name);
      if (n.startsWith(q)) {
        kind = "start";
        break;
      }
      if (kind === "none" && n.includes(q)) {
        kind = "contain";
      }
    }
    if (kind === "start") starts.push(cmd);
    else if (kind === "contain") contains.push(cmd);
  }
  return [...starts, ...contains];
}
