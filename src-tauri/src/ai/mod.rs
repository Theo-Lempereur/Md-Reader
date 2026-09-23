//! Module IA optionnel.
//!
//! Inerte par défaut : rien ne part sur le réseau tant qu'aucun fournisseur
//! n'est configuré, et sans la feature Cargo `ai` toutes les commandes
//! renvoient `unsupported`. Tout le réseau passe par Rust : les clés API
//! restent dans le Gestionnaire d'identification Windows et ne transitent
//! jamais par le webview.
//!
//! Les commandes sont déclarées une seule fois ici (mêmes signatures avec ou
//! sans la feature) pour que `generate_handler!` reste inchangé.

// Sans la feature, les types partagés ne sont que désérialisés puis ignorés.
#![cfg_attr(not(feature = "ai"), allow(dead_code))]

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::AppHandle;

#[cfg(feature = "ai")]
mod anthropic;
#[cfg(feature = "ai")]
mod catalog;
#[cfg(feature = "ai")]
mod codex;
#[cfg(feature = "ai")]
mod context;
#[cfg(feature = "ai")]
mod hardware;
#[cfg(feature = "ai")]
mod keys;
#[cfg(feature = "ai")]
mod openai;
#[cfg(feature = "ai")]
mod provider;
#[cfg(feature = "ai")]
mod state;
#[cfg(feature = "ai")]
mod workspace;

#[cfg(not(feature = "ai"))]
const UNSUPPORTED: &str = "unsupported";

/* ------------------------------------------------------------------ */
/* Types partagés avec le front (serde uniquement, toujours compilés)  */
/* ------------------------------------------------------------------ */

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImagePart {
    pub mime: String,
    /// Contenu base64, sans préfixe `data:`.
    pub data: String,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    /// `user` | `assistant`.
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub images: Vec<ImagePart>,
}

#[derive(Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ChatMode {
    #[default]
    Chat,
    /// Réécriture d'un document : la réponse est un nouveau markdown.
    Edit,
    /// Autocomplétion : réponse courte, pas de raisonnement.
    Complete,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EditDocument {
    pub name: String,
    pub content: String,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub provider: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub system: Option<String>,
    pub messages: Vec<ChatMessage>,
    /// Identifiant de conversation côté front (une session Codex par conversation).
    #[serde(default)]
    pub conversation_id: Option<String>,
    #[serde(default)]
    pub mode: ChatMode,
    /// Document à modifier (mode `edit`, utilisé par Codex qui travaille sur fichier).
    #[serde(default)]
    pub document: Option<EditDocument>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub stop: Vec<String>,
    /// Autocomplétion : texte brut à prolonger. Ollama l'utilise à la place de
    /// `messages` (continuation sans gabarit de chat, voir `openai.rs`).
    #[serde(default)]
    pub raw_prefix: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum StreamEvent {
    Delta { text: String },
    Reasoning { text: String },
    ToolStart { label: String },
    /// Contenu final du document (Codex en mode édition).
    EditResult { content: String },
    Done { usage: Option<Usage>, cancelled: bool },
    Error { message: String },
}

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum PullEvent {
    Progress { status: String, completed: Option<u64>, total: Option<u64> },
    Done,
    Error { message: String },
}

/* ------------------------------------------------------------------ */
/* Initialisation                                                     */
/* ------------------------------------------------------------------ */

/// Enregistre l'état du module (aucun effet de bord réseau).
pub fn init(app: &tauri::App) {
    #[cfg(feature = "ai")]
    {
        use tauri::Manager;
        state::cleanup_workspaces();
        app.manage(state::AiState::default());
    }
    #[cfg(not(feature = "ai"))]
    let _ = app;
}

/* ------------------------------------------------------------------ */
/* Commandes                                                          */
/* ------------------------------------------------------------------ */

/// État local uniquement (fichier de réglages + présence des clés) :
/// aucune requête réseau, appelé au lancement.
#[tauri::command]
pub async fn ai_status(app: AppHandle) -> Result<serde_json::Value, String> {
    #[cfg(feature = "ai")]
    {
        state::status(&app).await
    }
    #[cfg(not(feature = "ai"))]
    {
        let _ = app;
        Ok(serde_json::json!({ "compiled": false }))
    }
}

/// Détection parallèle des fournisseurs disponibles (Codex, Ollama,
/// LM Studio, clés enregistrées). Uniquement sur demande de l'utilisateur
/// ou quand un fournisseur est déjà configuré.
#[tauri::command]
pub async fn ai_detect_providers(app: AppHandle) -> Result<serde_json::Value, String> {
    #[cfg(feature = "ai")]
    {
        state::detect(&app).await
    }
    #[cfg(not(feature = "ai"))]
    {
        let _ = app;
        Err(UNSUPPORTED.into())
    }
}

#[tauri::command]
pub async fn ai_save_key(provider: String, key: String) -> Result<(), String> {
    #[cfg(feature = "ai")]
    {
        keys::save(&provider, &key)
    }
    #[cfg(not(feature = "ai"))]
    {
        let _ = (provider, key);
        Err(UNSUPPORTED.into())
    }
}

#[tauri::command]
pub async fn ai_delete_key(provider: String) -> Result<(), String> {
    #[cfg(feature = "ai")]
    {
        keys::delete(&provider)
    }
    #[cfg(not(feature = "ai"))]
    {
        let _ = provider;
        Err(UNSUPPORTED.into())
    }
}

#[tauri::command]
pub async fn ai_settings_get(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    #[cfg(feature = "ai")]
    {
        state::read_json(&app, state::SETTINGS_FILE)
    }
    #[cfg(not(feature = "ai"))]
    {
        let _ = app;
        Err(UNSUPPORTED.into())
    }
}

#[tauri::command]
pub async fn ai_settings_set(app: AppHandle, settings: serde_json::Value) -> Result<(), String> {
    #[cfg(feature = "ai")]
    {
        state::write_json(&app, state::SETTINGS_FILE, &settings)
    }
    #[cfg(not(feature = "ai"))]
    {
        let _ = (app, settings);
        Err(UNSUPPORTED.into())
    }
}

/// Dernière conversation, persistée pour survivre à un redémarrage.
#[tauri::command]
pub async fn ai_conversation_get(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    #[cfg(feature = "ai")]
    {
        state::read_json(&app, state::CONVERSATION_FILE)
    }
    #[cfg(not(feature = "ai"))]
    {
        let _ = app;
        Err(UNSUPPORTED.into())
    }
}

#[tauri::command]
pub async fn ai_conversation_set(
    app: AppHandle,
    conversation: serde_json::Value,
) -> Result<(), String> {
    #[cfg(feature = "ai")]
    {
        state::write_json(&app, state::CONVERSATION_FILE, &conversation)
    }
    #[cfg(not(feature = "ai"))]
    {
        let _ = (app, conversation);
        Err(UNSUPPORTED.into())
    }
}

#[tauri::command]
pub async fn ai_list_models(app: AppHandle, provider: String) -> Result<Vec<String>, String> {
    #[cfg(feature = "ai")]
    {
        provider::list_models(&app, &provider).await
    }
    #[cfg(not(feature = "ai"))]
    {
        let _ = (app, provider);
        Err(UNSUPPORTED.into())
    }
}

/// Lance une requête en streaming. Les événements arrivent sur `on_event` ;
/// la commande rend la main immédiatement, l'annulation passe par `ai_cancel`.
#[tauri::command]
pub async fn ai_chat(
    app: AppHandle,
    request_id: String,
    request: ChatRequest,
    on_event: Channel<StreamEvent>,
) -> Result<(), String> {
    #[cfg(feature = "ai")]
    {
        state::start_chat(app, request_id, request, on_event);
        Ok(())
    }
    #[cfg(not(feature = "ai"))]
    {
        let _ = (app, request_id, request, on_event);
        Err(UNSUPPORTED.into())
    }
}

#[tauri::command]
pub async fn ai_cancel(app: AppHandle, request_id: String) -> Result<(), String> {
    #[cfg(feature = "ai")]
    {
        state::cancel(&app, &request_id);
        Ok(())
    }
    #[cfg(not(feature = "ai"))]
    {
        let _ = (app, request_id);
        Err(UNSUPPORTED.into())
    }
}

/// Lit un fichier ou parcourt un dossier pour le joindre au contexte.
#[tauri::command]
pub async fn ai_read_context_path(path: String) -> Result<serde_json::Value, String> {
    #[cfg(feature = "ai")]
    {
        tokio::task::spawn_blocking(move || context::read_path(&path))
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(not(feature = "ai"))]
    {
        let _ = path;
        Err(UNSUPPORTED.into())
    }
}

#[tauri::command]
pub async fn ai_hardware_scan(app: AppHandle) -> Result<serde_json::Value, String> {
    #[cfg(feature = "ai")]
    {
        tokio::task::spawn_blocking(move || hardware::scan(&app))
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(not(feature = "ai"))]
    {
        let _ = app;
        Err(UNSUPPORTED.into())
    }
}

#[tauri::command]
pub async fn ai_catalog() -> Result<serde_json::Value, String> {
    #[cfg(feature = "ai")]
    {
        catalog::catalog()
    }
    #[cfg(not(feature = "ai"))]
    {
        Err(UNSUPPORTED.into())
    }
}

/// `ollama pull` avec progression (flux de `/api/pull`).
#[tauri::command]
pub async fn ai_ollama_pull(
    app: AppHandle,
    request_id: String,
    model: String,
    on_event: Channel<PullEvent>,
) -> Result<(), String> {
    #[cfg(feature = "ai")]
    {
        state::start_pull(app, request_id, model, on_event);
        Ok(())
    }
    #[cfg(not(feature = "ai"))]
    {
        let _ = (app, request_id, model, on_event);
        Err(UNSUPPORTED.into())
    }
}

/// Précharge (`load = true`) ou libère un modèle Ollama en VRAM.
#[tauri::command]
pub async fn ai_ollama_residency(app: AppHandle, model: String, load: bool) -> Result<(), String> {
    #[cfg(feature = "ai")]
    {
        state::ollama_residency(&app, &model, load).await
    }
    #[cfg(not(feature = "ai"))]
    {
        let _ = (app, model, load);
        Err(UNSUPPORTED.into())
    }
}

/// Mesure réelle : temps jusqu'au premier token et débit.
#[tauri::command]
pub async fn ai_benchmark(
    app: AppHandle,
    provider: String,
    model: String,
) -> Result<serde_json::Value, String> {
    #[cfg(feature = "ai")]
    {
        state::benchmark(&app, &provider, &model).await
    }
    #[cfg(not(feature = "ai"))]
    {
        let _ = (app, provider, model);
        Err(UNSUPPORTED.into())
    }
}

/// Contrat JSON avec le front (`src/ai/types.ts`) : un renommage d'un côté
/// sans l'autre casserait le module silencieusement.
#[cfg(test)]
mod contract_tests {
    use super::*;

    #[test]
    fn chat_request_matches_front_payload() {
        let req: ChatRequest = serde_json::from_value(serde_json::json!({
            "provider": "anthropic",
            "model": "claude-opus-5",
            "system": "contexte",
            "messages": [
                { "role": "user", "content": "Bonjour", "images": [{ "mime": "image/png", "data": "AAAA" }] },
                { "role": "assistant", "content": "Salut" }
            ],
            "conversationId": "c1",
            "mode": "edit",
            "document": { "name": "a.md", "content": "# A\n" },
            "maxTokens": 48,
            "stop": ["\n\n"],
            "rawPrefix": "Il était une"
        }))
        .unwrap();
        assert_eq!(req.mode, ChatMode::Edit);
        assert_eq!(req.conversation_id.as_deref(), Some("c1"));
        assert_eq!(req.max_tokens, Some(48));
        assert_eq!(req.raw_prefix.as_deref(), Some("Il était une"));
        assert_eq!(req.messages[0].images.len(), 1);
        assert!(req.messages[1].images.is_empty());
        assert_eq!(req.document.unwrap().name, "a.md");

        let minimal: ChatRequest = serde_json::from_value(serde_json::json!({
            "provider": "ollama",
            "model": "qwen3:8b",
            "messages": [{ "role": "user", "content": "x" }],
            "mode": "complete"
        }))
        .unwrap();
        assert_eq!(minimal.mode, ChatMode::Complete);
        assert!(minimal.stop.is_empty());
    }

    #[test]
    fn stream_events_match_front_union() {
        let v = |e: StreamEvent| serde_json::to_value(e).unwrap();
        assert_eq!(v(StreamEvent::Delta { text: "a".into() }), serde_json::json!({ "type": "delta", "text": "a" }));
        assert_eq!(
            v(StreamEvent::ToolStart { label: "x".into() }),
            serde_json::json!({ "type": "toolStart", "label": "x" })
        );
        assert_eq!(
            v(StreamEvent::EditResult { content: "c".into() }),
            serde_json::json!({ "type": "editResult", "content": "c" })
        );
        assert_eq!(
            v(StreamEvent::Done {
                usage: Some(Usage { input_tokens: Some(1), output_tokens: Some(2) }),
                cancelled: false
            }),
            serde_json::json!({ "type": "done", "usage": { "inputTokens": 1, "outputTokens": 2 }, "cancelled": false })
        );
        assert_eq!(
            serde_json::to_value(PullEvent::Progress { status: "s".into(), completed: Some(1), total: Some(2) }).unwrap(),
            serde_json::json!({ "type": "progress", "status": "s", "completed": 1, "total": 2 })
        );
    }
}
