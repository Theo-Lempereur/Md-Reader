//! Trait fournisseur, routage par identifiant et utilitaires communs
//! (annulation, parseur SSE, client HTTP).

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::AppHandle;
use tokio::sync::Notify;

use super::{ChatRequest, StreamEvent, Usage};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Destination des événements de flux (un `Channel` Tauri, ou un collecteur
/// local pour la mesure de performance).
pub type Sink = Arc<dyn Fn(StreamEvent) + Send + Sync>;

#[derive(Clone, Copy, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Caps {
    pub vision: bool,
    pub streaming: bool,
    pub edit: bool,
    pub complete: bool,
}

pub trait Provider: Send + Sync {
    /// Diffuse la réponse dans `out`. Renvoie l'usage si le fournisseur le
    /// communique. Ne doit PAS émettre `Done` : l'appelant s'en charge.
    fn chat<'a>(
        &'a self,
        req: ChatRequest,
        out: Sink,
        cancel: CancelToken,
    ) -> BoxFuture<'a, Result<Option<Usage>, String>>;

    fn list_models<'a>(&'a self) -> BoxFuture<'a, Result<Vec<String>, String>>;

    #[allow(dead_code)]
    fn capabilities(&self) -> Caps;
}

/* ------------------------------------------------------------------ */
/* Annulation                                                          */
/* ------------------------------------------------------------------ */

#[derive(Clone, Default)]
pub struct CancelToken(Arc<(AtomicBool, Notify)>);

impl CancelToken {
    pub fn cancel(&self) {
        self.0 .0.store(true, Ordering::SeqCst);
        self.0 .1.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.0 .0.load(Ordering::SeqCst)
    }

    /// Se résout dès que `cancel()` a été appelé (même avant l'attente).
    pub async fn cancelled(&self) {
        loop {
            let notified = self.0 .1.notified();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}

/* ------------------------------------------------------------------ */
/* Identifiants et URL par défaut                                      */
/* ------------------------------------------------------------------ */

pub const OPENAI_COMPATIBLE: &[&str] = &["openai", "mistral", "openrouter", "ollama", "lmstudio"];
pub const KEYED_PROVIDERS: &[&str] = &["openai", "mistral", "openrouter", "anthropic"];

pub fn default_base_url(provider: &str) -> Option<&'static str> {
    Some(match provider {
        "openai" => "https://api.openai.com/v1",
        "mistral" => "https://api.mistral.ai/v1",
        "openrouter" => "https://openrouter.ai/api/v1",
        "ollama" => "http://127.0.0.1:11434/v1",
        "lmstudio" => "http://127.0.0.1:1234/v1",
        "anthropic" => "https://api.anthropic.com",
        _ => return None,
    })
}

fn base_url_for(app: &AppHandle, provider: &str) -> Result<String, String> {
    let custom = super::state::read_json(app, super::state::SETTINGS_FILE)
        .ok()
        .flatten()
        .and_then(|s| {
            s.get("baseUrls")?
                .get(provider)?
                .as_str()
                .map(|v| v.trim().trim_end_matches('/').to_string())
        })
        .filter(|v| !v.is_empty());
    match custom {
        Some(url) => Ok(url),
        None => default_base_url(provider)
            .map(str::to_string)
            .ok_or_else(|| format!("Fournisseur inconnu : {provider}")),
    }
}

/// Construit le fournisseur demandé. La clé est lue dans le trousseau à
/// chaque requête : elle ne vit jamais plus longtemps que nécessaire.
pub fn resolve(app: &AppHandle, provider: &str) -> Result<Box<dyn Provider>, String> {
    if provider == "codex" {
        let state = super::state::get(app);
        return Ok(Box::new(super::codex::CodexProvider::new(
            state.codex.clone(),
        )));
    }
    let base_url = base_url_for(app, provider)?;
    let key = super::keys::get(provider)?;
    if KEYED_PROVIDERS.contains(&provider) && key.is_none() {
        return Err(format!(
            "Aucune clé API enregistrée pour « {provider} ». Ajoutez-la dans les réglages de l'assistant."
        ));
    }
    match provider {
        "anthropic" => Ok(Box::new(super::anthropic::AnthropicProvider::new(
            base_url,
            key.unwrap_or_default(),
        ))),
        p if OPENAI_COMPATIBLE.contains(&p) => Ok(Box::new(
            super::openai::OpenAiProvider::new(p.to_string(), base_url, key),
        )),
        _ => Err(format!("Fournisseur inconnu : {provider}")),
    }
}

pub async fn list_models(app: &AppHandle, provider: &str) -> Result<Vec<String>, String> {
    let p = resolve(app, provider)?;
    let mut models = p.list_models().await?;
    models.sort();
    models.dedup();
    Ok(models)
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .user_agent(concat!("Md-Reader/", env!("CARGO_PKG_VERSION")))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// Extrait un message d'erreur lisible d'une réponse HTTP en échec.
pub async fn http_error(resp: reqwest::Response) -> String {
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let detail = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| {
            v.pointer("/error/message")
                .or_else(|| v.get("message"))
                .or_else(|| v.get("error"))
                .and_then(|m| m.as_str().map(str::to_string))
        })
        .unwrap_or_else(|| body.chars().take(300).collect());
    let hint = match status.as_u16() {
        401 | 403 => " (clé API refusée)",
        404 => " (modèle ou adresse introuvable)",
        429 => " (limite de débit atteinte, réessayez plus tard)",
        _ => "",
    };
    format!("HTTP {}{} : {}", status.as_u16(), hint, detail.trim())
}

/* ------------------------------------------------------------------ */
/* Server-Sent Events                                                  */
/* ------------------------------------------------------------------ */

#[derive(Debug, Default)]
pub struct SseEvent {
    /// Champ `event:` (non utilisé par les fournisseurs actuels, qui répètent
    /// le type dans les données, mais conservé pour un parseur complet).
    #[allow(dead_code)]
    pub event: Option<String>,
    pub data: String,
}

/// Parseur SSE incrémental, tolérant aux coupures de paquets au milieu d'un
/// caractère UTF-8 (on ne découpe que sur `\n`).
#[derive(Default)]
pub struct SseParser {
    buf: Vec<u8>,
    event: Option<String>,
    data: Vec<String>,
}

impl SseParser {
    pub fn push(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
            let raw: Vec<u8> = self.buf.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&raw);
            let line = line.trim_end_matches(['\n', '\r']);
            if line.is_empty() {
                if !self.data.is_empty() || self.event.is_some() {
                    out.push(SseEvent {
                        event: self.event.take(),
                        data: std::mem::take(&mut self.data).join("\n"),
                    });
                }
                continue;
            }
            if line.starts_with(':') {
                continue;
            }
            let (field, value) = match line.split_once(':') {
                Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
                None => (line, ""),
            };
            match field {
                "event" => self.event = Some(value.to_string()),
                "data" => self.data.push(value.to_string()),
                _ => {}
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::SseParser;

    #[test]
    fn sse_parser_handles_split_chunks() {
        let mut p = SseParser::default();
        assert!(p.push(b"event: a\ndata: {\"x\"").is_empty());
        let evs = p.push(b":1}\n\ndata: [DONE]\n\n");
        assert_eq!(evs.len(), 2);
        assert_eq!(evs[0].event.as_deref(), Some("a"));
        assert_eq!(evs[0].data, "{\"x\":1}");
        assert_eq!(evs[1].data, "[DONE]");
    }

    #[test]
    fn sse_parser_keeps_utf8_across_chunks() {
        let mut p = SseParser::default();
        let bytes = "data: é\n\n".as_bytes();
        assert!(p.push(&bytes[..7]).is_empty());
        let evs = p.push(&bytes[7..]);
        assert_eq!(evs[0].data, "é");
    }
}
