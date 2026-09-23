//! Clés API dans le Gestionnaire d'identification Windows (service
//! `md-reader`, compte = identifiant du fournisseur). Jamais sur disque en
//! clair, jamais dans le webview.

use keyring::{Entry, Error};

const SERVICE: &str = "md-reader";

fn entry(provider: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, provider).map_err(|e| format!("Trousseau indisponible : {e}"))
}

pub fn save(provider: &str, key: &str) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("Clé vide.".into());
    }
    entry(provider)?
        .set_password(key)
        .map_err(|e| format!("Enregistrement de la clé impossible : {e}"))
}

pub fn delete(provider: &str) -> Result<(), String> {
    match entry(provider)?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Suppression de la clé impossible : {e}")),
    }
}

pub fn get(provider: &str) -> Result<Option<String>, String> {
    match entry(provider)?.get_password() {
        Ok(k) => Ok(Some(k)),
        Err(Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Lecture de la clé impossible : {e}")),
    }
}

pub fn has(provider: &str) -> bool {
    matches!(get(provider), Ok(Some(_)))
}
