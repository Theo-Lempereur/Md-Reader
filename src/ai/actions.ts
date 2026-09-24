/** Orchestration : envoi des messages, actions rapides, commandes slash,
 * application et annulation des modifications. */

import { streamChat } from "./client";
import { buildContext, CHAT_SYSTEM, EDIT_SYSTEM } from "./context/collect";
import { contextWindow } from "./context/tokens";
import { applyPatch, revertChange } from "./diff/apply";
import { canonical } from "./diff/diff";
import { createPatch, extractDocument } from "./diff/patch";
import {
  cleanSnippet,
  continuePrompt,
  QUICK_ACTIONS,
  QUICK_SYSTEM,
  quickPrompt,
  SUMMARY_PROMPT,
} from "./prompts";
import {
  activeModel,
  getAi,
  getConversation,
  isCliProvider,
  isLocalProvider,
  newId,
  notify,
  persistConversation,
  providerLabel,
  pushHistory,
  putPatch,
  setAi,
  updateConversation,
  updateMessage,
  updatePatch,
  updateSettings,
} from "./useAi";
import type {
  AiBridge,
  ChatMode,
  ContextItem,
  ProviderId,
  QuickActionKind,
  SlashAiKind,
  UiMessage,
  WireMessage,
} from "./types";

let bridge: AiBridge | null = null;

export function setBridge(b: AiBridge) {
  bridge = b;
}

export function getBridge(): AiBridge {
  if (!bridge) throw new Error("Module IA non initialisé");
  return bridge;
}

/* ------------------------------------------------------------------ */
/* Consentement                                                        */
/* ------------------------------------------------------------------ */

let consentResolve: ((ok: boolean) => void) | null = null;

/** Premier envoi à un fournisseur distant : consentement explicite,
 * mémorisé par fournisseur. Les modèles locaux n'envoient rien hors de la
 * machine. */
async function ensureConsent(provider: ProviderId, summary: string): Promise<boolean> {
  const { settings } = getAi();
  if (isLocalProvider(provider) || settings.consent[provider]) return true;
  consentResolve?.(false);
  const ok = await new Promise<boolean>((resolve) => {
    consentResolve = resolve;
    setAi({ consentAsk: { provider, summary } });
  });
  setAi({ consentAsk: null });
  if (ok) updateSettings((s) => ({ ...s, consent: { ...s.consent, [provider]: true } }));
  return ok;
}

export function answerConsent(ok: boolean) {
  const r = consentResolve;
  consentResolve = null;
  r?.(ok);
}

/* ------------------------------------------------------------------ */
/* Flux vers un message                                                */
/* ------------------------------------------------------------------ */

/** Diffuse une requête dans un message assistant, avec mise à jour groupée
 * par frame. Renvoie le texte final et l'éventuel document (Codex). */
async function streamInto(
  tabId: string,
  messageId: string,
  req: Parameters<typeof streamChat>[0],
): Promise<{ text: string; editResult?: string; cancelled: boolean } | null> {
  let text = "";
  let reasoning = "";
  let tools: string[] = [];
  let editResult: string | undefined;
  let frame = 0;
  const flush = () => {
    frame = 0;
    updateMessage(tabId, messageId, (m) => ({
      ...m,
      content: text,
      reasoning: reasoning || undefined,
      tools: tools.length ? tools : undefined,
    }));
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(flush);
  };
  const handle = streamChat(req, {
    onDelta: (t) => {
      text += t;
      schedule();
    },
    onReasoning: (t) => {
      reasoning += t;
      schedule();
    },
    onTool: (label) => {
      tools = [...tools, label];
      schedule();
    },
    onEditResult: (c) => (editResult = c),
  });
  setAi((s) => ({ running: { ...s.running, [tabId]: { cancel: handle.cancel } } }));
  try {
    const res = await handle.done;
    if (frame) cancelAnimationFrame(frame);
    flush();
    updateMessage(tabId, messageId, (m) => ({
      ...m,
      status: res.cancelled ? "cancelled" : "done",
      usage: res.usage,
    }));
    return { text, editResult, cancelled: res.cancelled };
  } catch (e) {
    if (frame) cancelAnimationFrame(frame);
    flush();
    updateMessage(tabId, messageId, (m) => ({
      ...m,
      status: "error",
      error: e instanceof Error ? e.message : String(e),
    }));
    return null;
  } finally {
    setAi((s) => ({ running: { ...s.running, [tabId]: undefined } }));
    persistConversation(tabId);
  }
}

export function cancelRunning(tabId: string) {
  getAi().running[tabId]?.cancel();
}

function currentProvider(): { provider: ProviderId; model: string } | null {
  const { settings, status } = getAi();
  const provider = settings.activeProvider;
  if (!provider || status === "off") {
    getBridge().openSetup();
    return null;
  }
  return { provider, model: activeModel(settings, provider) };
}

function pushMessages(tabId: string, ...messages: UiMessage[]) {
  const tab = getBridge().getTabs().find((t) => t.id === tabId);
  getConversation(tabId, tab?.path);
  updateConversation(tabId, (c) => ({ ...c, tabPath: tab?.path, messages: [...c.messages, ...messages] }));
}

/** Propose une modification : patch + ouverture du panneau de diff. */
function proposePatch(tabId: string, messageId: string, base: string, next: string, label: string) {
  const patch = createPatch(tabId, base, next, label);
  if (!patch.hunks.length) {
    updateMessage(tabId, messageId, (m) => ({ ...m, content: m.content || "Aucune modification proposée." }));
    notify("Le modèle n'a proposé aucune modification.");
    return;
  }
  putPatch(patch);
  updateMessage(tabId, messageId, (m) => ({ ...m, patchId: patch.id }));
  getBridge().openDiff(patch.id, tabId);
}

/* ------------------------------------------------------------------ */
/* Chat                                                                */
/* ------------------------------------------------------------------ */

export async function sendMessage(opts: {
  tabId: string;
  text: string;
  items: ContextItem[];
  mode: "chat" | "edit";
}) {
  const b = getBridge();
  const target = currentProvider();
  if (!target) return;
  const { provider, model } = target;
  const { tabId, text, items, mode } = opts;
  const conv = getConversation(tabId, b.getTabs().find((t) => t.id === tabId)?.path);

  const history = conv.messages.filter(
    (m) => (m.status === "done" || m.role === "user") && m.content.trim() && m.mode === "chat",
  );
  const conversationChars =
    text.length + (mode === "chat" ? history.reduce((n, m) => n + m.content.length, 0) : 0);
  // Codex et Claude modifient une copie du document sur disque.
  const fileEdit = isCliProvider(provider) && mode === "edit";
  const ctx = buildContext(items, b, {
    base: mode === "edit" && !fileEdit ? EDIT_SYSTEM : CHAT_SYSTEM,
    conversationChars,
    windowTokens: contextWindow(getAi().settings, provider, model),
    excludeActiveDocument: fileEdit,
  });

  if (mode === "edit") {
    if (ctx.documentContent == null) {
      notify("Joignez le document courant pour demander une modification.", "error");
      return;
    }
    if (ctx.truncation?.includes("document")) {
      notify(
        "Document trop long pour la fenêtre de ce modèle : une réécriture complète le tronquerait. Utilisez une sélection ou un modèle à plus longue fenêtre.",
        "error",
      );
      return;
    }
  }

  const sent = ctx.label ? `${ctx.label.split(" · ").join(", ")} et votre message` : "votre message";
  if (!(await ensureConsent(provider, sent))) return;

  const images = items.flatMap((i) =>
    i.kind === "image" ? [{ name: i.name, mime: i.mime, data: i.data }] : [],
  );
  const userMsg: UiMessage = {
    id: newId("m"),
    role: "user",
    content: text,
    mode,
    images: images.length ? images : undefined,
    contextLabel: ctx.label || undefined,
    truncation: ctx.truncation,
  };
  const assistantMsg: UiMessage = {
    id: newId("m"),
    role: "assistant",
    content: "",
    mode,
    status: "streaming",
    provider,
    model,
  };
  pushMessages(tabId, userMsg, assistantMsg);

  const wire: WireMessage[] =
    mode === "edit"
      ? [{ role: "user", content: `Demande : ${text}`, images: ctx.images }]
      : [
          ...history.map((m) => ({ role: m.role, content: m.content })),
          { role: "user" as const, content: text, images: ctx.images },
        ];

  const res = await streamInto(tabId, assistantMsg.id, {
    provider,
    model,
    system: ctx.system,
    messages: wire,
    conversationId: conv.id,
    mode,
    document:
      fileEdit && ctx.documentContent != null
        ? { name: ctx.documentName ?? "document.md", content: ctx.documentContent }
        : undefined,
  });
  if (!res || res.cancelled || mode !== "edit") return;

  const next = res.editResult ?? extractDocument(res.text);
  if (!res.editResult) {
    // L'affichage du document complet n'apporte rien : le diff le montre.
    updateMessage(tabId, assistantMsg.id, (m) => ({ ...m, content: "" }));
  }
  proposePatch(tabId, assistantMsg.id, ctx.documentContent!, next, labelFrom(text));
}

const labelFrom = (text: string) => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 70 ? t.slice(0, 67) + "…" : t;
};

/** « Proposer comme document » depuis un bloc markdown d'une réponse. */
export function proposeFromAnswer(tabId: string, messageId: string, markdown: string, label: string) {
  const base = getBridge().getTabMarkdown(tabId);
  if (base == null) return;
  proposePatch(tabId, messageId, base, markdown, label);
}

/* ------------------------------------------------------------------ */
/* Actions rapides sur la sélection                                    */
/* ------------------------------------------------------------------ */

/** Retrouve la sélection dans le markdown (correspondance exacte). */
export function locateSelection(
  base: string,
  sel: { markdown: string; text: string },
): { start: number; end: number } | null {
  for (const candidate of [sel.markdown.trim(), sel.text.trim()]) {
    if (!candidate) continue;
    const idx = base.indexOf(candidate);
    if (idx >= 0) return { start: idx, end: idx + candidate.length };
  }
  return null;
}

export async function runQuickAction(kind: QuickActionKind) {
  const b = getBridge();
  const sel = b.readEditorSelection();
  if (!sel || !sel.text.trim()) {
    notify("Sélectionnez d'abord un passage.");
    return;
  }
  const target = currentProvider();
  if (!target) return;
  const base = b.getTabMarkdown(sel.tabId);
  if (base == null) return;
  const action = QUICK_ACTIONS.find((a) => a.kind === kind)!;
  const range = locateSelection(base, sel);
  b.openDock();

  if (!range) {
    // Passage introuvable tel quel (sélection à cheval sur une structure) :
    // réécriture du document limitée au passage.
    await sendMessage({
      tabId: sel.tabId,
      mode: "edit",
      items: [{ id: newId("i"), kind: "document", tabId: sel.tabId }],
      text: `${action.instruction}\nNe modifie que ce passage, rien d'autre :\n«\n${sel.markdown.trim()}\n»`,
    });
    return;
  }

  if (!(await ensureConsent(target.provider, "le passage sélectionné et le document autour"))) return;
  const excerpt = base.slice(range.start, range.end);
  const userMsg: UiMessage = {
    id: newId("m"),
    role: "user",
    content: `${action.label} : « ${labelFrom(excerpt)} »`,
    mode: "chat",
    contextLabel: "Sélection",
  };
  const assistantMsg: UiMessage = {
    id: newId("m"),
    role: "assistant",
    content: "",
    mode: "chat",
    status: "streaming",
    provider: target.provider,
    model: target.model,
    target: { tabId: sel.tabId, ...range, base, kind },
  };
  pushMessages(sel.tabId, userMsg, assistantMsg);

  // Le document entier sert de contexte (tronqué autour du passage s'il est long).
  const around = base.length > 24_000
    ? base.slice(Math.max(0, range.start - 12_000), range.end + 12_000)
    : base;
  const res = await streamInto(sel.tabId, assistantMsg.id, {
    provider: target.provider,
    model: target.model,
    system: `${QUICK_SYSTEM}\n\n<document>\n${around}\n</document>`,
    messages: [{ role: "user", content: quickPrompt(kind, excerpt) }],
    mode: "chat",
  });
  if (!res || res.cancelled || !res.text.trim()) return;
  applyQuickResult(sel.tabId, assistantMsg.id, base, range, kind, res.text, action.label);
}

function applyQuickResult(
  tabId: string,
  messageId: string,
  base: string,
  range: { start: number; end: number },
  kind: QuickActionKind,
  answer: string,
  label: string,
) {
  const snippet = cleanSnippet(answer);
  const original = base.slice(range.start, range.end);
  let next: string;
  if (kind === "continue") {
    const atBlockEnd = base[range.end] === "\n" || range.end >= base.length;
    next = base.slice(0, range.end) + (atBlockEnd ? "\n\n" : " ") + snippet + base.slice(range.end);
  } else {
    const lead = /^\s*/.exec(original)?.[0] ?? "";
    const trail = /\s*$/.exec(original)?.[0] ?? "";
    next = base.slice(0, range.start) + lead + snippet + trail + base.slice(range.end);
  }
  proposePatch(tabId, messageId, base, next, `${label} : ${labelFrom(original)}`);
}

/* ------------------------------------------------------------------ */
/* Commandes slash                                                     */
/* ------------------------------------------------------------------ */

export async function runSlash(kind: SlashAiKind) {
  const b = getBridge();
  if (kind === "ask") {
    b.openDock();
    setAi((s) => ({ focusTick: s.focusTick + 1 }));
    return;
  }
  const target = currentProvider();
  if (!target) return;
  const caret = b.getCaretOffset();
  if (!caret) {
    notify("Placez le curseur dans le document.");
    return;
  }
  const { tabId, offset, markdown: base } = caret;
  if (!(await ensureConsent(target.provider, "le document"))) return;
  b.openDock();

  const userMsg: UiMessage = {
    id: newId("m"),
    role: "user",
    content: kind === "continue" ? "/ia continuer" : "/ia résumé",
    mode: "chat",
    contextLabel: "Document",
  };
  const assistantMsg: UiMessage = {
    id: newId("m"),
    role: "assistant",
    content: "",
    mode: "chat",
    status: "streaming",
    provider: target.provider,
    model: target.model,
  };
  pushMessages(tabId, userMsg, assistantMsg);

  const prompt =
    kind === "continue"
      ? continuePrompt(base.slice(Math.max(0, offset - 6000), offset), base.slice(offset, offset + 1500))
      : `${SUMMARY_PROMPT}\n\n<document>\n${base}\n</document>`;
  const res = await streamInto(tabId, assistantMsg.id, {
    provider: target.provider,
    model: target.model,
    system: QUICK_SYSTEM,
    messages: [{ role: "user", content: prompt }],
    mode: "chat",
  });
  if (!res || res.cancelled || !res.text.trim()) return;
  const snippet = cleanSnippet(res.text);
  const before = base.slice(0, offset);
  const after = base.slice(offset);
  const insert =
    kind === "summary"
      ? `${before && !before.endsWith("\n\n") ? (before.endsWith("\n") ? "\n" : "\n\n") : ""}${snippet}\n\n`
      : (before && !/\s$/.test(before) ? " " : "") + snippet;
  proposePatch(
    tabId,
    assistantMsg.id,
    base,
    before + insert + after,
    kind === "continue" ? "Continuer au curseur" : "Résumé du document",
  );
}

/* ------------------------------------------------------------------ */
/* Application / annulation                                            */
/* ------------------------------------------------------------------ */

let bannerTimer: number | null = null;

export function applyPatchNow(patchId: string) {
  const b = getBridge();
  const patch = getAi().patches[patchId];
  if (!patch || patch.state !== "review") return;
  const current = b.getTabMarkdown(patch.tabId);
  if (current == null) {
    notify("L'onglet de cette modification est fermé.", "error");
    return;
  }
  const outcome = applyPatch(patch, current);
  if (!outcome.applied.length) {
    notify(
      outcome.obsolete.length
        ? "Le document a changé à ces endroits : aucune partie ne peut plus s'appliquer."
        : "Aucune partie acceptée.",
      "error",
    );
    updatePatch(patchId, (p) => ({
      ...p,
      hunks: p.hunks.map((h) => (outcome.obsolete.includes(h.id) ? { ...h, status: "obsolete" } : h)),
    }));
    return;
  }
  const effective = b.applyTabContent(patch.tabId, outcome.content);
  const entryId = newId("e");
  pushHistory({
    id: entryId,
    tabId: patch.tabId,
    label: patch.label,
    at: Date.now(),
    before: canonical(current),
    after: canonical(effective),
  });
  updatePatch(patchId, (p) => ({
    ...p,
    state: "applied",
    hunks: p.hunks.map((h) => (outcome.obsolete.includes(h.id) ? { ...h, status: "obsolete" } : h)),
  }));
  b.closeDiff();
  showUndoBanner(entryId);
  if (outcome.obsolete.length) {
    notify(
      `${outcome.obsolete.length} partie(s) ignorée(s) : le document avait changé à ces endroits.`,
      "error",
    );
  }
}

function showUndoBanner(entryId: string) {
  setAi({ undoBanner: { entryId, until: Date.now() + 10_000 } });
  if (bannerTimer != null) window.clearTimeout(bannerTimer);
  bannerTimer = window.setTimeout(() => setAi({ undoBanner: null }), 10_000);
}

export function dismissUndoBanner() {
  if (bannerTimer != null) window.clearTimeout(bannerTimer);
  setAi({ undoBanner: null });
}

export function discardPatch(patchId: string) {
  updatePatch(patchId, (p) => ({ ...p, state: "discarded" }));
  getBridge().closeDiff();
}

/** Annule une modification de l'historique, même longtemps après. */
export function revertHistory(entryId: string) {
  const b = getBridge();
  const entry = getAi().history.find((h) => h.id === entryId);
  if (!entry || entry.reverted) return;
  const current = b.getTabMarkdown(entry.tabId);
  if (current == null) {
    notify("L'onglet de cette modification est fermé.", "error");
    return;
  }
  const res = revertChange(entry.before, entry.after, current);
  b.applyTabContent(entry.tabId, res.content);
  setAi((s) => ({
    history: s.history.map((h) => (h.id === entryId ? { ...h, reverted: true } : h)),
    undoBanner: s.undoBanner?.entryId === entryId ? null : s.undoBanner,
  }));
  notify(
    res.complete
      ? `Modification annulée : ${entry.label}`
      : "Annulation partielle : certaines zones ont été retouchées depuis.",
    res.complete ? "info" : "error",
  );
}

export const modeLabel = (mode: ChatMode) =>
  mode === "edit" ? "Modifier le document" : "Discuter";

export { providerLabel };
