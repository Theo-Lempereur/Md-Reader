import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Icon } from "../../components/Icons";
import { aiApi } from "../client";
import { estimateTokens, formatTokens } from "../context/tokens";
import { newId, notify } from "../useAi";
import type { ContextItem, EditorSelection } from "../types";

const IMAGE_EXT = ["png", "jpg", "jpeg", "gif", "webp"];

/** Lit des chemins (sélecteur natif, glisser-déposer) en éléments de contexte. */
export async function itemsFromPaths(paths: string[]): Promise<ContextItem[]> {
  const out: ContextItem[] = [];
  for (const path of paths) {
    try {
      const res = await aiApi.readContextPath(path);
      if (res.kind === "image") {
        out.push({ id: newId("i"), kind: "image", name: res.name, mime: res.mime, data: res.data });
        continue;
      }
      if (!res.files.length) {
        notify(`« ${res.name} » : aucun fichier texte exploitable.`, "error");
        continue;
      }
      out.push({
        id: newId("i"),
        kind: "files",
        name: res.name,
        path: res.path,
        folder: res.kind === "folder",
        files: res.files,
        totalChars: res.totalChars,
        skipped: res.skipped,
        truncated: res.truncated,
      });
      if (res.kind === "folder") {
        const extra = res.skipped ? `, ${res.skipped} ignoré${res.skipped > 1 ? "s" : ""}` : "";
        notify(
          `« ${res.name} » : ${res.files.length} fichiers, ~${formatTokens(estimateTokens(res.totalChars))} tokens${extra}${res.truncated ? " (plafond atteint)" : ""}.`,
        );
      }
    } catch (e) {
      notify(String(e), "error");
    }
  }
  return out;
}

/** Image collée ou déposée depuis le presse-papiers (objet File). */
export function itemFromFile(file: File): Promise<ContextItem | null> {
  return new Promise((resolve) => {
    if (!file.type.startsWith("image/")) return resolve(null);
    if (file.size > 8 * 1024 * 1024) {
      notify("Image trop volumineuse (8 Mo maximum).", "error");
      return resolve(null);
    }
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      const comma = url.indexOf(",");
      resolve({
        id: newId("i"),
        kind: "image",
        name: file.name || "image collée",
        mime: file.type,
        data: url.slice(comma + 1),
      });
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

function chipLabel(item: ContextItem, tabs: { id: string; name: string }[]): string {
  switch (item.kind) {
    case "document":
      return tabs.find((t) => t.id === item.tabId)?.name ?? "Document";
    case "selection":
      return `Sélection · ${item.markdown.length} car.`;
    case "tab":
      return item.name;
    case "files":
      return item.folder
        ? `${item.name}/ · ${item.files.length} fichiers`
        : item.name;
    case "image":
      return item.name;
  }
}

export function ContextTray({
  items,
  onChange,
  tabs,
  activeTabId,
  proposal,
  onAcceptProposal,
  usedTokens,
  windowTokens,
}: {
  items: ContextItem[];
  onChange: (items: ContextItem[]) => void;
  tabs: { id: string; name: string }[];
  activeTabId: string;
  proposal: EditorSelection | null;
  onAcceptProposal: () => void;
  usedTokens: number;
  windowTokens: number;
}) {
  const [menu, setMenu] = useState<null | "root" | "tabs">(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menu]);

  const add = (more: ContextItem[]) => onChange([...items, ...more]);
  const remove = (id: string) => onChange(items.filter((i) => i.id !== id));

  const pick = async (kind: "file" | "folder" | "image") => {
    setMenu(null);
    const selected = await open({
      multiple: kind !== "folder",
      directory: kind === "folder",
      filters: kind === "image" ? [{ name: "Image", extensions: IMAGE_EXT }] : undefined,
    });
    if (!selected) return;
    add(await itemsFromPaths(Array.isArray(selected) ? selected : [selected]));
  };

  const hasDocument = items.some((i) => i.kind === "document" && i.tabId === activeTabId);
  const hasSelection = items.some((i) => i.kind === "selection");
  const otherTabs = tabs.filter(
    (t) => t.id !== activeTabId && !items.some((i) => i.kind === "tab" && i.tabId === t.id),
  );
  const ratio = windowTokens > 0 ? usedTokens / windowTokens : 0;

  return (
    <div className="ai-tray">
      <div className="ai-chips">
        {items.map((item) => (
          <span key={item.id} className={`ai-chip kind-${item.kind}`} title={item.kind === "files" ? item.path : undefined}>
            {item.kind === "image" ? (
              <img src={`data:${item.mime};base64,${item.data}`} alt="" />
            ) : null}
            <span className="ai-chip-label">{chipLabel(item, tabs)}</span>
            <button type="button" aria-label="Retirer" onClick={() => remove(item.id)}>
              <Icon.Close />
            </button>
          </span>
        ))}
        {!hasDocument && (
          <button
            type="button"
            className="ai-chip suggested"
            onClick={() => add([{ id: newId("i"), kind: "document", tabId: activeTabId }])}
          >
            + Document courant
          </button>
        )}
        {proposal && !hasSelection && proposal.tabId === activeTabId && (
          <button type="button" className="ai-chip suggested" onClick={onAcceptProposal}>
            + Sélection · {proposal.markdown.length} car.
          </button>
        )}
        <div className="ai-add" ref={menuRef}>
          <button
            type="button"
            className="ai-chip add"
            title="Joindre au contexte"
            onClick={() => setMenu(menu ? null : "root")}
          >
            <Icon.Paperclip />
          </button>
          {menu === "root" && (
            <div className="ai-menu">
              <button type="button" disabled={!otherTabs.length} onClick={() => setMenu("tabs")}>
                Autre onglet…
              </button>
              <button type="button" onClick={() => void pick("file")}>
                Fichier…
              </button>
              <button type="button" onClick={() => void pick("folder")}>
                Dossier…
              </button>
              <button type="button" onClick={() => void pick("image")}>
                Image…
              </button>
            </div>
          )}
          {menu === "tabs" && (
            <div className="ai-menu">
              {otherTabs.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    add([{ id: newId("i"), kind: "tab", tabId: t.id, name: t.name }]);
                    setMenu(null);
                  }}
                >
                  {t.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <div
        className={`ai-gauge${ratio > 1 ? " over" : ratio > 0.8 ? " warn" : ""}`}
        title={
          ratio > 1
            ? "Au-delà de la fenêtre du modèle : les pièces jointes les plus longues seront tronquées (et signalées)."
            : "Estimation : ≈ 4 caractères par token"
        }
      >
        <div className="ai-gauge-bar">
          <i style={{ width: `${Math.min(100, ratio * 100)}%` }} />
        </div>
        <span>
          ~{formatTokens(usedTokens)} / {formatTokens(windowTokens)}
        </span>
      </div>
      {ratio > 1 && (
        <div className="ai-warn">
          Contexte trop long pour ce modèle : les éléments les plus volumineux seront tronqués à l'envoi.
        </div>
      )}
    </div>
  );
}
