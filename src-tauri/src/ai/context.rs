//! Lecture d'un fichier ou parcours d'un dossier à joindre au contexte :
//! profondeur limitée, extensions texte uniquement, dossiers lourds exclus,
//! plafonds de taille explicites (jamais de troncature silencieuse : ce qui
//! est laissé de côté est compté et signalé).

use std::path::{Path, PathBuf};

use base64::Engine as _;
use serde_json::{json, Value};

const MAX_DEPTH: usize = 5;
const MAX_FILES: usize = 400;
const MAX_FILE_BYTES: u64 = 256 * 1024;
const MAX_TOTAL_CHARS: usize = 1_500_000;
const MAX_IMAGE_BYTES: u64 = 8 * 1024 * 1024;

const TEXT_EXTENSIONS: &[&str] = &[
    "md", "markdown", "mdx", "txt", "rst", "adoc", "json", "jsonc", "csv", "tsv", "yaml", "yml",
    "toml", "ini", "cfg", "xml", "html", "htm", "css", "scss", "sass", "less", "js", "jsx", "mjs",
    "cjs", "ts", "tsx", "vue", "svelte", "py", "rb", "go", "rs", "java", "kt", "kts", "scala",
    "swift", "c", "h", "cc", "cpp", "hpp", "cs", "fs", "php", "lua", "r", "jl", "dart", "sh",
    "bash", "zsh", "ps1", "psm1", "bat", "cmd", "sql", "graphql", "proto", "tex", "bib", "dockerfile",
    "gradle", "properties", "env.example",
];

const EXCLUDED_DIRS: &[&str] = &[
    "node_modules", ".git", ".hg", ".svn", "target", "dist", "build", "out", ".next", ".nuxt",
    ".svelte-kit", ".turbo", ".cache", ".venv", "venv", "env", "__pycache__", ".mypy_cache",
    ".pytest_cache", ".idea", ".vscode", ".gradle", "vendor", "coverage", "bin", "obj",
];

fn image_mime(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => return None,
    })
}

fn ext_of(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default()
}

fn is_text_file(path: &Path) -> bool {
    let ext = ext_of(path);
    if TEXT_EXTENSIONS.contains(&ext.as_str()) {
        return true;
    }
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    matches!(
        name.as_str(),
        "dockerfile" | "makefile" | "license" | "readme" | ".gitignore" | ".editorconfig"
    )
}

fn read_text(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    // Fichier binaire déguisé : on l'ignore.
    if bytes.iter().take(4096).any(|&b| b == 0) {
        return None;
    }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

pub fn read_path(path: &str) -> Result<Value, String> {
    let root = PathBuf::from(path);
    let meta = std::fs::metadata(&root).map_err(|e| format!("Chemin inaccessible : {e}"))?;
    let name = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());

    if meta.is_file() {
        let ext = ext_of(&root);
        if let Some(mime) = image_mime(&ext) {
            if meta.len() > MAX_IMAGE_BYTES {
                return Err("Image trop volumineuse (8 Mo maximum).".into());
            }
            let data = std::fs::read(&root).map_err(|e| e.to_string())?;
            return Ok(json!({
                "kind": "image",
                "name": name,
                "path": path,
                "mime": mime,
                "data": base64::engine::general_purpose::STANDARD.encode(data),
            }));
        }
        if meta.len() > MAX_FILE_BYTES * 4 {
            return Err("Fichier trop volumineux (1 Mo maximum).".into());
        }
        let content = read_text(&root).ok_or("Fichier binaire ou illisible.")?;
        return Ok(json!({
            "kind": "file",
            "name": name,
            "path": path,
            "files": [{ "path": name, "content": content }],
            "totalChars": content.chars().count(),
            "skipped": 0,
            "truncated": false,
        }));
    }

    let mut files = Vec::new();
    let mut total_chars = 0usize;
    let mut skipped = 0usize;
    let mut truncated = false;
    walk(
        &root,
        &root,
        0,
        &mut files,
        &mut total_chars,
        &mut skipped,
        &mut truncated,
    );
    Ok(json!({
        "kind": "folder",
        "name": name,
        "path": path,
        "files": files,
        "totalChars": total_chars,
        "skipped": skipped,
        "truncated": truncated,
    }))
}

fn walk(
    root: &Path,
    dir: &Path,
    depth: usize,
    files: &mut Vec<Value>,
    total_chars: &mut usize,
    skipped: &mut usize,
    truncated: &mut bool,
) {
    if depth > MAX_DEPTH {
        *truncated = true;
        return;
    }
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = read.filter_map(Result::ok).collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let path = entry.path();
        let Ok(ft) = entry.file_type() else { continue };
        let fname = entry.file_name().to_string_lossy().into_owned();
        if ft.is_dir() {
            if EXCLUDED_DIRS.contains(&fname.as_str()) || fname.starts_with('.') {
                continue;
            }
            walk(root, &path, depth + 1, files, total_chars, skipped, truncated);
            continue;
        }
        if !ft.is_file() || !is_text_file(&path) {
            continue;
        }
        if files.len() >= MAX_FILES || *total_chars >= MAX_TOTAL_CHARS {
            *truncated = true;
            *skipped += 1;
            continue;
        }
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        if size > MAX_FILE_BYTES {
            *skipped += 1;
            continue;
        }
        let Some(content) = read_text(&path) else {
            *skipped += 1;
            continue;
        };
        let rel = path
            .strip_prefix(root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or(fname);
        *total_chars += content.chars().count();
        files.push(json!({ "path": rel, "content": content }));
    }
}
