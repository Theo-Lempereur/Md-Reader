/** Assemble le contexte envoyé au modèle à partir des pastilles du plateau.
 * Rien n'est tronqué en silence : si le total dépasse la fenêtre du modèle,
 * les pièces les plus volumineuses sont coupées avec un marqueur visible, et
 * un résumé de la troncature est affiché sous le message. */

import type { AiBridge, ContextItem, WireImage } from "../types";
import { estimateTokens, formatTokens } from "./tokens";

export const CHAT_SYSTEM = `Tu es l'assistant d'écriture intégré à Md-Reader, un éditeur Markdown.
Réponds dans la langue de l'utilisateur, en Markdown.
Quand tu proposes un passage à insérer ou un document réécrit, place-le dans un bloc \`\`\`markdown.`;

export const EDIT_SYSTEM = `Tu modifies le document Markdown fourni selon la demande de l'utilisateur.
Réponds UNIQUEMENT avec le document complet modifié, en Markdown brut : aucun commentaire, aucune introduction, aucun bloc de code englobant.
Conserve à l'identique tout ce que la demande ne concerne pas (mise en forme, liens, images, formules, tableaux).`;

type Piece = { label: string; open: string; close: string; text: string; cut: number };

export type BuiltContext = {
  system: string;
  images: WireImage[];
  /** « Document · Sélection · 2 fichiers » */
  label: string;
  /** Contenu du document actif (pour le mode édition). */
  documentName?: string;
  documentContent?: string;
  estimatedTokens: number;
  truncation?: string;
};

const escapeAttr = (s: string) => s.replace(/"/g, "'");

function piecesFor(
  items: ContextItem[],
  bridge: AiBridge,
  opts: { excludeActiveDocument: boolean },
): { pieces: Piece[]; images: WireImage[]; labels: string[]; docName?: string; docContent?: string } {
  const pieces: Piece[] = [];
  const images: WireImage[] = [];
  const labels: string[] = [];
  const tabs = bridge.getTabs();
  let docName: string | undefined;
  let docContent: string | undefined;
  let fileCount = 0;

  for (const item of items) {
    switch (item.kind) {
      case "document": {
        const tab = tabs.find((t) => t.id === item.tabId);
        const md = bridge.getTabMarkdown(item.tabId);
        if (!tab || md == null) break;
        docName = tab.name;
        docContent = md;
        labels.push(`« ${tab.name} »`);
        if (opts.excludeActiveDocument) break;
        pieces.push({
          label: `document « ${tab.name} »`,
          open: `<document nom="${escapeAttr(tab.name)}" statut="document ouvert par l'utilisateur">`,
          close: "</document>",
          text: md,
          cut: 0,
        });
        break;
      }
      case "selection":
        labels.push("Sélection");
        pieces.push({
          label: "sélection",
          open: "<selection>",
          close: "</selection>",
          text: item.markdown,
          cut: 0,
        });
        break;
      case "tab": {
        const md = bridge.getTabMarkdown(item.tabId);
        if (md == null) break;
        labels.push(item.name);
        pieces.push({
          label: `onglet « ${item.name} »`,
          open: `<onglet nom="${escapeAttr(item.name)}">`,
          close: "</onglet>",
          text: md,
          cut: 0,
        });
        break;
      }
      case "files":
        fileCount += item.files.length;
        for (const f of item.files) {
          const path = item.folder ? `${item.name}/${f.path}` : f.path;
          pieces.push({
            label: `fichier « ${path} »`,
            open: `<fichier chemin="${escapeAttr(path)}">`,
            close: "</fichier>",
            text: f.content,
            cut: 0,
          });
        }
        break;
      case "image":
        images.push({ mime: item.mime, data: item.data });
        break;
    }
  }
  if (fileCount) labels.push(`${fileCount} fichier${fileCount > 1 ? "s" : ""}`);
  if (images.length) labels.push(`${images.length} image${images.length > 1 ? "s" : ""}`);
  return { pieces, images, labels, docName, docContent };
}

const piecesChars = (pieces: Piece[]) =>
  pieces.reduce((n, p) => n + p.text.length + p.open.length + p.close.length + 2, 0);

/** Coupe les pièces les plus longues jusqu'à tenir dans `budgetChars`. */
function truncate(pieces: Piece[], budgetChars: number): string | undefined {
  let excess = piecesChars(pieces) - budgetChars;
  if (excess <= 0) return undefined;
  const cuts: string[] = [];
  const byLength = [...pieces].sort((a, b) => b.text.length - a.text.length);
  for (const p of byLength) {
    if (excess <= 0) break;
    const keep = Math.max(1500, p.text.length - excess - 200);
    if (keep >= p.text.length) continue;
    const removed = p.text.length - keep;
    p.text = `${p.text.slice(0, keep)}\n[… ${removed.toLocaleString("fr-FR")} caractères tronqués …]`;
    p.cut = removed;
    excess -= removed;
    cuts.push(`${p.label} (−${formatTokens(estimateTokens(removed))} tokens)`);
  }
  // Même au minimum, trop long : on retire les pièces restantes les plus lourdes.
  while (piecesChars(pieces) > budgetChars && pieces.length > 1) {
    const idx = pieces.reduce((best, p, i) => (p.text.length > pieces[best].text.length ? i : best), 0);
    const [dropped] = pieces.splice(idx, 1);
    cuts.push(`${dropped.label} (retiré)`);
  }
  return cuts.length ? `Contexte tronqué : ${cuts.join(", ")}` : undefined;
}

export function buildContext(
  items: ContextItem[],
  bridge: AiBridge,
  opts: {
    base: string;
    /** Taille déjà occupée par l'historique et la question (caractères). */
    conversationChars: number;
    windowTokens: number;
    /** Codex en mode édition reçoit le document sous forme de fichier. */
    excludeActiveDocument?: boolean;
  },
): BuiltContext {
  const { pieces, images, labels, docName, docContent } = piecesFor(items, bridge, {
    excludeActiveDocument: !!opts.excludeActiveDocument,
  });
  // Réserve pour la réponse et la marge d'estimation.
  const reserveTokens = Math.min(16_000, Math.floor(opts.windowTokens * 0.25));
  const budgetTokens = opts.windowTokens - reserveTokens - estimateTokens(opts.base.length + opts.conversationChars);
  const truncation = truncate(pieces, Math.max(2000, budgetTokens * 4));
  const context = pieces.map((p) => `${p.open}\n${p.text}\n${p.close}`).join("\n\n");
  const system = context ? `${opts.base}\n\n${context}` : opts.base;
  return {
    system,
    images,
    label: labels.join(" · "),
    documentName: docName,
    documentContent: docContent,
    estimatedTokens:
      estimateTokens(system.length + opts.conversationChars) + images.length * 1000,
    truncation,
  };
}

/** Estimation affichée dans la jauge, avant envoi (sans troncature). */
export function estimateItems(items: ContextItem[], bridge: AiBridge): number {
  const { pieces, images } = piecesFor(items, bridge, { excludeActiveDocument: false });
  return estimateTokens(piecesChars(pieces) + CHAT_SYSTEM.length) + images.length * 1000;
}
