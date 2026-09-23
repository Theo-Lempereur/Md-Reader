//! API Messages d'Anthropic, en HTTP brut + SSE (pas de SDK Rust officiel).

use futures_util::StreamExt;
use serde_json::{json, Value};

use super::provider::{
    http_client, http_error, BoxFuture, CancelToken, Caps, Provider, Sink, SseParser,
};
use super::{ChatMode, ChatRequest, StreamEvent, Usage};

const API_VERSION: &str = "2023-06-01";
pub const DEFAULT_MODEL: &str = "claude-opus-5";
/// Repli côté serveur en cas de refus (modèles qui le prennent en charge).
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";

pub struct AnthropicProvider {
    base_url: String,
    key: String,
    client: reqwest::Client,
}

/// Modèles récents : réflexion adaptive et `effort` ; `temperature` et
/// `budget_tokens` y sont refusés.
fn is_adaptive_model(model: &str) -> bool {
    [
        "opus-5", "fable-5", "mythos-5", "sonnet-5", "opus-4-8", "opus-4-7", "opus-4-6",
        "sonnet-4-6",
    ]
    .iter()
    .any(|m| model.contains(m))
}

fn supports_fallbacks(model: &str) -> bool {
    model == "claude-opus-5" || model == "claude-fable-5-1"
}

impl AnthropicProvider {
    pub fn new(base_url: String, key: String) -> Self {
        Self {
            base_url,
            key,
            client: http_client(),
        }
    }

    fn build_body(&self, req: &ChatRequest, model: &str) -> Value {
        let messages: Vec<Value> = req
            .messages
            .iter()
            .map(|m| {
                let role = if m.role == "assistant" { "assistant" } else { "user" };
                let mut content = Vec::new();
                if role == "user" {
                    for img in &m.images {
                        content.push(json!({
                            "type": "image",
                            "source": { "type": "base64", "media_type": img.mime, "data": img.data }
                        }));
                    }
                }
                content.push(json!({ "type": "text", "text": m.content }));
                json!({ "role": role, "content": content })
            })
            .collect();

        let max_tokens = req.max_tokens.unwrap_or(match req.mode {
            ChatMode::Complete => 256,
            _ => 64000,
        });
        let mut body = json!({
            "model": model,
            "max_tokens": max_tokens,
            "messages": messages,
            "stream": true,
        });
        if let Some(system) = req.system.as_deref().filter(|s| !s.trim().is_empty()) {
            body["system"] = json!(system);
        }
        if !req.stop.is_empty() {
            body["stop_sequences"] = json!(req.stop);
        }
        if is_adaptive_model(model) {
            if req.mode == ChatMode::Complete {
                // Autocomplétion : latence minimale.
                body["output_config"] = json!({ "effort": "low" });
            } else {
                body["thinking"] = json!({ "type": "adaptive", "display": "summarized" });
            }
        }
        if supports_fallbacks(model) {
            body["fallbacks"] = json!("default");
        }
        body
    }
}

impl Provider for AnthropicProvider {
    fn chat<'a>(
        &'a self,
        req: ChatRequest,
        out: Sink,
        cancel: CancelToken,
    ) -> BoxFuture<'a, Result<Option<Usage>, String>> {
        Box::pin(async move {
            let model = if req.model.trim().is_empty() {
                DEFAULT_MODEL.to_string()
            } else {
                req.model.clone()
            };
            let body = self.build_body(&req, &model);
            let mut rb = self
                .client
                .post(format!("{}/v1/messages", self.base_url))
                .header("x-api-key", &self.key)
                .header("anthropic-version", API_VERSION)
                .json(&body);
            if supports_fallbacks(&model) {
                rb = rb.header("anthropic-beta", FALLBACK_BETA);
            }
            let resp = tokio::select! {
                _ = cancel.cancelled() => return Ok(None),
                r = rb.send() => r.map_err(|e| format!("Connexion impossible : {e}"))?,
            };
            if !resp.status().is_success() {
                return Err(http_error(resp).await);
            }

            let mut usage = Usage::default();
            let mut parser = SseParser::default();
            let mut stream = resp.bytes_stream();
            loop {
                let chunk = tokio::select! {
                    _ = cancel.cancelled() => return Ok(Some(usage)),
                    c = stream.next() => c,
                };
                let Some(chunk) = chunk else { break };
                let chunk = chunk.map_err(|e| format!("Flux interrompu : {e}"))?;
                for ev in parser.push(&chunk) {
                    let Ok(v) = serde_json::from_str::<Value>(&ev.data) else {
                        continue;
                    };
                    match v.get("type").and_then(Value::as_str).unwrap_or_default() {
                        "message_start" => {
                            usage.input_tokens =
                                v.pointer("/message/usage/input_tokens").and_then(Value::as_u64);
                        }
                        "content_block_delta" => {
                            let delta = &v["delta"];
                            match delta.get("type").and_then(Value::as_str) {
                                Some("text_delta") => {
                                    if let Some(t) = delta.get("text").and_then(Value::as_str) {
                                        out(StreamEvent::Delta { text: t.to_string() });
                                    }
                                }
                                Some("thinking_delta") => {
                                    if let Some(t) = delta.get("thinking").and_then(Value::as_str) {
                                        if !t.is_empty() {
                                            out(StreamEvent::Reasoning { text: t.to_string() });
                                        }
                                    }
                                }
                                _ => {}
                            }
                        }
                        "message_delta" => {
                            if let Some(n) =
                                v.pointer("/usage/output_tokens").and_then(Value::as_u64)
                            {
                                usage.output_tokens = Some(n);
                            }
                            if v.pointer("/delta/stop_reason").and_then(Value::as_str)
                                == Some("refusal")
                            {
                                return Err("Le modèle a refusé de traiter cette demande.".into());
                            }
                        }
                        "error" => {
                            let msg = v
                                .pointer("/error/message")
                                .and_then(Value::as_str)
                                .unwrap_or("Erreur inconnue");
                            return Err(msg.to_string());
                        }
                        "message_stop" => return Ok(Some(usage)),
                        _ => {}
                    }
                }
            }
            Ok(Some(usage))
        })
    }

    fn list_models<'a>(&'a self) -> BoxFuture<'a, Result<Vec<String>, String>> {
        Box::pin(async move {
            let resp = self
                .client
                .get(format!("{}/v1/models?limit=100", self.base_url))
                .header("x-api-key", &self.key)
                .header("anthropic-version", API_VERSION)
                .send()
                .await
                .map_err(|e| format!("Connexion impossible : {e}"))?;
            if !resp.status().is_success() {
                return Err(http_error(resp).await);
            }
            let v: Value = resp.json().await.map_err(|e| e.to_string())?;
            Ok(v.get("data")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(|m| m.get("id").and_then(Value::as_str).map(str::to_string))
                        .collect()
                })
                .unwrap_or_default())
        })
    }

    fn capabilities(&self) -> Caps {
        Caps {
            vision: true,
            streaming: true,
            edit: true,
            complete: true,
        }
    }
}
