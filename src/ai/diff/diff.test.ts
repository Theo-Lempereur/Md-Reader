import { describe, expect, it } from "vitest";
import { canonical, computeHunks, hashContent, hunkStats } from "./diff";
import {
  applyHunks,
  applyPatch,
  obsoleteHunkIds,
  reanchorHunks,
  revertChange,
} from "./apply";
import { createPatch, extractDocument } from "./patch";

const lines = (n: number, prefix = "ligne") =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`);
const doc = (ls: string[]) => ls.join("\n") + "\n";

/** Document de 40 lignes et une version modifiée en trois endroits éloignés. */
function threeChanges() {
  const base = lines(40);
  const next = [...base];
  next[2] = "ligne 3 reformulée";
  next.splice(20, 1); // suppression de « ligne 21 »
  next.splice(34, 0, "nouvelle ligne"); // insertion vers la fin
  return { base: doc(base), next: doc(next) };
}

describe("computeHunks", () => {
  it("ne produit rien quand le texte est identique", () => {
    expect(computeHunks("a\nb\n", "a\nb\n")).toEqual([]);
  });

  it("regroupe les changements éloignés en hunks distincts avec 3 lignes de contexte", () => {
    const { base, next } = threeChanges();
    const hunks = computeHunks(base, next);
    expect(hunks).toHaveLength(3);
    const first = hunks[0];
    expect(first.oldStart).toBe(0);
    expect(first.lines.filter((l) => l.kind === "ctx").length).toBeGreaterThanOrEqual(3);
    expect(hunkStats(hunks)).toEqual({ added: 2, removed: 2 });
  });

  it("fusionne les changements proches", () => {
    const base = lines(10);
    const next = [...base];
    next[2] = "x";
    next[5] = "y";
    expect(computeHunks(doc(base), doc(next))).toHaveLength(1);
  });

  it("raffine mot à mot à l'intérieur d'un hunk", () => {
    const [h] = computeHunks("Le chat dort.\n", "Le chien dort.\n");
    const del = h.lines.find((l) => l.kind === "del")!;
    const add = h.lines.find((l) => l.kind === "add")!;
    expect(del.words?.filter((w) => w.changed).map((w) => w.text)).toEqual(["chat"]);
    expect(add.words?.filter((w) => w.changed).map((w) => w.text)).toEqual(["chien"]);
  });

  it("tolère l'absence de saut de ligne final et les CRLF", () => {
    const hunks = computeHunks("a\r\nb", "a\nc\n");
    expect(hunkStats(hunks)).toEqual({ added: 1, removed: 1 });
  });
});

describe("applyHunks", () => {
  it("tout accepter redonne le texte proposé, tout refuser la base", () => {
    const { base, next } = threeChanges();
    const hunks = computeHunks(base, next);
    expect(applyHunks(base, hunks, new Set(hunks.map((h) => h.id)))).toBe(next);
    expect(applyHunks(base, hunks, new Set())).toBe(base);
  });

  it("accepte deux hunks sur trois", () => {
    const { base, next } = threeChanges();
    const hunks = computeHunks(base, next);
    const out = applyHunks(base, hunks, new Set([hunks[0].id, hunks[2].id]));
    expect(out).toContain("ligne 3 reformulée");
    expect(out).toContain("ligne 21\n"); // suppression refusée
    expect(out).toContain("nouvelle ligne");
  });

  it("gère le document vide", () => {
    const hunks = computeHunks("", "# Titre\n\nTexte\n");
    expect(applyHunks("", hunks, new Set(hunks.map((h) => h.id)))).toBe("# Titre\n\nTexte\n");
  });
});

describe("désynchronisation", () => {
  it("ré-ancre les hunks quand l'utilisateur a tapé ailleurs", () => {
    const { base, next } = threeChanges();
    const patch = createPatch("t", base, next, "test");
    patch.hunks.forEach((h) => (h.status = "accepted"));
    // L'utilisateur a ajouté deux lignes en tête pendant la génération.
    const current = "Préambule\n\n" + base;
    expect(obsoleteHunkIds(patch, current).size).toBe(0);
    const res = applyPatch(patch, current);
    expect(res.obsolete).toEqual([]);
    expect(res.content).toBe("Préambule\n\n" + next);
  });

  it("marque obsolète un hunk dont la zone a été modifiée, sans l'appliquer", () => {
    const { base, next } = threeChanges();
    const patch = createPatch("t", base, next, "test");
    patch.hunks.forEach((h) => (h.status = "accepted"));
    const current = base.replace("ligne 3\n", "ligne 3 éditée à la main\n");
    const res = applyPatch(patch, current);
    expect(res.obsolete).toEqual([patch.hunks[0].id]);
    expect(res.content).toContain("ligne 3 éditée à la main");
    expect(res.content).not.toContain("ligne 3 reformulée");
    expect(res.content).toContain("nouvelle ligne");
  });

  it("choisit l'occurrence la plus proche quand le contexte est répété", () => {
    const base = doc(["x", "x", "x", "a", "x", "x", "x", "", "x", "x", "x", "a", "x", "x", "x"]);
    const next = base.replace(/a\n(x\nx\nx\n)$/, "b\n$1");
    const hunks = computeHunks(base, next);
    const res = reanchorHunks("début\n" + base, hunks);
    expect(res.obsolete).toEqual([]);
    expect(res.content).toBe("début\n" + next);
  });
});

describe("historique", () => {
  it("annule exactement quand rien n'a bougé depuis", () => {
    const { base, next } = threeChanges();
    expect(revertChange(base, next, next)).toEqual({ content: base, complete: true });
  });

  it("annule par patch inverse après d'autres modifications", () => {
    const { base, next } = threeChanges();
    const current = next + "Ajout ultérieur\n";
    const res = revertChange(base, next, current);
    expect(res.complete).toBe(true);
    expect(res.content).toBe(base + "Ajout ultérieur\n");
  });
});

describe("utilitaires", () => {
  it("l'empreinte change avec le contenu", () => {
    expect(hashContent("a")).not.toBe(hashContent("b"));
    expect(hashContent(canonical("a"))).toBe(hashContent("a\n"));
  });

  it("extrait le document d'une réponse englobée dans un bloc de code", () => {
    expect(extractDocument("```markdown\n# T\n\nx\n```")).toBe("# T\n\nx\n");
    expect(extractDocument("# T\n\nx")).toBe("# T\n\nx\n");
    expect(extractDocument("Voici :\n\n```md\n# Titre long\n\nparagraphe\n```")).toBe(
      "# Titre long\n\nparagraphe\n",
    );
  });
});
