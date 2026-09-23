import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../components/Icons";
import { cancelRunning, getBridge, revertHistory, sendMessage } from "../actions";
import { estimateItems } from "../context/collect";
import { contextWindow } from "../context/tokens";
import {
  activeModel,
  clearConversation,
  newId,
  providerLabel,
  updateSettings,
  useAi,
} from "../useAi";
import type { ContextItem, EditorSelection } from "../types";
import { preloadLocal } from "../residency";
import { AiMessage } from "./AiMessage";
import { ContextTray, itemFromFile, itemsFromPaths } from "./ContextTray";

const SUGGESTIONS: { label: string; text: string; mode: "chat" | "edit" }[] = [
  { label: "Résumer le document", text: "Résume ce document en quelques points.", mode: "chat" },
  { label: "Corriger les fautes", text: "Corrige l'orthographe et la grammaire du document.", mode: "edit" },
  { label: "Proposer un plan", text: "Propose un plan pour améliorer la structure de ce document.", mode: "chat" },
];

export function AiDock({
  activeTabId,
  tabs,
  onClose,
}: {
  activeTabId: string;
  tabs: { id: string; name: string; path?: string }[];
  onClose: () => void;
}) {
  const settings = useAi((s) => s.settings);
  const status = useAi((s) => s.status);
  const conversation = useAi((s) => s.conversations[activeTabId]);
  const running = useAi((s) => !!s.running[activeTabId]);
  const focusTick = useAi((s) => s.focusTick);
  const history = useAi((s) => s.history);

  const provider = settings.activeProvider;
  const model = activeModel(settings);
  const windowTokens = provider ? contextWindow(settings, provider, model) : 0;

  const [itemsByTab, setItemsByTab] = useState<Record<string, ContextItem[]>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<"chat" | "edit">("chat");
  const [view, setView] = useState<"chat" | "history">("chat");
  const [proposal, setProposal] = useState<EditorSelection | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [estimate, setEstimate] = useState(0);
  const [confirmNew, setConfirmNew] = useState(false);

  const rootRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const stickRef = useRef(true);

  const items = useMemo<ContextItem[]>(
    () => itemsByTab[activeTabId] ?? [{ id: `doc-${activeTabId}`, kind: "document", tabId: activeTabId }],
    [itemsByTab, activeTabId],
  );
  const setItems = useCallback(
    (next: ContextItem[]) => setItemsByTab((m) => ({ ...m, [activeTabId]: next })),
    [activeTabId],
  );
  const draft = drafts[activeTabId] ?? "";
  const setDraft = (v: string) => setDrafts((m) => ({ ...m, [activeTabId]: v }));

  // Estimation de tokens : relue périodiquement (le document change pendant
  // qu'on écrit la question), jamais à chaque frappe dans le champ.
  useEffect(() => {
    const compute = () => {
      try {
        const convChars = (conversation?.messages ?? []).reduce((n, m) => n + m.content.length, 0);
        setEstimate(estimateItems(items, getBridge()) + Math.ceil(convChars / 4));
      } catch {
        setEstimate(0);
      }
    };
    compute();
    const t = window.setInterval(compute, 4000);
    return () => window.clearInterval(t);
  }, [items, conversation?.messages.length, activeTabId]);

  // Sélection de l'éditeur proposée comme pastille. Une sélection faite dans
  // le dock lui-même n'efface pas la proposition.
  useEffect(() => {
    let timer: number | null = null;
    const onSel = () => {
      const sel = window.getSelection();
      const node = sel && sel.rangeCount ? sel.getRangeAt(0).startContainer : null;
      if (node && rootRef.current?.contains(node)) return;
      if (document.activeElement && rootRef.current?.contains(document.activeElement)) return;
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => setProposal(getBridge().readEditorSelection()), 180);
    };
    document.addEventListener("selectionchange", onSel);
    return () => {
      document.removeEventListener("selectionchange", onSel);
      if (timer != null) window.clearTimeout(timer);
    };
  }, []);

  // Glisser-déposer de fichiers : Tauri intercepte le drop natif et nous
  // donne les chemins ; on ne garde que ceux lâchés sur le dock.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    const inside = (pos: { x: number; y: number }) => {
      const r = rootRef.current?.getBoundingClientRect();
      if (!r) return false;
      const x = pos.x / window.devicePixelRatio;
      const y = pos.y / window.devicePixelRatio;
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };
    import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((event) => {
          const p = event.payload;
          if (p.type === "over") setDragOver(inside(p.position));
          else if (p.type === "leave") setDragOver(false);
          else if (p.type === "drop") {
            setDragOver(false);
            if (inside(p.position) && p.paths.length) {
              void itemsFromPaths(p.paths).then((more) => {
                if (more.length) setItemsByTab((m) => ({ ...m, [activeTabId]: [...(m[activeTabId] ?? items), ...more] }));
              });
            }
          }
        }),
      )
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [activeTabId, items]);

  useEffect(() => {
    if (focusTick) inputRef.current?.focus();
  }, [focusTick]);

  useEffect(() => setConfirmNew(false), [activeTabId]);

  // Modèle local : on le monte en VRAM dès l'ouverture du dock, pour que la
  // première réponse ne paie pas le chargement.
  useEffect(() => {
    if (provider) preloadLocal({ provider, model });
  }, [provider, model]);

  // Largeur publiée pour la mise en page du reste de l'application.
  useEffect(() => {
    const app = rootRef.current?.closest<HTMLElement>(".app");
    app?.style.setProperty("--ai-dock-w", `${settings.dockWidth}px`);
    return () => {
      app?.style.removeProperty("--ai-dock-w");
    };
  }, [settings.dockWidth]);

  // Défilement collé en bas pendant le streaming, sauf si l'utilisateur remonte.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  });

  const send = (text = draft, sendMode = mode) => {
    const t = text.trim();
    if (!t || running) return;
    void sendMessage({ tabId: activeTabId, text: t, items, mode: sendMode });
    setDraft("");
    stickRef.current = true;
    // Sélection et images sont à usage unique ; document, onglets et fichiers restent.
    setItems(items.filter((i) => i.kind !== "selection" && i.kind !== "image"));
  };

  const onPaste = async (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault();
    const more = (await Promise.all(files.map(itemFromFile))).filter((i): i is ContextItem => !!i);
    setItems([...items, ...more]);
  };

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = settings.dockWidth;
    const el = rootRef.current;
    let w = startW;
    const move = (ev: MouseEvent) => {
      w = Math.min(900, Math.max(300, startW + (startX - ev.clientX)));
      if (el) el.style.width = `${w}px`;
      el?.closest<HTMLElement>(".app")?.style.setProperty("--ai-dock-w", `${w}px`);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove("ai-resizing");
      updateSettings((s) => ({ ...s, dockWidth: w }));
    };
    document.body.classList.add("ai-resizing");
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const messages = conversation?.messages ?? [];
  const tabHistory = history.filter((h) => h.tabId === activeTabId);

  return (
    <aside
      ref={rootRef}
      className={`ai-dock${dragOver ? " drag-over" : ""}`}
      style={{ width: settings.dockWidth }}
    >
      <div className="ai-resize" onMouseDown={startResize} />
      <div className="ai-head">
        <Icon.Sparkles />
        <span className="ai-title">Assistant</span>
        <button
          type="button"
          className="ai-provider"
          title="Réglages de l'assistant"
          onClick={() => getBridge().openSetup()}
        >
          {providerLabel(provider)}
          {model && model !== "default" ? ` · ${model}` : ""}
        </button>
        <span className="ai-spacer" />
        <button
          type="button"
          className={`icon-btn${view === "history" ? " active" : ""}`}
          title="Modifications IA de cet onglet"
          onClick={() => setView(view === "history" ? "chat" : "history")}
        >
          <Icon.History />
        </button>
        <button
          type="button"
          className="icon-btn"
          title="Nouvelle conversation"
          disabled={running}
          onClick={() => {
            // Une seule conversation par onglet : on prévient avant d'écraser.
            if (messages.length) setConfirmNew(true);
            else clearConversation(activeTabId);
          }}
        >
          <Icon.Plus />
        </button>
        <button type="button" className="icon-btn" title="Fermer" onClick={onClose}>
          <Icon.Close />
        </button>
      </div>

      {confirmNew && (
        <div className="ai-banner ai-banner-confirm" role="alertdialog">
          <span>
            La conversation actuelle sera effacée. Les modifications déjà appliquées au document restent
            annulables.
          </span>
          <button type="button" onClick={() => setConfirmNew(false)}>
            Garder
          </button>
          <button
            type="button"
            className="danger"
            autoFocus
            onClick={() => {
              clearConversation(activeTabId);
              setConfirmNew(false);
              inputRef.current?.focus();
            }}
          >
            Effacer
          </button>
        </div>
      )}

      {status === "setup" && (
        <div className="ai-banner">
          {providerLabel(provider)} ne répond pas pour l'instant.
          <button type="button" onClick={() => getBridge().openSetup()}>
            Vérifier
          </button>
        </div>
      )}

      {view === "history" ? (
        <div className="ai-history">
          <h3>Modifications IA</h3>
          {!tabHistory.length && <p className="ai-muted">Aucune modification appliquée dans cet onglet.</p>}
          {tabHistory.map((h) => (
            <div key={h.id} className={`ai-history-item${h.reverted ? " reverted" : ""}`}>
              <div>
                <div className="ai-history-label">{h.label}</div>
                <div className="ai-muted">
                  {new Date(h.at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}
                  {h.reverted ? " · annulée" : ""}
                </div>
              </div>
              {!h.reverted && (
                <button type="button" className="pdf-btn" onClick={() => revertHistory(h.id)}>
                  Annuler
                </button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div
          className="ai-messages"
          ref={listRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
        >
          {!messages.length && (
            <div className="ai-empty">
              <p>Posez une question sur le document, ou demandez une modification : vous relirez le diff avant qu'elle ne s'applique.</p>
              {SUGGESTIONS.map((s) => (
                <button key={s.label} type="button" className="ai-suggestion" onClick={() => send(s.text, s.mode)}>
                  {s.label}
                </button>
              ))}
            </div>
          )}
          {messages.map((m) => (
            <AiMessage key={m.id} message={m} tabId={activeTabId} />
          ))}
        </div>
      )}

      <div className="ai-composer">
        <ContextTray
          items={items}
          onChange={setItems}
          tabs={tabs}
          activeTabId={activeTabId}
          proposal={proposal}
          onAcceptProposal={() =>
            proposal &&
            setItems([...items, { id: newId("i"), kind: "selection", tabId: proposal.tabId, markdown: proposal.markdown }])
          }
          usedTokens={estimate + Math.ceil(draft.length / 4)}
          windowTokens={windowTokens}
        />
        <textarea
          ref={inputRef}
          value={draft}
          rows={3}
          placeholder={
            mode === "edit"
              ? "Décrivez la modification à apporter au document…"
              : "Posez une question… (Entrée pour envoyer, Maj+Entrée pour aller à la ligne)"
          }
          onChange={(e) => setDraft(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="ai-composer-foot">
          <div className="ai-mode" role="radiogroup">
            <button
              type="button"
              role="radio"
              aria-checked={mode === "chat"}
              className={mode === "chat" ? "on" : ""}
              onClick={() => setMode("chat")}
            >
              Discuter
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={mode === "edit"}
              className={mode === "edit" ? "on" : ""}
              title="La réponse est un nouveau document, relu sous forme de diff"
              onClick={() => setMode("edit")}
            >
              Modifier le document
            </button>
          </div>
          <span className="ai-spacer" />
          {running ? (
            <button type="button" className="ai-send stop" title="Arrêter" onClick={() => cancelRunning(activeTabId)}>
              <Icon.Stop />
            </button>
          ) : (
            <button
              type="button"
              className="ai-send"
              title="Envoyer"
              disabled={!draft.trim() || !provider}
              onClick={() => send()}
            >
              <Icon.Send />
            </button>
          )}
        </div>
        {mode === "edit" && provider === "codex" && (
          <div className="ai-muted ai-note">
            Codex travaille sur une copie temporaire du document : comptez une à deux minutes.
          </div>
        )}
      </div>
    </aside>
  );
}
