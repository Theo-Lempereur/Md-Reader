//! Codex (abonnement ChatGPT) via `codex app-server` : process enfant,
//! JSON-RPC ligne par ligne sur stdio, une session (thread) par conversation,
//! redémarrage automatique si le process meurt.
//!
//! Repli sur `codex exec --json` si le protocole app-server diverge (échec
//! de `initialize`) : même résultat pour l'appelant, sans session persistante.

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot};

use super::provider::{BoxFuture, CancelToken, Caps, Provider, Sink};
use super::workspace::Workspace;
use super::{ChatMode, ChatRequest, StreamEvent, Usage};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Au-delà, on libère les sessions les plus anciennes.
const MAX_THREADS: usize = 24;

const CHAT_INSTRUCTIONS: &str = "Tu es l'assistant d'écriture intégré à Md-Reader, \
un éditeur Markdown. Réponds dans la langue de l'utilisateur, en Markdown. \
Tu n'as pas besoin d'exécuter de commandes : le contexte utile (document, \
fichiers joints) t'est fourni dans les messages.";

/* ------------------------------------------------------------------ */
/* Localisation de l'exécutable                                        */
/* ------------------------------------------------------------------ */

pub fn find_codex() -> Option<PathBuf> {
    let names: &[&str] = if cfg!(windows) {
        &["codex.exe", "codex.cmd", "codex.bat"]
    } else {
        &["codex"]
    };
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            for name in names {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    // Installation de l'app de bureau Codex, pas toujours dans le PATH d'une
    // application lancée depuis l'Explorateur.
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let candidate = PathBuf::from(local).join("Programs/OpenAI/Codex/bin/codex.exe");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Commande prête à lancer, sans fenêtre console sous Windows.
pub fn command(exe: &PathBuf) -> Command {
    let is_script = exe
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"));
    let mut cmd = if is_script {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(exe);
        c
    } else {
        Command::new(exe)
    };
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// `codex --version` + `codex login status`, pour l'écran de configuration.
pub async fn detect() -> Value {
    let Some(exe) = find_codex() else {
        return json!({ "installed": false });
    };
    let version = run_capture(&exe, &["--version"]).await;
    let login = run_capture(&exe, &["login", "status"]).await;
    let logged_in = login
        .as_ref()
        .map(|(ok, text)| *ok && text.to_ascii_lowercase().contains("logged in"))
        .unwrap_or(false);
    json!({
        "installed": version.as_ref().is_some_and(|(ok, _)| *ok),
        "version": version.map(|(_, t)| t.trim().to_string()),
        "loggedIn": logged_in,
        "loginDetail": login.map(|(_, t)| t.trim().to_string()),
    })
}

async fn run_capture(exe: &PathBuf, args: &[&str]) -> Option<(bool, String)> {
    let fut = command(exe)
        .args(args)
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output();
    let out = tokio::time::timeout(Duration::from_secs(8), fut).await.ok()?.ok()?;
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    Some((out.status.success(), text))
}

/* ------------------------------------------------------------------ */
/* Connexion app-server                                                */
/* ------------------------------------------------------------------ */

type Pending = HashMap<u64, oneshot::Sender<Result<Value, String>>>;

struct Shared {
    pending: Mutex<Pending>,
    subs: Mutex<HashMap<String, mpsc::UnboundedSender<Value>>>,
    alive: AtomicBool,
}

struct Server {
    stdin: Arc<tokio::sync::Mutex<ChildStdin>>,
    shared: Arc<Shared>,
    next_id: AtomicU64,
    generation: u64,
    _child: Mutex<Child>,
}

impl Server {
    async fn spawn(generation: u64) -> Result<Arc<Server>, String> {
        let exe = find_codex().ok_or("Codex n'est pas installé (commande `codex` introuvable).")?;
        let mut child = command(&exe)
            // Les serveurs MCP de l'utilisateur sont inutiles ici et ralentissent
            // chaque session.
            .args(["app-server", "-c", "mcp_servers={}"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("Lancement de Codex impossible : {e}"))?;
        let stdin = child.stdin.take().ok_or("stdin Codex indisponible")?;
        let stdout = child.stdout.take().ok_or("stdout Codex indisponible")?;

        let shared = Arc::new(Shared {
            pending: Mutex::new(HashMap::new()),
            subs: Mutex::new(HashMap::new()),
            alive: AtomicBool::new(true),
        });
        let stdin = Arc::new(tokio::sync::Mutex::new(stdin));
        tauri::async_runtime::spawn(read_loop(stdout, shared.clone(), stdin.clone()));

        let server = Arc::new(Server {
            stdin,
            shared,
            next_id: AtomicU64::new(1),
            generation,
            _child: Mutex::new(child),
        });
        server
            .request(
                "initialize",
                json!({
                    "clientInfo": {
                        "name": "md-reader",
                        "title": "Md-Reader",
                        "version": env!("CARGO_PKG_VERSION"),
                    },
                    "capabilities": null,
                }),
            )
            .await?;
        server.notify("initialized", None).await?;
        Ok(server)
    }

    fn alive(&self) -> bool {
        self.shared.alive.load(Ordering::SeqCst)
    }

    async fn write(&self, msg: Value) -> Result<(), String> {
        let mut line = msg.to_string();
        line.push('\n');
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("Codex ne répond plus : {e}"))?;
        stdin.flush().await.map_err(|e| e.to_string())
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.shared.pending.lock().unwrap().insert(id, tx);
        let sent = self
            .write(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
            .await;
        if let Err(e) = sent {
            self.shared.pending.lock().unwrap().remove(&id);
            return Err(e);
        }
        match tokio::time::timeout(REQUEST_TIMEOUT, rx).await {
            Ok(Ok(res)) => res,
            Ok(Err(_)) => Err("Codex s'est arrêté pendant la requête.".into()),
            Err(_) => {
                self.shared.pending.lock().unwrap().remove(&id);
                Err(format!("Codex n'a pas répondu à « {method} »."))
            }
        }
    }

    async fn notify(&self, method: &str, params: Option<Value>) -> Result<(), String> {
        let mut msg = json!({ "jsonrpc": "2.0", "method": method });
        if let Some(p) = params {
            msg["params"] = p;
        }
        self.write(msg).await
    }

    fn subscribe(&self, thread_id: &str) -> mpsc::UnboundedReceiver<Value> {
        let (tx, rx) = mpsc::unbounded_channel();
        self.shared
            .subs
            .lock()
            .unwrap()
            .insert(thread_id.to_string(), tx);
        rx
    }

    fn unsubscribe(&self, thread_id: &str) {
        self.shared.subs.lock().unwrap().remove(thread_id);
    }
}

async fn read_loop(
    stdout: tokio::process::ChildStdout,
    shared: Arc<Shared>,
    stdin: Arc<tokio::sync::Mutex<ChildStdin>>,
) {
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(msg) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let id = msg.get("id").and_then(Value::as_u64);
        let method = msg.get("method").and_then(Value::as_str);
        match (id, method) {
            // Réponse à l'une de nos requêtes.
            (Some(id), None) => {
                if let Some(tx) = shared.pending.lock().unwrap().remove(&id) {
                    let res = match msg.get("error") {
                        Some(err) => Err(err
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("erreur Codex")
                            .to_string()),
                        None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
                    };
                    let _ = tx.send(res);
                }
            }
            // Requête du serveur (approbation…) : jamais attendue avec
            // `approvalPolicy: never`, refusée par principe.
            (Some(_), Some(_)) => {
                let reply = json!({
                    "jsonrpc": "2.0",
                    "id": msg["id"],
                    "error": { "code": -32601, "message": "Non pris en charge par Md-Reader" }
                });
                let mut w = stdin.lock().await;
                let _ = w.write_all(format!("{reply}\n").as_bytes()).await;
                let _ = w.flush().await;
            }
            // Notification : routée vers la session concernée.
            (None, Some(_)) => {
                let thread = msg
                    .pointer("/params/threadId")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                if let Some(thread) = thread {
                    if let Some(tx) = shared.subs.lock().unwrap().get(&thread) {
                        let _ = tx.send(msg);
                    }
                }
            }
            _ => {}
        }
    }
    // Fin de flux : le process est mort. Réveille tout le monde.
    shared.alive.store(false, Ordering::SeqCst);
    shared.pending.lock().unwrap().clear();
    shared.subs.lock().unwrap().clear();
}

/* ------------------------------------------------------------------ */
/* Gestionnaire (partagé par toutes les requêtes)                      */
/* ------------------------------------------------------------------ */

struct ThreadInfo {
    thread_id: String,
    generation: u64,
    context_hash: u64,
    last_used: u64,
    workspace: Arc<Workspace>,
}

#[derive(Default)]
pub struct CodexManager {
    server: tokio::sync::Mutex<Option<Arc<Server>>>,
    generation: AtomicU64,
    clock: AtomicU64,
    threads: Mutex<HashMap<String, ThreadInfo>>,
    /// Protocole app-server inutilisable : on passe par `codex exec --json`.
    use_exec: AtomicBool,
}

impl CodexManager {
    async fn ensure(&self) -> Result<Arc<Server>, String> {
        let mut guard = self.server.lock().await;
        if let Some(s) = guard.as_ref().filter(|s| s.alive()) {
            return Ok(s.clone());
        }
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let server = Server::spawn(generation).await?;
        *guard = Some(server.clone());
        Ok(server)
    }

    fn tick(&self) -> u64 {
        self.clock.fetch_add(1, Ordering::SeqCst)
    }

    fn prune_threads(&self) {
        let mut threads = self.threads.lock().unwrap();
        while threads.len() > MAX_THREADS {
            let oldest = threads
                .iter()
                .min_by_key(|(_, t)| t.last_used)
                .map(|(k, _)| k.clone());
            match oldest {
                Some(k) => {
                    threads.remove(&k);
                }
                None => break,
            }
        }
    }
}

pub struct CodexProvider {
    manager: Arc<CodexManager>,
}

impl CodexProvider {
    pub fn new(manager: Arc<CodexManager>) -> Self {
        Self { manager }
    }
}

fn hash_str(s: &str) -> u64 {
    let mut h = DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

fn last_user_text(req: &ChatRequest) -> Result<&super::ChatMessage, String> {
    req.messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .ok_or_else(|| "Aucun message à envoyer.".to_string())
}

fn transcript(messages: &[super::ChatMessage]) -> String {
    let mut out = String::from("Historique de la conversation :\n");
    for m in messages {
        let who = if m.role == "assistant" { "Assistant" } else { "Utilisateur" };
        out.push_str(&format!("[{who}]\n{}\n\n", m.content));
    }
    out
}

/// `path` est ABSOLU : dans la sandbox Windows de Codex, le répertoire
/// courant des commandes n'est pas fiable et les chemins relatifs échouent.
fn edit_prompt(req: &ChatRequest, path: &std::path::Path, request: &str) -> String {
    let mut prompt = String::new();
    if let Some(system) = req.system.as_deref().filter(|s| !s.trim().is_empty()) {
        prompt.push_str("<contexte>\n");
        prompt.push_str(system);
        prompt.push_str("\n</contexte>\n\n");
    }
    prompt.push_str(&format!(
        "Le document à modifier est le fichier `{path}` (chemin absolu, à utiliser \
         tel quel dans tes commandes). Applique la demande ci-dessous en modifiant ce \
         fichier directement. Ne crée aucun autre fichier et n'exécute aucune autre \
         action. Conserve la syntaxe Markdown et tout ce que la demande ne concerne pas. \
         Termine par une seule phrase qui résume la modification.\n\nDemande : {request}",
        path = path.display()
    ));
    prompt
}

/// Écrit les images jointes dans le dossier de travail (Codex les lit par chemin).
fn write_images(ws: &Workspace, msg: &super::ChatMessage) -> Result<Vec<Value>, String> {
    let mut inputs = Vec::new();
    for (i, img) in msg.images.iter().enumerate() {
        let ext = match img.mime.as_str() {
            "image/jpeg" => "jpg",
            "image/gif" => "gif",
            "image/webp" => "webp",
            _ => "png",
        };
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(img.data.as_bytes())
            .map_err(|e| format!("Image invalide : {e}"))?;
        let name = format!("image-{}-{}.{ext}", uuid::Uuid::new_v4().simple(), i);
        let path = ws.write(&name, &bytes)?;
        inputs.push(json!({ "type": "localImage", "path": path.to_string_lossy() }));
    }
    Ok(inputs)
}

fn tool_label(item: &Value) -> Option<String> {
    match item.get("type").and_then(Value::as_str)? {
        "commandExecution" => Some(format!(
            "Commande : {}",
            item.get("command").and_then(Value::as_str).unwrap_or("…")
        )),
        "fileChange" => Some("Modification du fichier".into()),
        "webSearch" => Some("Recherche web".into()),
        "mcpToolCall" => Some(format!(
            "Outil : {}",
            item.get("tool").and_then(Value::as_str).unwrap_or("…")
        )),
        _ => None,
    }
}

impl CodexProvider {
    /// Déroule un tour sur un thread déjà abonné, jusqu'à `turn/completed`.
    async fn run_turn(
        &self,
        server: &Server,
        thread_id: &str,
        mut rx: mpsc::UnboundedReceiver<Value>,
        input: Vec<Value>,
        model: Option<&str>,
        out: &Sink,
        cancel: &CancelToken,
    ) -> Result<Option<Usage>, String> {
        let mut params = json!({ "threadId": thread_id, "input": input });
        if let Some(m) = model {
            params["model"] = json!(m);
        }
        let started = server.request("turn/start", params).await?;
        let turn_id = started
            .pointer("/turn/id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();

        let mut usage: Option<Usage> = None;
        let mut last_error: Option<String> = None;
        loop {
            let msg = tokio::select! {
                _ = cancel.cancelled() => {
                    let _ = server
                        .request("turn/interrupt", json!({ "threadId": thread_id, "turnId": turn_id }))
                        .await;
                    return Ok(usage);
                }
                m = rx.recv() => m,
            };
            let Some(msg) = msg else {
                return Err("Codex s'est arrêté pendant la réponse. Il sera relancé à la prochaine demande.".into());
            };
            let params = &msg["params"];
            if let Some(t) = params.get("turnId").and_then(Value::as_str) {
                if !turn_id.is_empty() && t != turn_id {
                    continue;
                }
            }
            match msg["method"].as_str().unwrap_or_default() {
                "item/agentMessage/delta" => {
                    if let Some(d) = params.get("delta").and_then(Value::as_str) {
                        out(StreamEvent::Delta { text: d.to_string() });
                    }
                }
                "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => {
                    if let Some(d) = params.get("delta").and_then(Value::as_str) {
                        out(StreamEvent::Reasoning { text: d.to_string() });
                    }
                }
                "item/started" => {
                    if let Some(label) = tool_label(&params["item"]) {
                        out(StreamEvent::ToolStart { label });
                    }
                }
                "thread/tokenUsage/updated" => {
                    let u = params
                        .pointer("/tokenUsage/last")
                        .or_else(|| params.pointer("/tokenUsage/total"));
                    if let Some(u) = u {
                        usage = Some(Usage {
                            input_tokens: u.get("inputTokens").and_then(Value::as_u64),
                            output_tokens: u.get("outputTokens").and_then(Value::as_u64),
                        });
                    }
                }
                "error" => {
                    if params.get("willRetry").and_then(Value::as_bool) != Some(true) {
                        last_error = params
                            .pointer("/error/message")
                            .and_then(Value::as_str)
                            .map(str::to_string);
                    }
                }
                "turn/completed" => {
                    let turn = &params["turn"];
                    return match turn.get("status").and_then(Value::as_str) {
                        Some("failed") => Err(turn
                            .pointer("/error/message")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                            .or(last_error)
                            .unwrap_or_else(|| "Codex a échoué.".into())),
                        _ => Ok(usage),
                    };
                }
                _ => {}
            }
        }
    }

    async fn chat_app_server(
        &self,
        req: ChatRequest,
        out: Sink,
        cancel: CancelToken,
    ) -> Result<Option<Usage>, String> {
        let server = self.manager.ensure().await?;
        let model = Some(req.model.trim()).filter(|m| !m.is_empty() && *m != "default");
        let user = last_user_text(&req)?.clone();

        if req.mode == ChatMode::Edit {
            let doc = req
                .document
                .as_ref()
                .ok_or("Aucun document à modifier.")?;
            let ws = Workspace::create()?;
            let file = super::workspace::sanitize_name(&doc.name);
            let file = if file.to_ascii_lowercase().ends_with(".md") { file } else { format!("{file}.md") };
            let path = ws.write(&file, doc.content.as_bytes())?;
            let mut params = json!({
                "cwd": ws.path().to_string_lossy(),
                "sandbox": "workspace-write",
                "approvalPolicy": "never",
                "ephemeral": true,
                "developerInstructions": CHAT_INSTRUCTIONS,
            });
            if let Some(m) = model {
                params["model"] = json!(m);
            }
            let started = server.request("thread/start", params).await?;
            let thread_id = started
                .pointer("/thread/id")
                .and_then(Value::as_str)
                .ok_or("Réponse thread/start inattendue")?
                .to_string();
            let rx = server.subscribe(&thread_id);
            let mut input = vec![json!({
                "type": "text",
                "text": edit_prompt(&req, &path, &user.content),
                "text_elements": [],
            })];
            input.extend(write_images(&ws, &user)?);
            let res = self
                .run_turn(&server, &thread_id, rx, input, None, &out, &cancel)
                .await;
            server.unsubscribe(&thread_id);
            let usage = res?;
            if !cancel.is_cancelled() {
                out(StreamEvent::EditResult { content: ws.read_text(&path)? });
            }
            return Ok(usage);
        }

        // Mode conversation : une session Codex par conversation du front.
        let conv = req
            .conversation_id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let system = req.system.clone().unwrap_or_default();
        let ctx_hash = hash_str(&system);
        let existing = {
            let threads = self.manager.threads.lock().unwrap();
            threads
                .get(&conv)
                .filter(|t| t.generation == server.generation)
                .map(|t| (t.thread_id.clone(), t.context_hash, t.workspace.clone()))
        };
        let (thread_id, prev_hash, ws, is_new) = match existing {
            Some((id, h, ws)) => (id, Some(h), ws, false),
            None => {
                let ws = Arc::new(Workspace::create()?);
                let mut params = json!({
                    "cwd": ws.path().to_string_lossy(),
                    "sandbox": "read-only",
                    "approvalPolicy": "never",
                    "ephemeral": true,
                    "developerInstructions": CHAT_INSTRUCTIONS,
                });
                if let Some(m) = model {
                    params["model"] = json!(m);
                }
                let started = server.request("thread/start", params).await?;
                let id = started
                    .pointer("/thread/id")
                    .and_then(Value::as_str)
                    .ok_or("Réponse thread/start inattendue")?
                    .to_string();
                (id, None, ws, true)
            }
        };

        // Le contexte (document…) n'est renvoyé que s'il a changé depuis le
        // dernier tour de cette session.
        let mut text = String::new();
        if !system.trim().is_empty() && prev_hash != Some(ctx_hash) {
            text.push_str("<contexte>\n");
            text.push_str(&system);
            text.push_str("\n</contexte>\n\n");
        }
        if is_new && req.messages.len() > 1 {
            text.push_str(&transcript(&req.messages[..req.messages.len() - 1]));
        }
        text.push_str(&user.content);

        let mut input = vec![json!({ "type": "text", "text": text, "text_elements": [] })];
        input.extend(write_images(&ws, &user)?);

        {
            let tick = self.manager.tick();
            let mut threads = self.manager.threads.lock().unwrap();
            threads.insert(
                conv.clone(),
                ThreadInfo {
                    thread_id: thread_id.clone(),
                    generation: server.generation,
                    context_hash: ctx_hash,
                    last_used: tick,
                    workspace: ws,
                },
            );
        }
        self.manager.prune_threads();

        let rx = server.subscribe(&thread_id);
        let res = self
            .run_turn(&server, &thread_id, rx, input, model, &out, &cancel)
            .await;
        server.unsubscribe(&thread_id);
        if res.is_err() {
            // Session douteuse : la prochaine demande repartira d'un thread neuf.
            self.manager.threads.lock().unwrap().remove(&conv);
        }
        res
    }

    /// Repli : `codex exec --json`, un process par demande.
    async fn chat_exec(
        &self,
        req: ChatRequest,
        out: Sink,
        cancel: CancelToken,
    ) -> Result<Option<Usage>, String> {
        let exe = find_codex().ok_or("Codex n'est pas installé.")?;
        let user = last_user_text(&req)?.clone();
        let ws = Workspace::create()?;
        let mut args: Vec<String> = vec![
            "exec".into(),
            "--json".into(),
            "--skip-git-repo-check".into(),
            "-c".into(),
            "mcp_servers={}".into(),
            "-C".into(),
            ws.path().to_string_lossy().into_owned(),
        ];
        let model = req.model.trim();
        if !model.is_empty() && model != "default" {
            args.push("-m".into());
            args.push(model.into());
        }

        let mut doc_path = None;
        let prompt = if req.mode == ChatMode::Edit {
            let doc = req.document.as_ref().ok_or("Aucun document à modifier.")?;
            let file = super::workspace::sanitize_name(&doc.name);
            let path = ws.write(&file, doc.content.as_bytes())?;
            let prompt = edit_prompt(&req, &path, &user.content);
            doc_path = Some(path);
            args.push("-s".into());
            args.push("workspace-write".into());
            prompt
        } else {
            args.push("-s".into());
            args.push("read-only".into());
            let mut p = String::new();
            if let Some(system) = req.system.as_deref().filter(|s| !s.trim().is_empty()) {
                p.push_str(&format!("<contexte>\n{system}\n</contexte>\n\n"));
            }
            if req.messages.len() > 1 {
                p.push_str(&transcript(&req.messages[..req.messages.len() - 1]));
            }
            p.push_str(&user.content);
            p
        };
        for img in write_images(&ws, &user)? {
            if let Some(path) = img.get("path").and_then(Value::as_str) {
                args.push("-i".into());
                args.push(path.into());
            }
        }
        args.push("-".into());

        let mut child = command(&exe)
            .args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("Lancement de Codex impossible : {e}"))?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(prompt.as_bytes()).await.map_err(|e| e.to_string())?;
        }
        let stdout = child.stdout.take().ok_or("stdout Codex indisponible")?;
        let mut lines = BufReader::new(stdout).lines();
        let mut usage = None;
        loop {
            let line = tokio::select! {
                _ = cancel.cancelled() => {
                    let _ = child.kill().await;
                    return Ok(usage);
                }
                l = lines.next_line() => l.map_err(|e| e.to_string())?,
            };
            let Some(line) = line else { break };
            let Ok(ev) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            match ev.get("type").and_then(Value::as_str).unwrap_or_default() {
                "item.completed" => {
                    let item = &ev["item"];
                    match item.get("type").and_then(Value::as_str) {
                        Some("agent_message") => {
                            if let Some(t) = item.get("text").and_then(Value::as_str) {
                                out(StreamEvent::Delta { text: t.to_string() });
                            }
                        }
                        Some("reasoning") => {
                            if let Some(t) = item.get("text").and_then(Value::as_str) {
                                out(StreamEvent::Reasoning { text: t.to_string() });
                            }
                        }
                        _ => {}
                    }
                }
                "item.started" => {
                    if ev.pointer("/item/type").and_then(Value::as_str) == Some("command_execution") {
                        out(StreamEvent::ToolStart { label: "Commande".into() });
                    }
                }
                "turn.completed" => {
                    usage = Some(Usage {
                        input_tokens: ev.pointer("/usage/input_tokens").and_then(Value::as_u64),
                        output_tokens: ev.pointer("/usage/output_tokens").and_then(Value::as_u64),
                    });
                }
                "turn.failed" | "error" => {
                    let msg = ev
                        .pointer("/error/message")
                        .or_else(|| ev.get("message"))
                        .and_then(Value::as_str)
                        .unwrap_or("Codex a échoué.");
                    return Err(msg.to_string());
                }
                _ => {}
            }
        }
        let _ = child.wait().await;
        if let Some(path) = doc_path {
            if !cancel.is_cancelled() {
                out(StreamEvent::EditResult { content: ws.read_text(&path)? });
            }
        }
        Ok(usage)
    }
}

impl Provider for CodexProvider {
    fn chat<'a>(
        &'a self,
        req: ChatRequest,
        out: Sink,
        cancel: CancelToken,
    ) -> BoxFuture<'a, Result<Option<Usage>, String>> {
        Box::pin(async move {
            if req.mode == ChatMode::Complete {
                return Err("L'autocomplétion n'est pas disponible avec Codex.".into());
            }
            if self.manager.use_exec.load(Ordering::SeqCst) {
                return self.chat_exec(req, out, cancel).await;
            }
            match self.manager.ensure().await {
                Ok(_) => self.chat_app_server(req, out, cancel).await,
                Err(e) if e.contains("introuvable") || e.contains("installé") => Err(e),
                Err(_) => {
                    // Protocole app-server inattendu : repli définitif sur exec.
                    self.manager.use_exec.store(true, Ordering::SeqCst);
                    self.chat_exec(req, out, cancel).await
                }
            }
        })
    }

    fn list_models<'a>(&'a self) -> BoxFuture<'a, Result<Vec<String>, String>> {
        Box::pin(async move {
            if self.manager.use_exec.load(Ordering::SeqCst) {
                return Ok(vec!["default".into()]);
            }
            let server = self.manager.ensure().await?;
            let res = server.request("model/list", json!({})).await?;
            let mut models = vec!["default".to_string()];
            if let Some(arr) = res.get("data").and_then(Value::as_array) {
                for m in arr {
                    if m.get("hidden").and_then(Value::as_bool) == Some(true) {
                        continue;
                    }
                    let id = m
                        .get("model")
                        .or_else(|| m.get("id"))
                        .and_then(Value::as_str);
                    if let Some(id) = id {
                        models.push(id.to_string());
                    }
                }
            }
            Ok(models)
        })
    }

    fn capabilities(&self) -> Caps {
        Caps {
            vision: true,
            streaming: true,
            edit: true,
            complete: false,
        }
    }
}

/// Tests contre le vrai Codex (abonnement requis) : `cargo test -- --ignored codex_live`.
#[cfg(test)]
mod live_tests {
    use super::*;
    use crate::ai::{ChatMessage, EditDocument};

    fn req(mode: ChatMode, text: &str, document: Option<EditDocument>) -> ChatRequest {
        ChatRequest {
            provider: "codex".into(),
            model: String::new(),
            system: Some("<document nom=\"test.md\">\n# Test\n</document>".into()),
            messages: vec![ChatMessage { role: "user".into(), content: text.into(), images: vec![] }],
            conversation_id: Some("live-test".into()),
            mode,
            document,
            max_tokens: None,
            stop: vec![],
            raw_prefix: None,
        }
    }

    fn collector() -> (Sink, Arc<Mutex<Vec<StreamEvent>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let e2 = events.clone();
        (Arc::new(move |ev| e2.lock().unwrap().push(ev)), events)
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn codex_live_chat_streams_and_reuses_session() {
        let provider = CodexProvider::new(Arc::new(CodexManager::default()));
        let (sink, events) = collector();
        provider
            .chat(req(ChatMode::Chat, "Réponds seulement : BONJOUR", None), sink, CancelToken::default())
            .await
            .expect("chat");
        let text: String = events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| match e {
                StreamEvent::Delta { text } => Some(text.clone()),
                _ => None,
            })
            .collect();
        assert!(text.to_uppercase().contains("BONJOUR"), "réponse : {text}");
        assert_eq!(provider.manager.threads.lock().unwrap().len(), 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn codex_live_edit_returns_document() {
        let provider = CodexProvider::new(Arc::new(CodexManager::default()));
        let (sink, events) = collector();
        let doc = EditDocument {
            name: "note.md".into(),
            content: "# Titre\n\nUn texte avec des fote.\n".into(),
        };
        provider
            .chat(req(ChatMode::Edit, "Corrige les fautes d'orthographe.", Some(doc)), sink, CancelToken::default())
            .await
            .expect("edit");
        let result = events.lock().unwrap().iter().find_map(|e| match e {
            StreamEvent::EditResult { content } => Some(content.clone()),
            _ => None,
        });
        let result = result.expect("EditResult");
        assert!(result.contains("fautes"), "document : {result}");
    }
}
