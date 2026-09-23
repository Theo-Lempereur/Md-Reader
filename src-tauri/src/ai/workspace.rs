//! Dossiers de travail temporaires pour Codex : on y copie le document (ou
//! les images jointes), Codex y travaille, on relit, puis le dossier est
//! supprimé à la destruction de la valeur.

use std::path::{Path, PathBuf};

pub struct Workspace {
    dir: PathBuf,
}

impl Workspace {
    pub fn create() -> Result<Self, String> {
        let dir = std::env::temp_dir()
            .join("md-reader-ai")
            .join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&dir).map_err(|e| format!("Dossier temporaire : {e}"))?;
        Ok(Self { dir })
    }

    pub fn path(&self) -> &Path {
        &self.dir
    }

    /// Écrit un fichier dans le dossier. Le nom est réduit à son composant
    /// final pour ne jamais sortir du dossier de travail.
    pub fn write(&self, name: &str, data: &[u8]) -> Result<PathBuf, String> {
        let file = sanitize_name(name);
        let path = self.dir.join(file);
        std::fs::write(&path, data).map_err(|e| format!("Écriture temporaire : {e}"))?;
        Ok(path)
    }

    pub fn read_text(&self, path: &Path) -> Result<String, String> {
        std::fs::read_to_string(path).map_err(|e| format!("Relecture du document : {e}"))
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

pub fn sanitize_name(name: &str) -> String {
    let base = Path::new(name)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let cleaned: String = base
        .chars()
        .map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { '_' } else { c })
        .collect();
    if cleaned.trim().is_empty() {
        "document.md".into()
    } else {
        cleaned
    }
}
