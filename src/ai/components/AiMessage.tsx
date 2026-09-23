import { memo, useMemo } from "react";
import { renderMarkdown } from "../../markdown/render";
import { normalizeMarkdown } from "../../markdown/normalize";
import { Icon } from "../../components/Icons";
import { getBridge, proposeFromAnswer } from "../actions";
import { formatTokens } from "../context/tokens";
import { notify, providerLabel, useAi } from "../useAi";
import type { UiMessage } from "../types";

type Segment = { kind: "md"; text: string } | { kind: "code"; lang: string; text: string; open: boolean };

/** Sépare la prose des blocs de code (y compris un bloc encore ouvert pendant
 * le streaming), pour ajouter des boutons à chaque bloc. */
export function splitSegments(md: string): Segment[] {
  const out: Segment[] = [];
  const lines = md.split("\n");
  let prose: string[] = [];
  let i = 0;
  const flushProse = () => {
    if (prose.join("").trim()) out.push({ kind: "md", text: prose.join("\n") });
    prose = [];
  };
  while (i < lines.length) {
    const open = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/.exec(lines[i]);
    if (!open) {
      prose.push(lines[i++]);
      continue;
    }
    flushProse();
    const fence = open[1];
    const body: string[] = [];
    i++;
    let closed = false;
    while (i < lines.length) {
      if (new RegExp(`^\\s{0,3}${fence[0]}{${fence.length},}\\s*$`).test(lines[i])) {
        closed = true;
        i++;
        break;
      }
      body.push(lines[i++]);
    }
    out.push({ kind: "code", lang: open[2].toLowerCase(), text: body.join("\n"), open: !closed });
  }
  flushProse();
  return out;
}

const isMarkdownLang = (lang: string) => lang === "markdown" || lang === "md" || lang === "";

const MessageBody = memo(function MessageBody({
  content,
  tabId,
  messageId,
}: {
  content: string;
  tabId: string;
  messageId: string;
}) {
  const segments = useMemo(() => splitSegments(content), [content]);
  return (
    <>
      {segments.map((seg, i) =>
        seg.kind === "md" ? (
          <div key={i} className="ai-md reading">
            {renderMarkdown(normalizeMarkdown(seg.text))}
          </div>
        ) : (
          <div key={i} className="ai-code">
            <div className="ai-code-head">
              <span>{seg.lang || "texte"}</span>
              <span className="ai-spacer" />
              <button
                type="button"
                title="Copier"
                onClick={() => {
                  void navigator.clipboard?.writeText(seg.text);
                  notify("Copié.");
                }}
              >
                <Icon.Copy /> Copier
              </button>
              <button
                type="button"
                title="Insérer au caret dans le document"
                disabled={seg.open}
                onClick={() => {
                  const text = isMarkdownLang(seg.lang)
                    ? seg.text
                    : `\`\`\`${seg.lang}\n${seg.text}\n\`\`\``;
                  if (!getBridge().insertAtCaret(text)) {
                    notify("Activez la modification et placez le curseur dans le document.", "error");
                  }
                }}
              >
                Insérer
              </button>
              {isMarkdownLang(seg.lang) && !seg.open && seg.text.length > 200 && (
                <button
                  type="button"
                  title="Comparer ce bloc au document et proposer de le remplacer"
                  onClick={() => proposeFromAnswer(tabId, messageId, seg.text, "Document proposé dans le chat")}
                >
                  Proposer comme document
                </button>
              )}
            </div>
            <div className="reading ai-code-body">
              <pre>
                <code>{seg.text}</code>
              </pre>
            </div>
          </div>
        ),
      )}
    </>
  );
});

export function AiMessage({ message, tabId }: { message: UiMessage; tabId: string }) {
  const patch = useAi((s) => (message.patchId ? s.patches[message.patchId] : undefined));

  if (message.role === "user") {
    return (
      <div className="ai-msg user">
        <div className="ai-bubble">{message.content}</div>
        {(message.contextLabel || message.images?.length) && (
          <div className="ai-msg-meta">
            {message.mode === "edit" && <span className="ai-tag">Modification</span>}
            {message.contextLabel && <span>{message.contextLabel}</span>}
          </div>
        )}
        {message.images?.length ? (
          <div className="ai-thumbs">
            {message.images.map((img, i) => (
              <img key={i} src={`data:${img.mime};base64,${img.data}`} alt={img.name} />
            ))}
          </div>
        ) : null}
        {message.truncation && <div className="ai-warn">{message.truncation}</div>}
      </div>
    );
  }

  const streaming = message.status === "streaming";
  return (
    <div className="ai-msg assistant">
      {message.reasoning && (
        <details className="ai-reasoning" open={streaming && !message.content}>
          <summary>Raisonnement</summary>
          <div className="ai-reasoning-body">{message.reasoning}</div>
        </details>
      )}
      {message.tools?.length ? (
        <div className="ai-tools">
          {message.tools.slice(-4).map((t, i) => (
            <div key={i} className="ai-tool">
              {t}
            </div>
          ))}
        </div>
      ) : null}
      {message.content ? (
        <MessageBody content={message.content} tabId={tabId} messageId={message.id} />
      ) : streaming ? (
        <div className="ai-typing">
          <span />
          <span />
          <span />
          {message.mode === "edit" && <em>Réécriture du document…</em>}
        </div>
      ) : null}
      {message.status === "error" && <div className="ai-error">{message.error}</div>}
      {message.status === "cancelled" && <div className="ai-muted">Interrompu.</div>}
      {patch && (
        <div className={`ai-patch-line ${patch.state}`}>
          <span>
            {patch.state === "review"
              ? `Modification proposée · ${patch.hunks.length} bloc${patch.hunks.length > 1 ? "s" : ""}`
              : patch.state === "applied"
                ? "Modification appliquée"
                : "Modification ignorée"}
          </span>
          {patch.state === "review" && (
            <button type="button" onClick={() => getBridge().openDiff(patch.id, patch.tabId)}>
              Relire le diff
            </button>
          )}
        </div>
      )}
      {!streaming && message.status === "done" && (
        <div className="ai-msg-meta">
          <span>
            {providerLabel(message.provider)}
            {message.model && message.model !== "default" ? ` · ${message.model}` : ""}
          </span>
          {message.usage?.outputTokens != null && (
            <span>{formatTokens(message.usage.outputTokens)} tokens</span>
          )}
          {message.content && (
            <button
              type="button"
              className="ai-link"
              onClick={() => {
                void navigator.clipboard?.writeText(message.content);
                notify("Réponse copiée.");
              }}
            >
              Copier
            </button>
          )}
        </div>
      )}
    </div>
  );
}
