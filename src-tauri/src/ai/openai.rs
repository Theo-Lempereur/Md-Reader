//! Format `/v1/chat/completions` : OpenAI, Mistral, OpenRouter, Ollama et
//! LM Studio. Seuls l'URL de base et l'en-tête d'authentification changent.

use futures_util::StreamExt;
use serde_json::{json, Value};

use super::provider::{
    http_client, http_error, BoxFuture, CancelToken, Caps, Provider, Sink, SseParser,
};
use super::{ChatMode, ChatRequest, StreamEvent, Usage};

pub struct OpenAiProvider {
    id: String,
    base_url: String,
    key: Option<String>,
    client: reqwest::Client,
}

impl OpenAiProvider {
    pub fn new(id: String, base_url: String, key: Option<String>) -> Self {
        Self {
            id,
            base_url,
            key,
            client: http_client(),
        }
    }

    fn request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        let mut rb = self
            .client
            .request(method, format!("{}{}", self.base_url, path));
        if let Some(key) = &self.key {
            rb = rb.bearer_auth(key);
        }
        if self.id == "openrouter" {
            rb = rb
                .header("HTTP-Referer", "https://github.com/Theo-Lempereur/Md-Reader")
                .header("X-Title", "Md-Reader");
        }
        rb
    }

    fn build_body(&self, req: &ChatRequest) -> Value {
        let mut messages = Vec::new();
        if let Some(system) = req.system.as_deref().filter(|s| !s.trim().is_empty()) {
            messages.push(json!({ "role": "system", "content": system }));
        }
        for m in &req.messages {
            let role = if m.role == "assistant" { "assistant" } else { "user" };
            if m.images.is_empty() || role == "assistant" {
                messages.push(json!({ "role": role, "content": m.content }));
            } else {
                let mut parts = vec![json!({ "type": "text", "text": m.content })];
                for img in &m.images {
                    parts.push(json!({
                        "type": "image_url",
                        "image_url": { "url": format!("data:{};base64,{}", img.mime, img.data) }
                    }));
                }
                messages.push(json!({ "role": role, "content": parts }));
            }
        }

        let mut body = json!({
            "model": req.model,
            "messages": messages,
            "stream": true,
        });
        if let Some(max) = req.max_tokens {
            // Les modèles récents d'OpenAI refusent `max_tokens`.
            let field = if self.id == "openai" { "max_completion_tokens" } else { "max_tokens" };
            body[field] = json!(max);
        }
        if !req.stop.is_empty() {
            body["stop"] = json!(req.stop.iter().take(4).collect::<Vec<_>>());
        }
        if req.mode == ChatMode::Complete && self.id != "openai" {
            body["temperature"] = json!(0.2);
        }
        // Repli si l'autocomplétion arrive sans `raw_prefix` (voir
        // `generate_raw`) : sans cela, un modèle à réflexion (qwen3…) dépense
        // tout le budget à raisonner et la suggestion reste vide. Ignoré par les
        // modèles sans réflexion (Ollama 0.34).
        if req.mode == ChatMode::Complete && self.id == "ollama" {
            body["reasoning_effort"] = json!("none");
        }
        if self.id == "openai" || self.id == "openrouter" {
            body["stream_options"] = json!({ "include_usage": true });
        }
        body
    }

    /// Autocomplétion Ollama : continuation brute via l'API native
    /// (`/api/generate`, `raw`). Sans gabarit de chat, un petit modèle prolonge
    /// le texte au lieu de le réécrire ou de le commenter, et un modèle à
    /// réflexion (qwen3…) répond directement (mesuré : 40 à 130 ms).
    async fn generate_raw(
        &self,
        req: &ChatRequest,
        prefix: &str,
        out: Sink,
        cancel: CancelToken,
    ) -> Result<Option<Usage>, String> {
        let native = self.base_url.trim_end_matches('/').trim_end_matches("/v1");
        let mut options = json!({ "temperature": 0.2 });
        if let Some(max) = req.max_tokens {
            options["num_predict"] = json!(max);
        }
        if !req.stop.is_empty() {
            options["stop"] = json!(req.stop.iter().take(4).collect::<Vec<_>>());
        }
        let body = json!({
            "model": req.model,
            "prompt": prefix,
            "raw": true,
            "stream": true,
            "options": options,
        });
        let send = self
            .client
            .post(format!("{native}/api/generate"))
            .json(&body)
            .send();
        let resp = tokio::select! {
            _ = cancel.cancelled() => return Ok(None),
            r = send => r.map_err(|e| connection_error(&self.id, e))?,
        };
        if !resp.status().is_success() {
            return Err(http_error(resp).await);
        }

        // Flux NDJSON : un objet par ligne.
        let mut buf: Vec<u8> = Vec::new();
        let mut stream = resp.bytes_stream();
        loop {
            let chunk = tokio::select! {
                _ = cancel.cancelled() => return Ok(None),
                c = stream.next() => c,
            };
            let Some(chunk) = chunk else { return Ok(None) };
            buf.extend_from_slice(&chunk.map_err(|e| format!("Flux interrompu : {e}"))?);
            while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
                let line: Vec<u8> = buf.drain(..=pos).collect();
                let Ok(v) = serde_json::from_slice::<Value>(&line) else {
                    continue;
                };
                if let Some(err) = v.get("error").and_then(Value::as_str) {
                    return Err(err.to_string());
                }
                if let Some(text) = v.get("response").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                    out(StreamEvent::Delta { text: text.to_string() });
                }
                if v.get("done").and_then(Value::as_bool) == Some(true) {
                    return Ok(Some(Usage {
                        input_tokens: v.get("prompt_eval_count").and_then(Value::as_u64),
                        output_tokens: v.get("eval_count").and_then(Value::as_u64),
                    }));
                }
            }
        }
    }
}

impl Provider for OpenAiProvider {
    fn chat<'a>(
        &'a self,
        req: ChatRequest,
        out: Sink,
        cancel: CancelToken,
    ) -> BoxFuture<'a, Result<Option<Usage>, String>> {
        Box::pin(async move {
            if req.model.trim().is_empty() {
                return Err("Aucun modèle sélectionné.".into());
            }
            if self.id == "ollama" && req.mode == ChatMode::Complete {
                if let Some(prefix) = req.raw_prefix.as_deref().filter(|p| !p.trim().is_empty()) {
                    return self.generate_raw(&req, prefix, out, cancel).await;
                }
            }
            let body = self.build_body(&req);
            let send = self
                .request(reqwest::Method::POST, "/chat/completions")
                .json(&body)
                .send();
            let resp = tokio::select! {
                _ = cancel.cancelled() => return Ok(None),
                r = send => r.map_err(|e| connection_error(&self.id, e))?,
            };
            if !resp.status().is_success() {
                return Err(http_error(resp).await);
            }

            let mut usage: Option<Usage> = None;
            let mut parser = SseParser::default();
            let mut stream = resp.bytes_stream();
            loop {
                let chunk = tokio::select! {
                    _ = cancel.cancelled() => return Ok(usage),
                    c = stream.next() => c,
                };
                let Some(chunk) = chunk else { break };
                let chunk = chunk.map_err(|e| format!("Flux interrompu : {e}"))?;
                for ev in parser.push(&chunk) {
                    if ev.data.trim() == "[DONE]" {
                        return Ok(usage);
                    }
                    let Ok(v) = serde_json::from_str::<Value>(&ev.data) else {
                        continue;
                    };
                    if let Some(msg) = v.pointer("/error/message").and_then(Value::as_str) {
                        return Err(msg.to_string());
                    }
                    if let Some(delta) = v.pointer("/choices/0/delta") {
                        let reasoning = delta
                            .get("reasoning_content")
                            .or_else(|| delta.get("reasoning"))
                            .and_then(Value::as_str)
                            .filter(|s| !s.is_empty());
                        if let Some(r) = reasoning {
                            out(StreamEvent::Reasoning { text: r.to_string() });
                        }
                        if let Some(text) =
                            delta.get("content").and_then(Value::as_str).filter(|s| !s.is_empty())
                        {
                            out(StreamEvent::Delta { text: text.to_string() });
                        }
                    }
                    if let Some(u) = v.get("usage").filter(|u| u.is_object()) {
                        usage = Some(Usage {
                            input_tokens: u.get("prompt_tokens").and_then(Value::as_u64),
                            output_tokens: u.get("completion_tokens").and_then(Value::as_u64),
                        });
                    }
                }
            }
            Ok(usage)
        })
    }

    fn list_models<'a>(&'a self) -> BoxFuture<'a, Result<Vec<String>, String>> {
        Box::pin(async move {
            let resp = self
                .request(reqwest::Method::GET, "/models")
                .send()
                .await
                .map_err(|e| connection_error(&self.id, e))?;
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

fn connection_error(provider: &str, e: reqwest::Error) -> String {
    if e.is_connect() && (provider == "ollama" || provider == "lmstudio") {
        let name = if provider == "ollama" { "Ollama" } else { "LM Studio" };
        return format!("{name} ne répond pas. Vérifiez qu'il est lancé.");
    }
    format!("Connexion impossible : {e}")
}

/// Tests contre un Ollama local : `cargo test --features ai -- --ignored ollama_live`.
#[cfg(test)]
mod live_tests {
    use super::*;
    use crate::ai::ChatMessage;
    use std::sync::{Arc, Mutex};

    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn ollama_live_raw_completion() {
        let provider = OpenAiProvider::new("ollama".into(), "http://127.0.0.1:11434/v1".into(), None);
        for model in ["qwen3:1.7b", "llama3.2:1b"] {
            let text = Arc::new(Mutex::new(String::new()));
            let t2 = text.clone();
            let sink: Sink = Arc::new(move |ev| {
                if let StreamEvent::Delta { text } = ev {
                    t2.lock().unwrap().push_str(&text);
                }
            });
            let req = ChatRequest {
                provider: "ollama".into(),
                model: model.into(),
                system: Some("ignoré".into()),
                messages: vec![ChatMessage { role: "user".into(), content: "ignoré".into(), images: vec![] }],
                conversation_id: None,
                mode: ChatMode::Complete,
                document: None,
                max_tokens: Some(48),
                stop: vec!["\n\n".into()],
                raw_prefix: Some("Nous sommes arrivés à Saint-Malo en fin d'après-midi. La marée était".into()),
            };
            let usage = provider.chat(req, sink, CancelToken::default()).await.unwrap();
            let text = text.lock().unwrap().clone();
            println!("{model}: {text:?} {usage:?}");
            assert!(!text.trim().is_empty(), "{model} n'a rien proposé");
        }
    }
}
