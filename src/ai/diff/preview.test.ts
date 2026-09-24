import { describe, expect, it } from "vitest";
import { canonical, computeHunks } from "./diff";
import {
  buildPreview,
  DEL_END,
  DEL_START,
  INS_END,
  INS_START,
  mergeBlock,
  mergeText,
  type PvBlock,
} from "./preview";

/** Rend les sentinelles lisibles : [-supprimé-] {+ajouté+}. */
const show = (s: string | null) =>
  s == null
    ? null
    : s
        .split(DEL_START).join("[-")
        .split(DEL_END).join("-]")
        .split(INS_START).join("{+")
        .split(INS_END).join("+}");

const block = (kind: string, source: string): PvBlock => ({
  kind,
  source,
  lineStart: 0,
  lineEnd: source.split("\n").length - 1,
});

function preview(base: string, next: string) {
  const b = canonical(base);
  const n = canonical(next);
  const hunks = computeHunks(b, n);
  return { hunks, cards: buildPreview(b, n, hunks) };
}

describe("mergeText", () => {
  it("balise les mots remplacés", () => {
    expect(show(mergeText("Le chat dort ici.", "Le chien dort ici."))).toBe(
      "Le [-chat-]{+chien+} dort ici.",
    );
  });

  it("regroupe les changements voisins en un seul passage", () => {
    expect(show(mergeText("un deux trois quatre cinq six", "un a b c cinq six"))).toBe(
      "un [-deux trois quatre-]{+a b c+} cinq six",
    );
  });

  it("refuse de baliser un changement de syntaxe markdown", () => {
    expect(mergeText("un mot important ici", "un **mot** important ici")).toBeNull();
  });

  it("refuse deux textes trop différents", () => {
    expect(mergeText("Bonjour à tous", "Il pleut depuis mardi")).toBeNull();
  });
});

describe("mergeBlock", () => {
  it("ajoute un élément de liste sans toucher aux puces", () => {
    const merged = mergeBlock(block("liste", "- pommes\n- poires"), block("liste", "- pommes\n- poires\n- kiwis"));
    expect(show(merged)).toBe("- pommes\n- poires\n- {+kiwis+}");
  });

  it("ignore la renumérotation d'une liste numérotée", () => {
    const merged = mergeBlock(
      block("liste numérotée", "1. a\n2. c"),
      block("liste numérotée", "1. a\n2. b\n3. c"),
    );
    expect(show(merged)).toBe("1. a\n2. {+b+}\n3. c");
  });

  it("fusionne les cellules modifiées d'un tableau", () => {
    const merged = mergeBlock(
      block("tableau", "| Nom | Prix |\n| --- | --- |\n| Café | 2 euros |"),
      block("tableau", "| Nom | Prix |\n| --- | --- |\n| Café | 3 euros |"),
    );
    expect(show(merged)).toBe("| Nom | Prix |\n| --- | --- |\n| Café | [-2-]{+3+} euros |");
  });

  it("montre en entier un titre dont le niveau change", () => {
    expect(mergeBlock(block("titre H2", "## Plan"), block("titre H3", "### Plan"))).toBeNull();
  });

  it("ne fusionne pas les blocs de code", () => {
    expect(mergeBlock(block("code", "```\na\n```"), block("code", "```\nb\n```"))).toBeNull();
  });
});

describe("buildPreview", () => {
  it("produit une carte « edit » pour un paragraphe reformulé", () => {
    const { hunks, cards } = preview(
      "# Titre\n\nLe chat dort sur le canapé.\n\nFin.\n",
      "# Titre\n\nLe chat dort sur le tapis.\n\nFin.\n",
    );
    expect(cards).toHaveLength(1);
    expect(cards[0].hunkIds).toEqual(hunks.map((h) => h.id));
    expect(cards[0].items).toHaveLength(1);
    const item = cards[0].items[0];
    expect(item.type).toBe("edit");
    if (item.type === "edit") {
      expect(show(item.merged)).toBe("Le chat dort sur le [-canapé-]{+tapis+}.");
    }
    expect(cards[0].revealLine).toBe(2);
  });

  it("distingue blocs ajoutés et supprimés", () => {
    const { cards } = preview(
      "Intro.\n\nParagraphe à retirer entièrement.\n\nFin.\n",
      "Intro.\n\n## Nouvelle section\n\nFin.\n",
    );
    expect(cards).toHaveLength(1);
    expect(cards[0].items.map((i) => i.type)).toEqual(["del", "add"]);
  });

  it("une carte par zone de changement éloignée", () => {
    const paras = Array.from({ length: 12 }, (_, i) => `Paragraphe numéro ${i + 1} du texte.`);
    const next = [...paras];
    next[1] = "Paragraphe numéro 2 du texte, reformulé.";
    next[10] = "Paragraphe numéro 11 du texte, lui aussi.";
    const { hunks, cards } = preview(paras.join("\n\n"), next.join("\n\n"));
    expect(hunks).toHaveLength(2);
    expect(cards).toHaveLength(2);
    expect(cards.map((c) => c.hunkIds)).toEqual(hunks.map((h) => [h.id]));
  });

  it("garde une carte vide pour un changement de lignes vides", () => {
    const { hunks, cards } = preview("A.\n\nB.\n", "A.\n\n\nB.\n");
    expect(hunks).toHaveLength(1);
    expect(cards).toHaveLength(1);
    expect(cards[0].items).toEqual([]);
  });

  it("rattache une fusion de paragraphes (ligne vide supprimée)", () => {
    const { hunks, cards } = preview("Un.\n\nDeux.\n", "Un.\nDeux.\n");
    expect(cards).toHaveLength(1);
    expect(cards[0].hunkIds).toEqual(hunks.map((h) => h.id));
    expect(cards[0].items.length).toBeGreaterThan(0);
  });
});
