//! État global du module : requêtes en cours (annulables), gestionnaire
//! Codex, fichiers de réglages, détection des fournisseurs.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use super::codex::CodexManager;
use super::provider::{self, CancelToken, Sink, KEYED_PROVIDERS};
use super::{keys, ChatMessage, ChatMode, ChatRequest, PullEvent, StreamEvent};

pub const SETTINGS_FILE: &str = "ai-settings.json";
pub const CONVERSATION_FILE: &str = "ai-conversation.json";

#[derive(Default)]
pub struct AiState {
    requests: Mutex<HashMap<String, CancelToken>>,
    pub codex: Arc<CodexManager>,
}

pub fn get(app: &AppHandle) -> tauri::State<'_, AiState> {
    app.state::<AiState>()
}

/// Supprime les dossiers de travail laissés par une session précédente
/// interrompue (plantage, arrêt forcé).
pub fn cleanup_workspaces() {
    let _ = std::fs::remove_dir_all(std::env::temp_dir().join("md-reader-ai"));
}

/* ------------------------------------------------------------------ */
/* Fichiers JSON (à côté de session.json)                              */
/* ------------------------------------------------------------------ */

fn config_path(app: &AppHandle, file: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app_config_dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create settings dir: {e}"))?;
    Ok(dir.join(file))
}

pub fn read_json(app: &AppHandle, file: &str) -> Result<Option<Value>, String> {
    let path = config_path(app, file)?;
    match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content)
            .map(Some)
            .map_err(|e| format!("{file} : {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{file} : {e}")),
    }
}

pub fn write_json(app: &AppHandle, file: &str, value: &Value) -> Result<(), String> {
    let path = config_path(app, file)?;
    let content = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    // Écriture atomique : un plantage en cours d'écriture ne corrompt pas le fichier.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, content).map_err(|e| format!("{file} : {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("{file} : {e}"))
}

/* ------------------------------------------------------------------ */
/* Statut et détection                                                 */
/* ------------------------------------------------------------------ */

pub async fn status(app: &AppHandle) -> Result<Value, String> {
    let settings = read_json(app, SETTINGS_FILE).unwrap_or(None);
    let keys: Vec<&str> = KEYED_PROVIDERS
        .iter()
        .copied()
        .filter(|p| keys::has(p))
        .collect();
    Ok(json!({ "compiled": true, "settings": settings, "keys": keys }))
}

fn local_base(app: &AppHandle, provider: &str) -> String {
    let custom = read_json(app, SETTINGS_FILE)
        .ok()
        .flatten()
        .and_then(|s| s.pointer(&format!("/baseUrls/{provider}"))?.as_str().map(str::to_string))
        .filter(|s| !s.trim().is_empty());
    let base = custom.unwrap_or_else(|| {
        provider::default_base_url(provider)
            .unwrap_or_default()
            .to_string()
    });
    base.trim_end_matches('/').trim_end_matches("/v1").to_string()
}

fn find_ollama() -> bool {
    let name = if cfg!(windows) { "ollama.exe" } else { "ollama" };
    if let Some(path) = std::env::var_os("PATH") {
        if std::env::split_paths(&path).any(|d| d.join(name).is_file()) {
            return true;
        }
    }
    std::env::var_os("LOCALAPPDATA")
        .map(|l| PathBuf::from(l).join("Programs/Ollama/ollama.exe").is_file())
        .unwrap_or(false)
}

async fn probe_ollama(app: &AppHandle) -> Value {
    let base = local_base(app, "ollama");
    let client = provider::http_client();
    let res = client
        .get(format!("{base}/api/tags"))
        .timeout(Duration::from_millis(1500))
        .send()
        .await;
    let installed = find_ollama();
    match res {
        Ok(r) if r.status().is_success() => {
            let v: Value = r.json().await.unwrap_or(Value::Null);
            let models: Vec<Value> = v
                .get("models")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .map(|m| json!({ "name": m["name"], "size": m["size"] }))
                        .collect()
                })
                .unwrap_or_default();
            json!({ "installed": true, "running": true, "models": models })
        }
        _ => json!({ "installed": installed, "running": false, "models": [] }),
    }
}

async fn probe_lmstudio(app: &AppHandle) -> Value {
    let base = local_base(app, "lmstudio");
    let res = provider::http_client()
        .get(format!("{base}/v1/models"))
        .timeout(Duration::from_millis(1500))
        .send()
        .await;
    match res {
        Ok(r) if r.status().is_success() => {
            let v: Value = r.json().await.unwrap_or(Value::Null);
            let models: Vec<Value> = v
                .get("data")
                .and_then(Value::as_array)
                .map(|arr| arr.iter().map(|m| json!({ "name": m["id"] })).collect())
                .unwrap_or_default();
            json!({ "running": true, "models": models })
        }
        _ => json!({ "running": false, "models": [] }),
    }
}

pub async fn detect(app: &AppHandle) -> Result<Value, String> {
    let (codex, ollama, lmstudio) =
        tokio::join!(super::codex::detect(), probe_ollama(app), probe_lmstudio(app));
    let keys: Vec<&str> = KEYED_PROVIDERS
        .iter()
        .copied()
        .filter(|p| keys::has(p))
        .collect();
    Ok(json!({ "codex": codex, "ollama": ollama, "lmstudio": lmstudio, "keys": keys }))
}

/* ------------------------------------------------------------------ */
/* Requêtes                                                            */
/* ------------------------------------------------------------------ */

fn register(app: &AppHandle, request_id: &str) -> CancelToken {
    let token = CancelToken::default();
    get(app)
        .requests
        .lock()
        .unwrap()
        .insert(request_id.to_string(), token.clone());
    token
}

fn unregister(app: &AppHandle, request_id: &str) {
    get(app).requests.lock().unwrap().remove(request_id);
}

pub fn cancel(app: &AppHandle, request_id: &str) {
    if let Some(token) = get(app).requests.lock().unwrap().remove(request_id) {
        token.cancel();
    }
}

pub fn start_chat(
    app: AppHandle,
    request_id: String,
    request: ChatRequest,
    channel: Channel<StreamEvent>,
) {
    let token = register(&app, &request_id);
    let sink: Sink = Arc::new(move |ev| {
        let _ = channel.send(ev);
    });
    tauri::async_runtime::spawn(async move {
        let res = match provider::resolve(&app, &request.provider) {
            Ok(p) => p.chat(request, sink.clone(), token.clone()).await,
            Err(e) => Err(e),
        };
        match res {
            Ok(usage) => sink(StreamEvent::Done {
                usage,
                cancelled: token.is_cancelled(),
            }),
            Err(_) if token.is_cancelled() => sink(StreamEvent::Done {
                usage: None,
                cancelled: true,
            }),
            Err(message) => sink(StreamEvent::Error { message }),
        }
        unregister(&app, &request_id);
    });
}

pub fn start_pull(app: AppHandle, request_id: String, model: String, channel: Channel<PullEvent>) {
    let token = register(&app, &request_id);
    tauri::async_runtime::spawn(async move {
        let res = pull(&app, &model, &channel, &token).await;
        let _ = channel.send(match res {
            Ok(()) => PullEvent::Done,
            Err(message) => PullEvent::Error { message },
        });
        unregister(&app, &request_id);
    });
}

async fn pull(
    app: &AppHandle,
    model: &str,
    channel: &Channel<PullEvent>,
    token: &CancelToken,
) -> Result<(), String> {
    let base = local_base(app, "ollama");
    let resp = provider::http_client()
        .post(format!("{base}/api/pull"))
        .json(&json!({ "model": model, "stream": true }))
        .send()
        .await
        .map_err(|_| "Ollama ne répond pas. Vérifiez qu'il est lancé.".to_string())?;
    if !resp.status().is_success() {
        return Err(provider::http_error(resp).await);
    }
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    loop {
        let chunk = tokio::select! {
            _ = token.cancelled() => return Err("Téléchargement annulé.".into()),
            c = stream.next() => c,
        };
        let Some(chunk) = chunk else { break };
        buf.extend_from_slice(&chunk.map_err(|e| e.to_string())?);
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            let Ok(v) = serde_json::from_slice::<Value>(&line) else {
                continue;
            };
            if let Some(err) = v.get("error").and_then(Value::as_str) {
                return Err(err.to_string());
            }
            let status = v.get("status").and_then(Value::as_str).unwrap_or_default();
            if status == "success" {
                return Ok(());
            }
            let _ = channel.send(PullEvent::Progress {
                status: status.to_string(),
                completed: v.get("completed").and_then(Value::as_u64),
                total: v.get("total").and_then(Value::as_u64),
            });
        }
    }
    Ok(())
}

/// Charge (`load`) ou libère un modèle Ollama en VRAM, via l'API native :
/// un prompt vide ne génère rien, `keep_alive: 0` décharge immédiatement.
/// Au chargement, la durée de maintien reste celle d'Ollama
/// (`OLLAMA_KEEP_ALIVE`, 5 min par défaut).
pub async fn ollama_residency(app: &AppHandle, model: &str, load: bool) -> Result<(), String> {
    let model = model.trim();
    if model.is_empty() {
        return Ok(());
    }
    let base = local_base(app, "ollama");
    let mut body = json!({ "model": model, "prompt": "", "stream": false });
    if !load {
        body["keep_alive"] = json!(0);
    }
    let resp = provider::http_client()
        .post(format!("{base}/api/generate"))
        .json(&body)
        // Un gros modèle peut mettre longtemps à monter en VRAM.
        .timeout(Duration::from_secs(if load { 180 } else { 15 }))
        .send()
        .await
        .map_err(|e| format!("Ollama ne répond pas : {e}"))?;
    if !resp.status().is_success() {
        return Err(provider::http_error(resp).await);
    }
    Ok(())
}

/// Mesure réelle : un tour de chauffe (chargement du modèle), puis un prompt
/// étalon dont on chronomètre le premier token et le débit.
pub async fn benchmark(app: &AppHandle, provider_id: &str, model: &str) -> Result<Value, String> {
    let p = provider::resolve(app, provider_id)?;
    // `raw` : même chemin que l'autocomplétion réelle (continuation brute).
    let make_req = |prompt: &str, raw: &str, max: u32| ChatRequest {
        provider: provider_id.to_string(),
        model: model.to_string(),
        system: None,
        messages: vec![ChatMessage {
            role: "user".into(),
            content: prompt.to_string(),
            images: Vec::new(),
        }],
        conversation_id: None,
        mode: ChatMode::Complete,
        document: None,
        max_tokens: Some(max),
        stop: Vec::new(),
        raw_prefix: Some(raw.to_string()),
    };

    let warm_start = Instant::now();
    let noop: Sink = Arc::new(|_| {});
    p.chat(make_req("Bonjour", "Bonjour", 1), noop, CancelToken::default())
        .await?;
    let warmup_ms = warm_start.elapsed().as_millis() as u64;

    #[derive(Default)]
    struct Probe {
        first: Option<Instant>,
        chars: usize,
    }
    let probe = Arc::new(Mutex::new(Probe::default()));
    let probe_sink = probe.clone();
    let sink: Sink = Arc::new(move |ev| {
        if let StreamEvent::Delta { text } = ev {
            let mut p = probe_sink.lock().unwrap();
            p.first.get_or_insert_with(Instant::now);
            p.chars += text.chars().count();
        }
    });
    let start = Instant::now();
    let usage = p
        .chat(
            make_req(
                "Écris un paragraphe de quatre phrases sur le plaisir de la lecture.",
                "Le plaisir de la lecture tient d'abord à",
                160,
            ),
            sink,
            CancelToken::default(),
        )
        .await?;
    let end = Instant::now();
    let probe = probe.lock().unwrap();
    let first = probe.first.ok_or("Le modèle n'a renvoyé aucun texte.")?;
    let ttft_ms = first.duration_since(start).as_millis() as u64;
    let tokens = usage
        .and_then(|u| u.output_tokens)
        .unwrap_or((probe.chars / 4).max(1) as u64);
    let gen_secs = end.duration_since(first).as_secs_f64().max(0.001);
    Ok(json!({
        "ttftMs": ttft_ms,
        "tokensPerSec": (tokens as f64 / gen_secs * 10.0).round() / 10.0,
        "outputTokens": tokens,
        "warmupMs": warmup_ms,
    }))
}
