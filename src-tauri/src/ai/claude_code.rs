//! Claude via l'abonnement de l'utilisateur (Pro, Max…), en pilotant la CLI
//! Claude Code qu'il a installée et connectée lui-même : `claude -p` en flux
//! JSON sur stdio. Md-Reader ne lit ni ne stocke aucun identifiant : la
//! connexion se fait dans la CLI, par le parcours d'Anthropic.
//!
//! - Conversation : un process `claude -p --input-format stream-json` par
//!   conversation, gardé vivant entre les tours (la CLI conserve l'historique
//!   et le cache de prompt). Au plus `MAX_LIVE` process, libérés après
//!   `IDLE_TIMEOUT` ; une conversation dont le process a disparu repart avec
//!   l'historique en texte, comme Codex.
//! - Édition : un process ponctuel qui modifie une copie temporaire du
//!   document avec les outils Read / Edit, puis on relit le fichier.
//!
//! La CLI est lancée dans un dossier temporaire vide, sans outils (hors
//! édition), sans serveurs MCP, sans réglages utilisateur ni skills, avec un
//! prompt système court : c'est un assistant d'écriture, pas un agent de code.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

use super::provider::{BoxFuture, CancelToken, Caps, Provider, Sink};
use super::workspace::Workspace;
use super::{ChatMessage, ChatMode, ChatRequest, StreamEvent, Usage};

/// Process de conversation gardés vivants simultanément.
const MAX_LIVE: usize = 3;
/// Au-delà, un process inactif est arrêté (il repartira de l'historique).
const IDLE_TIMEOUT: Duration = Duration::from_secs(15 * 60);

const CHAT_INSTRUCTIONS: &str = "Tu es l'assistant d'écriture intégré à Md-Reader, \
un éditeur Markdown. Réponds dans la langue de l'utilisateur, en Markdown. \
Tu n'as accès à aucun outil : le contexte utile (document, fichiers joints) \
t'est fourni dans les messages, entre balises <contexte>.";

const EDIT_INSTRUCTIONS: &str = "Tu es l'assistant d'écriture intégré à Md-Reader, \
un éditeur Markdown. On te confie un seul fichier Markdown à modifier selon la \
demande de l'utilisateur, avec les outils Read et Edit. Ne crée aucun autre \
fichier. Conserve la syntaxe Markdown et tout ce que la demande ne concerne pas. \
Quand c'est fait, réponds par une seule phrase qui résume la modification.";

pub const AUTH_HINT: &str = "Claude Code n'est pas connecté à votre compte, ou la \
session a expiré. Dans les réglages de l'assistant (onglet Claude), cliquez sur \
« Se connecter », ou lancez `claude` dans un terminal puis `/login`.";

/* ------------------------------------------------------------------ */
/* Localisation et lancement                                           */
/* ------------------------------------------------------------------ */

/// Emplacements usuels hors PATH : une application lancée depuis
/// l'Explorateur ou le Dock ne voit pas toujours le PATH d'un terminal, et
/// l'installateur ne le met à jour que pour les nouvelles sessions.
fn fallback_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"));
    if let Some(home) = home.map(PathBuf::from) {
        out.push(home.join(".local/bin/claude.exe"));
        out.push(home.join(".local/bin/claude"));
        out.push(home.join(".claude/local/claude"));
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        out.push(PathBuf::from(appdata).join("npm/claude.cmd"));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        out.push(PathBuf::from(local).join("Microsoft/WinGet/Links/claude.exe"));
    }
    out.push("/opt/homebrew/bin/claude".into());
    out.push("/usr/local/bin/claude".into());
    out
}

pub fn find_claude() -> Option<PathBuf> {
    let names: &[&str] = if cfg!(windows) {
        &["claude.exe", "claude.cmd"]
    } else {
        &["claude"]
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
    fallback_paths().into_iter().find(|p| p.is_file())
}

/// Variables conservées : configuration choisie par l'utilisateur.
const KEEP_ENV: &[&str] = &[
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_GIT_BASH_PATH",
];

/// Variables retirées de l'environnement de la CLI :
/// - `ANTHROPIC_*` : une clé API ou une URL de base héritée ferait facturer
///   l'API (ou échouer) au lieu d'utiliser l'abonnement ;
/// - `CLAUDECODE`, `CLAUDE_CODE_*`… : marqueurs d'une session Claude Code
///   parente (Md-Reader lancé depuis un terminal Claude Code), qui détournent
///   l'authentification de la CLI enfant.
fn should_strip(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    if KEEP_ENV.contains(&upper.as_str()) {
        return false;
    }
    upper.starts_with("ANTHROPIC_") || upper.starts_with("CLAUDE")
}

pub fn command(exe: &Path) -> Command {
    let mut cmd = super::codex::command(&exe.to_path_buf());
    for (name, _) in std::env::vars_os() {
        if should_strip(&name.to_string_lossy()) {
            cmd.env_remove(&name);
        }
    }
    cmd
}

async fn run_capture(exe: &Path, args: &[&str]) -> Option<(bool, String, String)> {
    let fut = command(exe)
        .args(args)
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output();
    let out = tokio::time::timeout(Duration::from_secs(10), fut).await.ok()?.ok()?;
    Some((
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    ))
}

/// `claude --version` + `claude auth status`, pour l'écran de configuration.
/// L'adresse e-mail renvoyée par la CLI n'est pas transmise au front.
pub async fn detect() -> Value {
    let Some(exe) = find_claude() else {
        return json!({ "installed": false });
    };
    let (version, auth) = tokio::join!(
        run_capture(&exe, &["--version"]),
        run_capture(&exe, &["auth", "status"]),
    );
    let installed = version.as_ref().is_some_and(|(ok, _, _)| *ok);
    let version = version.map(|(_, out, _)| {
        out.trim().trim_end_matches("(Claude Code)").trim().to_string()
    });
    let status = auth
        .as_ref()
        .and_then(|(_, out, _)| serde_json::from_str::<Value>(out.trim()).ok());
    let logged_in = match &status {
        Some(s) => s.get("loggedIn").and_then(Value::as_bool).unwrap_or(false),
        // Version sans `auth status` en JSON : on se fie au code de sortie.
        None => auth.as_ref().is_some_and(|(ok, out, _)| {
            *ok && !out.to_ascii_lowercase().contains("not logged in")
        }),
    };
    let field = |k: &str| {
        status
            .as_ref()
            .and_then(|s| s.get(k))
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    json!({
        "installed": installed,
        "version": version,
        "loggedIn": logged_in,
        "authMethod": field("authMethod"),
        "subscription": field("subscriptionType"),
        "path": exe.to_string_lossy(),
    })
}

/* ------------------------------------------------------------------ */
/* Aides d'installation : terminal visible avec une commande fixe      */
/* ------------------------------------------------------------------ */

/// Ouvre un terminal qui exécute l'installation officielle (`install`) ou la
/// connexion au compte (`login`). Les commandes sont fixes : le front ne
/// choisit que l'action.
pub fn open_terminal(action: &str) -> Result<(), String> {
    let exe = find_claude();
    let script = match action {
        "install" if cfg!(windows) => "irm https://claude.ai/install.ps1 | iex".to_string(),
        "install" => "curl -fsSL https://claude.ai/install.sh | bash".to_string(),
        "login" => {
            let exe = exe.ok_or("Claude Code n'est pas installé.")?;
            let path = exe.to_string_lossy().into_owned();
            if cfg!(windows) {
                format!("& '{}' auth login", path.replace('\'', "''"))
            } else {
                format!("'{}' auth login", path.replace('\'', "'\\''"))
            }
        }
        _ => return Err(format!("Action inconnue : {action}")),
    };
    let done = "Une fois terminé, fermez cette fenêtre et cliquez sur « Vérifier à nouveau » dans Md-Reader.";
    spawn_terminal(&script, done)
}

#[cfg(windows)]
fn spawn_terminal(script: &str, done: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
    let full = format!("{script}; Write-Host ''; Write-Host '{}'", done.replace('\'', "''"));
    let mut cmd = std::process::Command::new("powershell");
    cmd.args(["-NoExit", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &full])
        .creation_flags(CREATE_NEW_CONSOLE);
    for (name, _) in std::env::vars_os() {
        if should_strip(&name.to_string_lossy()) {
            cmd.env_remove(&name);
        }
    }
    cmd.spawn().map(|_| ()).map_err(|e| format!("Ouverture du terminal impossible : {e}"))
}

#[cfg(target_os = "macos")]
fn spawn_terminal(script: &str, done: &str) -> Result<(), String> {
    let line = format!("{script}; echo; echo \"{done}\"");
    let escaped = line.replace('\\', "\\\\").replace('"', "\\\"");
    std::process::Command::new("osascript")
        .args([
            "-e",
            &format!("tell application \"Terminal\" to do script \"{escaped}\""),
            "-e",
            "tell application \"Terminal\" to activate",
        ])
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Ouverture du terminal impossible : {e}"))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn spawn_terminal(script: &str, done: &str) -> Result<(), String> {
    let line = format!("{script}; echo; echo \"{done}\"; exec bash");
    for term in ["x-terminal-emulator", "gnome-terminal", "konsole", "xfce4-terminal", "xterm"] {
        let mut cmd = std::process::Command::new(term);
        if term == "gnome-terminal" {
            cmd.args(["--", "bash", "-lc", &line]);
        } else {
            cmd.args(["-e", "bash", "-lc", &line]);
        }
        if cmd.spawn().is_ok() {
            return Ok(());
        }
    }
    Err("Aucun terminal trouvé : lancez la commande à la main.".into())
}

/* ------------------------------------------------------------------ */
/* Process CLI                                                         */
/* ------------------------------------------------------------------ */

struct Live {
    // Ordre de destruction : le process avant son dossier de travail.
    child: Child,
    stdin: ChildStdin,
    lines: Lines<BufReader<ChildStdout>>,
    stderr: Arc<Mutex<String>>,
    model: String,
    /// Empreinte du contexte (document…) déjà envoyé à ce process.
    context_hash: Option<u64>,
    _ws: Workspace,
}

enum Kind<'a> {
    Chat,
    Edit { tools: &'a str },
}

fn spawn(model: &str, kind: Kind<'_>, ws: Workspace) -> Result<Live, String> {
    let exe = find_claude().ok_or("Claude Code n'est pas installé.")?;
    let (instructions, tools) = match kind {
        Kind::Chat => (CHAT_INSTRUCTIONS, ""),
        Kind::Edit { tools } => (EDIT_INSTRUCTIONS, tools),
    };
    // Fichier plutôt qu'argument : pas de souci d'échappement via `cmd /C`.
    let prompt_file = ws.write("system-prompt.txt", instructions.as_bytes())?;
    let mut args: Vec<String> = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--no-session-persistence",
        "--strict-mcp-config",
        "--disable-slash-commands",
        // Seulement `.claude/settings.local.json` du dossier temporaire (vide) :
        // ni hooks, ni plugins, ni CLAUDE.md de l'utilisateur.
        "--setting-sources",
        "local",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    args.push("--system-prompt-file".into());
    args.push(prompt_file.to_string_lossy().into_owned());
    // `--tools ""` : aucun outil (conversation pure).
    args.push("--tools".into());
    args.push(tools.into());
    if !tools.is_empty() {
        args.push("--permission-mode".into());
        args.push("acceptEdits".into());
    }
    let model = model.trim();
    if !model.is_empty() && model != "default" {
        args.push("--model".into());
        args.push(model.into());
    }

    let mut child = command(&exe)
        .args(&args)
        .current_dir(ws.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Lancement de Claude Code impossible : {e}"))?;
    let stdin = child.stdin.take().ok_or("stdin Claude Code indisponible")?;
    let stdout = child.stdout.take().ok_or("stdout Claude Code indisponible")?;
    let stderr = Arc::new(Mutex::new(String::new()));
    if let Some(mut err) = child.stderr.take() {
        let sink = stderr.clone();
        tokio::spawn(async move {
            let mut buf = [0u8; 2048];
            while let Ok(n) = err.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                let mut s = sink.lock().unwrap();
                s.push_str(&String::from_utf8_lossy(&buf[..n]));
                // Seule la fin est utile pour un message d'erreur.
                if s.len() > 4000 {
                    let cut = s.len() - 2000;
                    let cut = (cut..s.len()).find(|&i| s.is_char_boundary(i)).unwrap_or(0);
                    s.drain(..cut);
                }
            }
        });
    }
    Ok(Live {
        child,
        stdin,
        lines: BufReader::new(stdout).lines(),
        stderr,
        model: model.to_string(),
        context_hash: None,
        _ws: ws,
    })
}

/// Message utilisateur au format `stream-json` d'entrée.
fn user_line(text: &str, msg: &ChatMessage) -> String {
    let mut content = vec![json!({ "type": "text", "text": text })];
    for img in &msg.images {
        content.push(json!({
            "type": "image",
            "source": { "type": "base64", "media_type": img.mime, "data": img.data },
        }));
    }
    let line = json!({ "type": "user", "message": { "role": "user", "content": content } });
    format!("{line}\n")
}

/// Erreur API rapportée par la CLI → message lisible.
pub fn friendly_error(status: Option<u64>, text: &str) -> String {
    let lower = text.to_ascii_lowercase();
    if matches!(status, Some(401 | 403))
        || lower.contains("authenticat")
        || lower.contains("oauth")
        || lower.contains("/login")
        || lower.contains("not logged in")
    {
        return AUTH_HINT.to_string();
    }
    if status == Some(429) || lower.contains("usage limit") || lower.contains("rate limit") {
        return format!(
            "Limite d'utilisation de votre abonnement Claude atteinte. {}",
            text.trim()
        );
    }
    let text = text.trim();
    if text.is_empty() {
        "Claude Code a échoué sans message.".into()
    } else {
        text.to_string()
    }
}

fn tool_label(name: &str) -> String {
    match name {
        "Read" => "Lecture du document".into(),
        "Edit" | "MultiEdit" => "Modification du document".into(),
        "Write" => "Réécriture du document".into(),
        other => format!("Outil : {other}"),
    }
}

fn usage_of(v: &Value) -> Option<Usage> {
    let u = v.get("usage")?;
    let n = |k: &str| u.get(k).and_then(Value::as_u64).unwrap_or(0);
    Some(Usage {
        input_tokens: Some(
            n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens"),
        ),
        output_tokens: u.get("output_tokens").and_then(Value::as_u64),
    })
}

enum TurnEnd {
    Done(Option<Usage>),
    Cancelled,
}

/// Envoie un message et relaie les événements jusqu'au `result` du tour.
async fn run_turn(
    live: &mut Live,
    line: &str,
    out: &Sink,
    cancel: &CancelToken,
) -> Result<TurnEnd, String> {
    live.stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("Claude Code ne répond plus : {e}"))?;
    live.stdin.flush().await.map_err(|e| e.to_string())?;

    // Texte déjà reçu en flux pour le message en cours : le message complet
    // (`assistant`) ne sert alors que de repli.
    let mut streamed = false;
    loop {
        let next = tokio::select! {
            _ = cancel.cancelled() => return Ok(TurnEnd::Cancelled),
            l = live.lines.next_line() => l.map_err(|e| e.to_string())?,
        };
        let Some(raw) = next else {
            let _ = tokio::time::timeout(Duration::from_secs(2), live.child.wait()).await;
            let err = live.stderr.lock().unwrap().trim().to_string();
            return Err(if err.is_empty() {
                "Claude Code s'est arrêté de façon inattendue.".into()
            } else {
                friendly_error(None, &err)
            });
        };
        let Ok(ev) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        match ev.get("type").and_then(Value::as_str).unwrap_or_default() {
            "stream_event" => {
                let e = &ev["event"];
                match e.get("type").and_then(Value::as_str).unwrap_or_default() {
                    "message_start" => streamed = false,
                    "content_block_start" => {
                        let block = &e["content_block"];
                        if block.get("type").and_then(Value::as_str) == Some("tool_use") {
                            let name = block.get("name").and_then(Value::as_str).unwrap_or("?");
                            out(StreamEvent::ToolStart { label: tool_label(name) });
                        }
                    }
                    "content_block_delta" => {
                        let d = &e["delta"];
                        match d.get("type").and_then(Value::as_str).unwrap_or_default() {
                            "text_delta" => {
                                if let Some(t) = d.get("text").and_then(Value::as_str) {
                                    streamed = true;
                                    out(StreamEvent::Delta { text: t.to_string() });
                                }
                            }
                            "thinking_delta" => {
                                if let Some(t) = d.get("thinking").and_then(Value::as_str) {
                                    out(StreamEvent::Reasoning { text: t.to_string() });
                                }
                            }
                            _ => {}
                        }
                    }
                    _ => {}
                }
            }
            "assistant" => {
                let msg = &ev["message"];
                // Message synthétique de la CLI (erreur) : le `result` suit.
                let synthetic = msg.get("model").and_then(Value::as_str) == Some("<synthetic>");
                if !streamed && !synthetic {
                    for block in msg["content"].as_array().into_iter().flatten() {
                        if block.get("type").and_then(Value::as_str) == Some("text") {
                            if let Some(t) = block.get("text").and_then(Value::as_str) {
                                out(StreamEvent::Delta { text: t.to_string() });
                            }
                        }
                    }
                }
                streamed = false;
            }
            "system" => {
                if ev.get("subtype").and_then(Value::as_str) == Some("api_retry") {
                    let status = ev.get("error_status").and_then(Value::as_u64);
                    // Inutile d'attendre les nouvelles tentatives : la session
                    // ne se reconnectera pas toute seule.
                    if matches!(status, Some(401 | 403)) {
                        return Err(AUTH_HINT.into());
                    }
                }
            }
            "result" => {
                if ev.get("is_error").and_then(Value::as_bool) == Some(true) {
                    let status = ev.get("api_error_status").and_then(Value::as_u64);
                    let text = ev
                        .get("result")
                        .and_then(Value::as_str)
                        .or_else(|| ev.get("subtype").and_then(Value::as_str))
                        .unwrap_or_default();
                    return Err(friendly_error(status, text));
                }
                return Ok(TurnEnd::Done(usage_of(&ev)));
            }
            _ => {}
        }
    }
}

/* ------------------------------------------------------------------ */
/* Sessions de conversation                                            */
/* ------------------------------------------------------------------ */

struct Session {
    live: tokio::sync::Mutex<Option<Live>>,
    last_used: Mutex<Instant>,
}

#[derive(Default)]
pub struct ClaudeManager {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

impl ClaudeManager {
    fn session(&self, conv: &str) -> Arc<Session> {
        let mut sessions = self.sessions.lock().unwrap();
        let s = sessions
            .entry(conv.to_string())
            .or_insert_with(|| {
                Arc::new(Session {
                    live: tokio::sync::Mutex::new(None),
                    last_used: Mutex::new(Instant::now()),
                })
            })
            .clone();
        *s.last_used.lock().unwrap() = Instant::now();
        s
    }

    /// Arrête les process inactifs depuis trop longtemps, puis les plus
    /// anciens au-delà de `MAX_LIVE`. Une session en plein tour (verrou pris)
    /// n'est jamais touchée.
    fn prune(&self) {
        let mut sessions = self.sessions.lock().unwrap();
        let mut idle: Vec<(Instant, String)> = Vec::new();
        let mut live = 0;
        for (conv, s) in sessions.iter() {
            let Ok(guard) = s.live.try_lock() else {
                live += 1;
                continue;
            };
            if guard.is_some() {
                live += 1;
                idle.push((*s.last_used.lock().unwrap(), conv.clone()));
            }
        }
        idle.sort();
        let now = Instant::now();
        for (at, conv) in idle {
            if live <= MAX_LIVE && now.duration_since(at) < IDLE_TIMEOUT {
                continue;
            }
            if let Some(s) = sessions.get(&conv) {
                if let Ok(mut guard) = s.live.try_lock() {
                    *guard = None; // kill_on_drop
                    live -= 1;
                }
            }
        }
        // Sessions vides et anciennes : on oublie l'entrée.
        sessions.retain(|_, s| {
            s.live.try_lock().map(|g| g.is_some()).unwrap_or(true)
                || now.duration_since(*s.last_used.lock().unwrap()) < IDLE_TIMEOUT
        });
    }
}

fn hash_str(s: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

fn transcript(messages: &[ChatMessage]) -> String {
    let mut out = String::from("Historique de la conversation :\n");
    for m in messages {
        let who = if m.role == "assistant" { "Assistant" } else { "Utilisateur" };
        out.push_str(&format!("[{who}]\n{}\n\n", m.content));
    }
    out
}

fn last_user(req: &ChatRequest) -> Result<&ChatMessage, String> {
    req.messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .ok_or_else(|| "Aucun message à envoyer.".to_string())
}

pub struct ClaudeCodeProvider {
    manager: Arc<ClaudeManager>,
}

impl ClaudeCodeProvider {
    pub fn new(manager: Arc<ClaudeManager>) -> Self {
        Self { manager }
    }

    async fn chat_session(
        &self,
        req: ChatRequest,
        out: Sink,
        cancel: CancelToken,
    ) -> Result<Option<Usage>, String> {
        let user = last_user(&req)?.clone();
        let Some(conv) = req.conversation_id.clone() else {
            // Demande isolée (action rapide…) : process ponctuel, rien à garder.
            let mut text = String::new();
            if let Some(system) = req.system.as_deref().filter(|s| !s.trim().is_empty()) {
                text.push_str(&format!("<contexte>\n{system}\n</contexte>\n\n"));
            }
            text.push_str(&user.content);
            let mut live = spawn(&req.model, Kind::Chat, Workspace::create()?)?;
            return match run_turn(&mut live, &user_line(&text, &user), &out, &cancel).await? {
                TurnEnd::Done(usage) => Ok(usage),
                TurnEnd::Cancelled => Ok(None),
            };
        };
        self.manager.prune();
        let session = self.manager.session(&conv);
        // Un tour à la fois par conversation.
        let mut guard = session.live.lock().await;
        let model = req.model.trim().to_string();
        if guard.as_ref().is_some_and(|l| l.model != model) {
            *guard = None;
        }
        let is_new = guard.is_none();
        if is_new {
            *guard = Some(spawn(&model, Kind::Chat, Workspace::create()?)?);
        }
        let live = guard.as_mut().expect("process créé ci-dessus");

        // Le contexte (document…) n'est renvoyé que s'il a changé.
        let system = req.system.clone().unwrap_or_default();
        let ctx_hash = hash_str(&system);
        let mut text = String::new();
        if !system.trim().is_empty() && live.context_hash != Some(ctx_hash) {
            text.push_str("<contexte>\n");
            text.push_str(&system);
            text.push_str("\n</contexte>\n\n");
        }
        if is_new && req.messages.len() > 1 {
            text.push_str(&transcript(&req.messages[..req.messages.len() - 1]));
        }
        text.push_str(&user.content);
        live.context_hash = Some(ctx_hash);

        let res = run_turn(live, &user_line(&text, &user), &out, &cancel).await;
        *session.last_used.lock().unwrap() = Instant::now();
        match res {
            Ok(TurnEnd::Done(usage)) => Ok(usage),
            Ok(TurnEnd::Cancelled) => {
                // Pas d'interruption propre d'un tour : on arrête le process,
                // la conversation repartira de l'historique.
                *guard = None;
                Ok(None)
            }
            Err(e) => {
                *guard = None;
                Err(e)
            }
        }
    }

    async fn chat_edit(
        &self,
        req: ChatRequest,
        out: Sink,
        cancel: CancelToken,
    ) -> Result<Option<Usage>, String> {
        let user = last_user(&req)?.clone();
        let doc = req.document.as_ref().ok_or("Aucun document à modifier.")?;
        let ws = Workspace::create()?;
        let file = super::workspace::sanitize_name(&doc.name);
        let file = if file.to_ascii_lowercase().ends_with(".md") { file } else { format!("{file}.md") };
        let path = ws.write(&file, doc.content.as_bytes())?;

        let mut text = String::new();
        if let Some(system) = req.system.as_deref().filter(|s| !s.trim().is_empty()) {
            text.push_str(&format!("<contexte>\n{system}\n</contexte>\n\n"));
        }
        text.push_str(&format!(
            "Le document à modifier est le fichier `{}` (chemin absolu). Applique la \
             demande ci-dessous en modifiant ce fichier directement.\n\nDemande : {}",
            path.display(),
            user.content
        ));

        let mut live = spawn(&req.model, Kind::Edit { tools: "Read,Edit,Write" }, ws)?;
        let res = run_turn(&mut live, &user_line(&text, &user), &out, &cancel).await?;
        let usage = match res {
            TurnEnd::Cancelled => return Ok(None),
            TurnEnd::Done(u) => u,
        };
        let content = std::fs::read_to_string(&path)
            .map_err(|e| format!("Relecture du document : {e}"))?;
        out(StreamEvent::EditResult { content });
        Ok(usage)
    }
}

impl Provider for ClaudeCodeProvider {
    fn chat<'a>(
        &'a self,
        req: ChatRequest,
        out: Sink,
        cancel: CancelToken,
    ) -> BoxFuture<'a, Result<Option<Usage>, String>> {
        Box::pin(async move {
            match req.mode {
                ChatMode::Complete => {
                    Err("L'autocomplétion n'est pas disponible avec l'abonnement Claude.".into())
                }
                ChatMode::Edit => self.chat_edit(req, out, cancel).await,
                ChatMode::Chat => self.chat_session(req, out, cancel).await,
            }
        })
    }

    fn list_models<'a>(&'a self) -> BoxFuture<'a, Result<Vec<String>, String>> {
        // Alias de la CLI : toujours le dernier modèle de chaque gamme.
        Box::pin(async move {
            Ok(["default", "sonnet", "opus", "haiku"].iter().map(|s| s.to_string()).collect())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_inherited_session_and_api_variables() {
        assert!(should_strip("ANTHROPIC_API_KEY"));
        assert!(should_strip("ANTHROPIC_BASE_URL"));
        assert!(should_strip("CLAUDECODE"));
        assert!(should_strip("CLAUDE_CODE_ENTRYPOINT"));
        assert!(should_strip("claude_code_session_id"));
        assert!(!should_strip("CLAUDE_CONFIG_DIR"));
        assert!(!should_strip("CLAUDE_CODE_OAUTH_TOKEN"));
        assert!(!should_strip("PATH"));
    }

    #[test]
    fn friendly_errors() {
        assert_eq!(friendly_error(Some(401), "x"), AUTH_HINT);
        assert_eq!(
            friendly_error(None, "OAuth access token has expired. Re-authenticate to continue."),
            AUTH_HINT
        );
        assert!(friendly_error(Some(429), "slow down").starts_with("Limite"));
        assert_eq!(friendly_error(Some(500), " boom "), "boom");
    }

    #[test]
    fn user_line_carries_images() {
        let msg = ChatMessage {
            role: "user".into(),
            content: "x".into(),
            images: vec![super::super::ImagePart { mime: "image/png".into(), data: "AAAA".into() }],
        };
        let line = user_line("bonjour", &msg);
        assert!(line.ends_with('\n'));
        let v: Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(v["type"], "user");
        assert_eq!(v["message"]["content"][0]["text"], "bonjour");
        assert_eq!(v["message"]["content"][1]["source"]["media_type"], "image/png");
    }
}

/// Tests contre la vraie CLI (abonnement connecté requis) :
/// `cargo test -- --ignored claude_live`.
#[cfg(test)]
mod live_tests {
    use super::*;
    use crate::ai::EditDocument;

    fn req(mode: ChatMode, text: &str, document: Option<EditDocument>) -> ChatRequest {
        ChatRequest {
            provider: "claude".into(),
            model: "haiku".into(),
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

    fn text_of(events: &Arc<Mutex<Vec<StreamEvent>>>) -> String {
        events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| match e {
                StreamEvent::Delta { text } => Some(text.clone()),
                _ => None,
            })
            .collect()
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn claude_live_detect() {
        let det = detect().await;
        assert_eq!(det["installed"], true, "{det}");
        assert!(det["version"].as_str().is_some_and(|v| !v.contains("Claude Code")), "{det}");
        assert!(det.get("email").is_none());
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn claude_live_chat_streams_and_keeps_session() {
        let provider = ClaudeCodeProvider::new(Arc::new(ClaudeManager::default()));
        let (sink, events) = collector();
        provider
            .chat(req(ChatMode::Chat, "Retiens le mot ANANAS et réponds seulement : OK", None), sink, CancelToken::default())
            .await
            .expect("tour 1");
        assert!(text_of(&events).to_uppercase().contains("OK"), "réponse : {}", text_of(&events));
        let (sink, events) = collector();
        provider
            .chat(req(ChatMode::Chat, "Quel mot t'ai-je demandé de retenir ? Un mot.", None), sink, CancelToken::default())
            .await
            .expect("tour 2");
        assert!(text_of(&events).to_uppercase().contains("ANANAS"), "réponse : {}", text_of(&events));
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn claude_live_edit_returns_document() {
        let provider = ClaudeCodeProvider::new(Arc::new(ClaudeManager::default()));
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
