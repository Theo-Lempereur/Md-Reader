/** Point d'entrée du chunk IA (chargé à la demande). Monte le dock, l'écran
 * de configuration, le consentement, le bandeau « Annuler » et
 * l'autocomplétion ; relie le bus d'événements de l'application. */

import { useEffect, useState } from "react";
import { Icon } from "../components/Icons";
import {
  answerConsent,
  dismissUndoBanner,
  revertHistory,
  runQuickAction,
  runSlash,
  setBridge,
} from "./actions";
import { onAi } from "./boot";
import { AiDock } from "./components/AiDock";
import { AiSetup } from "./components/AiSetup";
import { attachGhost, type GhostOptions } from "./ghost";
import { modelsInUse, watchResidency } from "./residency";
import { refreshDetection, recomputeStatus } from "./status";
import {
  AUTO_TTFT_MS,
  benchKey,
  getAi,
  normalizeSettings,
  providerLabel,
  restoreConversation,
  setAi,
  useAi,
} from "./useAi";
import type { AiBootInfo, AiBridge } from "./types";

export type AiHostProps = {
  bridge: AiBridge;
  boot: AiBootInfo;
  activeTabId: string;
  tabs: { id: string; name: string; path?: string }[];
  dockOpen: boolean;
  onCloseDock: () => void;
  setupOpen: boolean;
  onCloseSetup: () => void;
};

let initialized = false;

function ghostOptions(): GhostOptions | null {
  const { settings, status } = getAi();
  if (status === "off") return null;
  const use = modelsInUse(settings).complete;
  if (!use?.model) return null;
  const bench = settings.benchmarks[benchKey(use.provider, use.model)];
  return { provider: use.provider, model: use.model, auto: !!bench && bench.ttftMs < AUTO_TTFT_MS };
}

function ConsentDialog() {
  const ask = useAi((s) => s.consentAsk);
  if (!ask) return null;
  const name = providerLabel(ask.provider);
  return (
    <div className="pdf-modal-backdrop" role="dialog" aria-modal="true">
      <div className="pdf-modal confirm-modal">
        <div className="pdf-modal-head">
          <h2>Envoyer à {name} ?</h2>
        </div>
        <div className="pdf-modal-body confirm-modal-body">
          <p>
            Pour répondre, <strong>{name}</strong> va recevoir : {ask.summary}.
          </p>
          <p>
            Ces données quittent votre machine et sont traitées selon les conditions de ce
            fournisseur. Ce choix est mémorisé pour {name} ; vous pourrez le révoquer dans les
            réglages de l'assistant.
          </p>
        </div>
        <div className="pdf-modal-foot">
          <button type="button" className="pdf-btn" onClick={() => answerConsent(false)}>
            Annuler
          </button>
          <button type="button" className="pdf-btn primary" onClick={() => answerConsent(true)}>
            Envoyer
          </button>
        </div>
      </div>
    </div>
  );
}

function UndoBanner() {
  const banner = useAi((s) => s.undoBanner);
  const entry = useAi((s) => (banner ? s.history.find((h) => h.id === banner.entryId) : undefined));
  if (!banner || !entry) return null;
  return (
    <div className="ai-undo" role="status">
      <Icon.Sparkles />
      <span className="ai-undo-label">Modification IA appliquée : {entry.label}</span>
      <button type="button" onClick={() => revertHistory(entry.id)}>
        Annuler
      </button>
      <button type="button" className="ai-undo-x" aria-label="Fermer" onClick={dismissUndoBanner}>
        <Icon.Close />
      </button>
      <i className="ai-undo-timer" />
    </div>
  );
}

function Notice() {
  const notice = useAi((s) => s.notice);
  if (!notice) return null;
  return (
    <div className={`ai-notice ${notice.kind}`} role="status" onClick={() => setAi({ notice: null })}>
      {notice.text}
    </div>
  );
}

/** Téléchargement Ollama en cours alors que l'écran de configuration est
 * fermé : il continue en arrière-plan, on le montre. */
function PullIndicator({ onOpen }: { onOpen: () => void }) {
  const pull = useAi((s) => s.pull);
  if (!pull) return null;
  const pct = pull.ratio != null ? Math.round(pull.ratio * 100) : null;
  return (
    <button type="button" className="ai-notice ai-pull-pill" title="Ouvrir l'écran de configuration" onClick={onOpen}>
      <span>
        Téléchargement de <strong>{pull.tag}</strong>
        {pct != null ? ` · ${pct} %` : ` · ${pull.status}`}
      </span>
      <span className="ai-gauge-bar">
        <i style={{ width: `${pct ?? 0}%` }} />
      </span>
    </button>
  );
}

export function AiHost(props: AiHostProps) {
  const { bridge } = props;
  // Pont stable (construit une fois par l'application, tout passe par des refs).
  setBridge(bridge);

  const [ready, setReady] = useState(initialized);
  useEffect(() => {
    if (initialized) {
      // Remontage (l'hôte a été démonté entre-temps) : l'application doit
      // retrouver le statut courant.
      recomputeStatus();
      return;
    }
    initialized = true;
    const settings = normalizeSettings(props.boot.settings);
    setAi({ settings, keys: props.boot.keys ?? [] });
    recomputeStatus();
    if (settings.activeProvider) void refreshDetection();
    void restoreConversation(props.tabs);
    watchResidency();
    setReady(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const offs = [
      onAi("quick-action", ({ kind }) => void runQuickAction(kind)),
      onAi("slash", ({ kind }) => void runSlash(kind)),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  const autocomplete = useAi((s) => s.settings.autocomplete.enabled);
  const status = useAi((s) => s.status);
  useEffect(() => {
    if (!autocomplete || status !== "ready") return;
    return attachGhost(bridge, ghostOptions);
  }, [bridge, autocomplete, status]);

  if (!ready) return null;
  return (
    <>
      {props.dockOpen && props.activeTabId && (
        <AiDock activeTabId={props.activeTabId} tabs={props.tabs} onClose={props.onCloseDock} />
      )}
      {props.setupOpen && <AiSetup onClose={props.onCloseSetup} />}
      <ConsentDialog />
      <UndoBanner />
      <div className="ai-toasts left">
        {!props.setupOpen && <PullIndicator onOpen={() => bridge.openSetup()} />}
      </div>
      <div className="ai-toasts">
        <Notice />
      </div>
    </>
  );
}
