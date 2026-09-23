import type { QuickActionKind } from "./types";

export const QUICK_ACTIONS: { kind: QuickActionKind; label: string; instruction: string }[] = [
  {
    kind: "rephrase",
    label: "Reformuler",
    instruction:
      "Reformule l'extrait avec des mots différents, en gardant exactement le même sens, le même ton et la même langue.",
  },
  {
    kind: "fix",
    label: "Corriger",
    instruction:
      "Corrige l'orthographe, la grammaire, la ponctuation et la typographie de l'extrait. Ne change ni le style ni le sens.",
  },
  {
    kind: "shorten",
    label: "Raccourcir",
    instruction:
      "Raccourcis l'extrait d'environ la moitié en gardant les informations essentielles, le ton et la langue.",
  },
  {
    kind: "translate",
    label: "Traduire",
    instruction:
      "Traduis l'extrait : en anglais s'il est en français, sinon en français. Garde la mise en forme Markdown.",
  },
  {
    kind: "continue",
    label: "Continuer",
    instruction:
      "Écris la suite directe de l'extrait (un à trois paragraphes), dans le même style et la même langue. Ne répète pas l'extrait.",
  },
];

export const QUICK_SYSTEM = `Tu es l'assistant d'écriture de Md-Reader.
Tu réponds UNIQUEMENT avec le texte demandé, en Markdown, sans guillemets, sans introduction ni commentaire, sans bloc de code englobant.`;

export function quickPrompt(kind: QuickActionKind, excerpt: string): string {
  const action = QUICK_ACTIONS.find((a) => a.kind === kind)!;
  return `Consigne : ${action.instruction}\n\nExtrait :\n${excerpt}`;
}

export function continuePrompt(before: string, after: string): string {
  return `Écris la suite du texte à l'endroit marqué ⟦ICI⟧ : un à trois paragraphes cohérents avec ce qui précède et ce qui suit, dans le même style et la même langue. Réponds uniquement avec le texte à insérer.

${before}⟦ICI⟧${after}`;
}

export const SUMMARY_PROMPT =
  "Rédige un résumé du document en 3 à 6 puces Markdown, sans titre ni introduction. Réponds uniquement avec les puces.";

export const COMPLETE_SYSTEM = `Tu complètes le texte de l'utilisateur dans un éditeur Markdown.
Réponds UNIQUEMENT par la suite immédiate du texte à l'endroit du curseur (de quelques mots à une phrase), sans répéter ce qui précède, sans guillemets ni commentaire.`;

export function completePrompt(before: string, after: string): string {
  return `<avant>${before}</avant><apres>${after}</apres>\nSuite immédiate après <avant> :`;
}

/** Nettoie une réponse courte : bloc de code englobant, guillemets. */
export function cleanSnippet(answer: string): string {
  let t = answer.trim();
  const fence = /^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\1$/.exec(t);
  if (fence) t = fence[2].trim();
  if (/^[«"“].*[»"”]$/s.test(t) && t.length > 2) t = t.slice(1, -1).trim();
  return t;
}
