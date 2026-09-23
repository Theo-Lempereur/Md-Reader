import { useEffect, useId, useState } from "react";
import { aiApi } from "../client";
import { refreshDetection, recomputeStatus, providerAvailable } from "../status";
import {
  activeModel,
  AUTO_TTFT_MS,
  benchKey,
  DEFAULT_MODELS,
  isLocalProvider,
  notify,
  PROVIDERS,
  providerLabel,
  updateSettings,
  useAi,
} from "../useAi";
import type { ProviderId } from "../types";
import { preloadLocal } from "../residency";
import { LocalWizard } from "./LocalWizard";

type Door = "codex" | "key" | "local" | "settings";

const openExternal = (url: string) =>
  import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(url)).catch(() => {});

function chooseProvider(p: ProviderId, model: string) {
  return () => {
    updateSettings((s) => ({
      ...s,
      activeProvider: p,
      models: { ...s.models, [p]: model || DEFAULT_MODELS[p] || "" },
    }));
    recomputeStatus();
    notify(`Assistant branché sur ${providerLabel(p)}.`);
  };
}

export function ModelPicker({
  provider,
  value,
  onChange,
  suggestions,
}: {
  provider: ProviderId;
  value: string;
  onChange: (v: string) => void;
  suggestions?: string[];
}) {
  // Pas de <datalist> : WebView2 le filtre sur la valeur déjà saisie
  // (« default », « claude-… »), si bien que la liste chargée n'apparaissait
  // jamais. Liste affichée en clair sous le champ, erreurs comprises (les
  // notifications passent sous la modale).
  const listId = useId();
  const [models, setModels] = useState<string[]>(suggestions ?? []);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Clé stable : `suggestions` est souvent un tableau recréé à chaque rendu.
  const suggestionsKey = suggestions?.join("\n") ?? "";
  useEffect(() => {
    setModels(suggestionsKey ? suggestionsKey.split("\n") : []);
    setOpen(false);
    setError(null);
  }, [provider, suggestionsKey]);

  const load = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setFilter("");
    if (models.length && !error) {
      setOpen(true);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const list = await aiApi.listModels(provider);
      setModels(list);
      if (list.length) setOpen(true);
      else setError("Aucun modèle renvoyé par le fournisseur.");
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const shown = filter ? models.filter((m) => m.toLowerCase().includes(filter.toLowerCase())) : models;
  const pick = (m: string) => {
    onChange(m);
    setOpen(false);
  };

  return (
    <div className="ai-model-picker">
      <div className="ai-field-row">
        <input
          className="ai-input"
          value={value}
          placeholder={DEFAULT_MODELS[provider] ?? "identifiant du modèle"}
          aria-controls={open ? listId : undefined}
          onChange={(e) => {
            onChange(e.target.value);
            if (open) setFilter(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && open) {
              e.stopPropagation();
              setOpen(false);
            } else if (e.key === "Enter" && open && shown.length) {
              e.preventDefault();
              pick(shown[0]);
            }
          }}
        />
        <button
          type="button"
          className={`pdf-btn${open ? " on" : ""}`}
          disabled={loading}
          aria-expanded={open}
          onClick={() => void load()}
        >
          {loading ? "Chargement…" : open ? "Masquer" : "Lister"}
        </button>
      </div>
      {error && <p className="ai-warn ai-model-error">{error}</p>}
      {open && (
        <div className="ai-model-list" id={listId} role="listbox">
          {shown.length ? (
            shown.map((m) => (
              <button
                key={m}
                type="button"
                role="option"
                aria-selected={m === value}
                className={m === value ? "on" : ""}
                onClick={() => pick(m)}
              >
                {m}
              </button>
            ))
          ) : (
            <p className="ai-muted">Aucun modèle ne correspond à « {filter} ».</p>
          )}
        </div>
      )}
    </div>
  );
}

function CodexDoor() {
  const det = useAi((s) => s.detection);
  const detecting = useAi((s) => s.detecting);
  const settings = useAi((s) => s.settings);
  const [model, setModel] = useState(settings.models.codex ?? "default");
  const codex = det?.codex;
  return (
    <div className="ai-door">
      <p>
        Utilise votre abonnement ChatGPT via Codex, sans clé API. Le document est transmis à OpenAI
        uniquement quand vous envoyez une demande.
      </p>
      {!det || detecting ? (
        <p className="ai-muted">Recherche de Codex…</p>
      ) : !codex?.installed ? (
        <>
          <p className="ai-warn">Codex n'est pas installé sur cette machine.</p>
          <p className="ai-muted">
            Installez l'application Codex ou la CLI (<code>npm i -g @openai/codex</code>), puis
            connectez-vous avec votre compte ChatGPT.
          </p>
          <div className="ai-actions">
            <button type="button" className="pdf-btn" onClick={() => void openExternal("https://github.com/openai/codex")}>
              Instructions d'installation
            </button>
            <button type="button" className="pdf-btn" onClick={() => void refreshDetection()}>
              Vérifier à nouveau
            </button>
          </div>
        </>
      ) : !codex.loggedIn ? (
        <>
          <p className="ai-warn">Codex {codex.version ?? ""} est installé mais pas connecté.</p>
          <p className="ai-muted">
            Ouvrez un terminal et lancez <code>codex login</code>, puis revenez ici.
          </p>
          <button type="button" className="pdf-btn" onClick={() => void refreshDetection()}>
            Vérifier à nouveau
          </button>
        </>
      ) : (
        <>
          <p className="ai-ok">✓ {codex.version} · connecté</p>
          <label className="ai-label">Modèle</label>
          <ModelPicker provider="codex" value={model} onChange={setModel} />
          <p className="ai-muted ai-note">
            « default » suit le modèle configuré dans Codex. Le mode « Modifier le document » fait
            travailler Codex sur une copie temporaire : comptez une à deux minutes. Pas
            d'autocomplétion avec Codex.
          </p>
          <div className="ai-actions">
            <button type="button" className="pdf-btn primary" onClick={chooseProvider("codex", model)}>
              Utiliser Codex
            </button>
          </div>
        </>
      )}
    </div>
  );
}

const KEY_PROVIDERS: ProviderId[] = ["openai", "anthropic", "mistral", "openrouter"];
const KEY_HELP: Partial<Record<ProviderId, string>> = {
  openai: "https://platform.openai.com/api-keys",
  anthropic: "https://console.anthropic.com/settings/keys",
  mistral: "https://console.mistral.ai/api-keys",
  openrouter: "https://openrouter.ai/keys",
};

function KeyDoor() {
  const keys = useAi((s) => s.keys);
  const settings = useAi((s) => s.settings);
  const [provider, setProvider] = useState<ProviderId>(
    KEY_PROVIDERS.includes(settings.activeProvider as ProviderId) ? settings.activeProvider! : "anthropic",
  );
  const [key, setKey] = useState("");
  const [model, setModel] = useState(activeModel(settings, provider));
  const [baseUrl, setBaseUrl] = useState(settings.baseUrls[provider] ?? "");
  const [busy, setBusy] = useState(false);
  const hasKey = keys.includes(provider);

  useEffect(() => {
    setModel(activeModel(settings, provider));
    setBaseUrl(settings.baseUrls[provider] ?? "");
    setKey("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  const save = async () => {
    setBusy(true);
    try {
      await aiApi.saveKey(provider, key);
      setKey("");
      await refreshDetection();
      notify("Clé enregistrée dans le Gestionnaire d'identification Windows.");
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ai-door">
      <p>
        La clé est stockée dans le Gestionnaire d'identification Windows, jamais dans un fichier ni
        dans l'interface. Les requêtes partent directement de l'application vers le fournisseur.
      </p>
      <label className="ai-label">Fournisseur</label>
      <select className="ai-input" value={provider} onChange={(e) => setProvider(e.target.value as ProviderId)}>
        {KEY_PROVIDERS.map((p) => (
          <option key={p} value={p}>
            {providerLabel(p)}
            {keys.includes(p) ? " · clé enregistrée" : ""}
          </option>
        ))}
      </select>
      <label className="ai-label">Clé API</label>
      <div className="ai-field-row">
        <input
          className="ai-input"
          type="password"
          autoComplete="off"
          value={key}
          placeholder={hasKey ? "•••••••• (enregistrée — saisir pour remplacer)" : "Collez votre clé"}
          onChange={(e) => setKey(e.target.value)}
        />
        <button type="button" className="pdf-btn" disabled={!key.trim() || busy} onClick={() => void save()}>
          Enregistrer
        </button>
      </div>
      <div className="ai-actions ai-actions-left">
        {KEY_HELP[provider] && (
          <button type="button" className="ai-link" onClick={() => void openExternal(KEY_HELP[provider]!)}>
            Obtenir une clé
          </button>
        )}
        {hasKey && (
          <button
            type="button"
            className="ai-link danger"
            onClick={async () => {
              await aiApi.deleteKey(provider).catch((e) => notify(String(e), "error"));
              await refreshDetection();
            }}
          >
            Supprimer la clé
          </button>
        )}
      </div>
      <label className="ai-label">Modèle</label>
      <ModelPicker provider={provider} value={model} onChange={setModel} />
      <details className="ai-advanced">
        <summary>Avancé</summary>
        <label className="ai-label">URL de l'API (laisser vide pour la valeur par défaut)</label>
        <input
          className="ai-input"
          value={baseUrl}
          placeholder="https://…"
          onChange={(e) => setBaseUrl(e.target.value)}
          onBlur={() =>
            updateSettings((s) => ({ ...s, baseUrls: { ...s.baseUrls, [provider]: baseUrl.trim() } }))
          }
        />
      </details>
      <div className="ai-actions">
        <button type="button" className="pdf-btn primary" disabled={!hasKey || !model.trim()} onClick={chooseProvider(provider, model.trim())}>
          Utiliser {providerLabel(provider)}
        </button>
      </div>
    </div>
  );
}

function LocalDoor() {
  const det = useAi((s) => s.detection);
  const settings = useAi((s) => s.settings);
  const [lmModel, setLmModel] = useState(settings.models.lmstudio ?? "");
  const [ollamaModel, setOllamaModel] = useState(settings.models.ollama ?? "");
  const ollamaModels = det?.ollama.models.map((m) => m.name) ?? [];
  useEffect(() => {
    if (!ollamaModel && ollamaModels[0]) setOllamaModel(ollamaModels[0]);
  }, [ollamaModels, ollamaModel]);
  return (
    <div className="ai-door">
      <p>Tout reste sur votre machine : aucun document ne sort de l'ordinateur.</p>
      <h4>Ollama</h4>
      {det?.ollama.running ? (
        ollamaModels.length ? (
          <>
            <div className="ai-field-row">
              <select className="ai-input" value={ollamaModel} onChange={(e) => setOllamaModel(e.target.value)}>
                {ollamaModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <button type="button" className="pdf-btn primary" disabled={!ollamaModel} onClick={chooseProvider("ollama", ollamaModel)}>
                Utiliser
              </button>
            </div>
          </>
        ) : (
          <p className="ai-muted">Ollama tourne, mais aucun modèle n'est installé. L'assistant ci-dessous vous aide à en choisir un.</p>
        )
      ) : (
        <p className="ai-muted">{det?.ollama.installed ? "Ollama est installé mais ne tourne pas." : "Ollama n'est pas détecté."}</p>
      )}
      <LocalWizard />
      <h4>LM Studio</h4>
      {det?.lmstudio.running ? (
        <div className="ai-field-row">
          <select className="ai-input" value={lmModel} onChange={(e) => setLmModel(e.target.value)}>
            <option value="">Choisir un modèle chargé…</option>
            {det.lmstudio.models.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name}
              </option>
            ))}
          </select>
          <button type="button" className="pdf-btn primary" disabled={!lmModel} onClick={chooseProvider("lmstudio", lmModel)}>
            Utiliser
          </button>
        </div>
      ) : (
        <p className="ai-muted">
          Serveur LM Studio non détecté sur le port 1234 (onglet « Developer » → « Start server »).
        </p>
      )}
    </div>
  );
}

function SettingsDoor({ onClose }: { onClose: () => void }) {
  const settings = useAi((s) => s.settings);
  const det = useAi((s) => s.detection);
  const keys = useAi((s) => s.keys);
  const status = useAi((s) => s.status);
  const p = settings.activeProvider;
  const [benching, setBenching] = useState(false);

  const acCandidates = PROVIDERS.filter(
    (x) => x.id !== "codex" && providerAvailable(det, keys, x.id),
  ).map((x) => x.id);
  const ac = settings.autocomplete;
  const acProvider = ac.provider ?? (p && p !== "codex" ? p : acCandidates[0] ?? null);
  const acModel = ac.model || (acProvider ? activeModel(settings, acProvider) : "");
  const bench = acProvider ? settings.benchmarks[benchKey(acProvider, acModel)] : undefined;
  const twoLocalModels =
    ac.enabled &&
    isLocalProvider(p) &&
    isLocalProvider(acProvider) &&
    (acProvider !== p || acModel !== activeModel(settings));

  const runBench = async () => {
    if (!acProvider || !acModel) return;
    setBenching(true);
    try {
      const b = await aiApi.benchmark(acProvider, acModel);
      updateSettings((s) => ({
        ...s,
        benchmarks: { ...s.benchmarks, [benchKey(acProvider, acModel)]: { ...b, at: Date.now() } },
      }));
    } catch (e) {
      notify(`Mesure impossible : ${e}`, "error");
    } finally {
      setBenching(false);
    }
  };

  return (
    <div className="ai-door">
      <p>
        Fournisseur actif : <strong>{providerLabel(p)}</strong>
        {p ? ` · ${activeModel(settings) || "modèle par défaut"}` : ""} —{" "}
        {status === "ready" ? <span className="ai-ok">opérationnel</span> : <span className="ai-warn-inline">ne répond pas</span>}
      </p>

      <h4>Autocomplétion</h4>
      <label className="ai-check">
        <input
          type="checkbox"
          checked={ac.enabled}
          disabled={!acProvider}
          onChange={(e) => {
            updateSettings((s) => ({
              ...s,
              autocomplete: { ...s.autocomplete, enabled: e.target.checked, provider: acProvider, model: acModel },
            }));
            if (e.target.checked && acProvider) preloadLocal({ provider: acProvider, model: acModel });
          }}
        />
        Proposer la suite du texte en gris (Tab pour accepter, Ctrl+Espace à la demande)
      </label>
      {!acProvider && (
        <p className="ai-muted">Nécessite un modèle local ou une clé API (pas Codex).</p>
      )}
      {acProvider && (
        <>
          <div className="ai-field-row">
            <select
              className="ai-input"
              value={acProvider}
              onChange={(e) =>
                updateSettings((s) => ({
                  ...s,
                  autocomplete: { ...s.autocomplete, provider: e.target.value as ProviderId, model: "" },
                }))
              }
            >
              {acCandidates.map((x) => (
                <option key={x} value={x}>
                  {providerLabel(x)}
                </option>
              ))}
            </select>
          </div>
          <ModelPicker
            provider={acProvider}
            value={acModel}
            suggestions={acProvider === "ollama" ? det?.ollama.models.map((m) => m.name) : undefined}
            onChange={(v) =>
              updateSettings((s) => ({ ...s, autocomplete: { ...s.autocomplete, provider: acProvider, model: v } }))
            }
          />
          <div className="ai-actions ai-actions-left">
            <button type="button" className="pdf-btn" disabled={benching || !acModel} onClick={() => void runBench()}>
              {benching ? "Mesure en cours…" : "Mesurer la latence"}
            </button>
            {bench && (
              <span className="ai-muted">
                1er token en {bench.ttftMs} ms · {bench.tokensPerSec} tokens/s —{" "}
                {bench.ttftMs < AUTO_TTFT_MS
                  ? "assez rapide pour l'autocomplétion automatique."
                  : "trop lent pour l'automatique : proposée à la demande (Ctrl+Espace)."}
              </span>
            )}
          </div>
          {!bench && ac.enabled && (
            <p className="ai-muted">Sans mesure, l'autocomplétion reste à la demande (Ctrl+Espace).</p>
          )}
          {twoLocalModels && p && (
            <div className="ai-warn">
              L'assistant ({activeModel(settings) || providerLabel(p)}) et l'autocomplétion ({acModel}) utilisent
              deux modèles locaux différents. Ils occupent la mémoire vidéo ensemble ; si elle ne suffit pas,
              ils se déchargent l'un l'autre à chaque changement et chaque suggestion peut prendre plusieurs
              secondes.{" "}
              {activeModel(settings) && (
                <button
                  type="button"
                  className="ai-link"
                  onClick={() =>
                    updateSettings((s) => ({
                      ...s,
                      autocomplete: { ...s.autocomplete, provider: p, model: activeModel(s) },
                    }))
                  }
                >
                  Utiliser le modèle de l'assistant
                </button>
              )}
            </div>
          )}
        </>
      )}

      {p && (
        <>
          <h4>Fenêtre de contexte</h4>
          <div className="ai-field-row">
            <input
              className="ai-input"
              type="number"
              min={1024}
              step={1024}
              placeholder={isLocalProvider(p) ? "8192 (défaut prudent pour un modèle local)" : "automatique"}
              value={settings.contextWindows[p] ?? ""}
              onChange={(e) => {
                const n = Number(e.target.value);
                updateSettings((s) => ({
                  ...s,
                  contextWindows: { ...s.contextWindows, [p]: Number.isFinite(n) && n > 0 ? n : undefined },
                }));
              }}
            />
            <span className="ai-muted">tokens</span>
          </div>
        </>
      )}

      {Object.entries(settings.consent).some(([, v]) => v) && (
        <>
          <h4>Consentements d'envoi</h4>
          {Object.entries(settings.consent)
            .filter(([, v]) => v)
            .map(([k]) => (
              <div key={k} className="ai-field-row">
                <span>{providerLabel(k as ProviderId)}</span>
                <span className="ai-spacer" />
                <button
                  type="button"
                  className="ai-link danger"
                  onClick={() => updateSettings((s) => ({ ...s, consent: { ...s.consent, [k]: false } }))}
                >
                  Révoquer
                </button>
              </div>
            ))}
        </>
      )}

      <div className="ai-actions">
        <button
          type="button"
          className="pdf-btn danger-outline"
          onClick={() => {
            updateSettings((s) => ({ ...s, activeProvider: null, autocomplete: { ...s.autocomplete, enabled: false } }));
            recomputeStatus();
            onClose();
          }}
        >
          Désactiver l'assistant
        </button>
      </div>
    </div>
  );
}

export function AiSetup({ onClose }: { onClose: () => void }) {
  const settings = useAi((s) => s.settings);
  const pull = useAi((s) => s.pull);
  const [door, setDoor] = useState<Door>(() => {
    const p = settings.activeProvider;
    if (pull) return "local";
    if (!p) return "codex";
    return "settings";
  });

  useEffect(() => {
    void refreshDetection();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const doors: { id: Door; label: string; hidden?: boolean }[] = [
    { id: "codex", label: "Codex (abonnement ChatGPT)" },
    { id: "key", label: "Clé API" },
    {
      id: "local",
      label: pull
        ? `Modèle local · ${pull.ratio != null ? `${Math.round(pull.ratio * 100)} %` : "téléchargement…"}`
        : "Modèle local",
    },
    { id: "settings", label: "Réglages", hidden: !settings.activeProvider },
  ];

  return (
    <div
      className="pdf-modal-backdrop"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="pdf-modal ai-setup">
        <div className="pdf-modal-head">
          <h2>Assistant IA</h2>
        </div>
        <div className="ai-doors">
          {doors
            .filter((d) => !d.hidden)
            .map((d) => (
              <button
                key={d.id}
                type="button"
                className={door === d.id ? "on" : ""}
                onClick={() => setDoor(d.id)}
              >
                {d.label}
              </button>
            ))}
        </div>
        <div className="pdf-modal-body">
          {door === "codex" && <CodexDoor />}
          {door === "key" && <KeyDoor />}
          {door === "local" && <LocalDoor />}
          {door === "settings" && <SettingsDoor onClose={onClose} />}
        </div>
        <div className="pdf-modal-foot">
          <button type="button" className="pdf-btn" onClick={onClose}>
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
}
