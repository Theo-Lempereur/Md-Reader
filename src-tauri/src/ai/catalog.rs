//! Catalogue des modèles locaux, embarqué dans le binaire et mis à jour
//! avec l'application. La règle de recommandation vit côté front.

const CATALOG: &str = include_str!("catalog.json");

pub fn catalog() -> Result<serde_json::Value, String> {
    serde_json::from_str(CATALOG).map_err(|e| format!("Catalogue invalide : {e}"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn catalog_parses() {
        let v = super::catalog().unwrap();
        assert!(v["models"].as_array().is_some_and(|m| !m.is_empty()));
    }
}
