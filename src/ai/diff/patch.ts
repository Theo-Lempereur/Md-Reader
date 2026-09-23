import type { AiPatch } from "../types";
import { canonical, computeHunks, hashContent } from "./diff";

export function createPatch(
  tabId: string,
  baseContent: string,
  nextContent: string,
  label: string,
): AiPatch {
  const base = canonical(baseContent);
  const next = canonical(nextContent);
  return {
    id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    tabId,
    baseHash: hashContent(base),
    baseContent: base,
    nextContent: next,
    label,
    hunks: computeHunks(base, next),
    createdAt: Date.now(),
    state: "review",
  };
}

/** Extrait le markdown d'une réponse « document complet » : retire un
 * éventuel bloc de code englobant et le blabla d'introduction. */
export function extractDocument(answer: string): string {
  const trimmed = answer.trim();
  const fence = /^(`{3,}|~{3,})[ \t]*(?:markdown|md)?[ \t]*\n([\s\S]*?)\n\1[ \t]*$/i.exec(trimmed);
  if (fence) return fence[2] + "\n";
  // Réponse du type « Voici le document : ```markdown … ``` ».
  const inner = /(`{3,}|~{3,})[ \t]*(?:markdown|md)[ \t]*\n([\s\S]*?)\n\1/i.exec(trimmed);
  if (inner && inner[2].length > trimmed.length * 0.5) return inner[2] + "\n";
  return trimmed + "\n";
}
