/**
 * Contenu de la page "Bienvenue.md" affichée au tout premier lancement de
 * l'application, ainsi qu'en état vide quand aucun fichier récent n'existe.
 */
export const WELCOME_MD = `# Bienvenue dans Md-Reader

Un lecteur et éditeur Markdown léger, pensé pour rester proche du texte tout en offrant un rendu agréable.

## Lecture & édition

- **Lecture** par défaut : le markdown est rendu joliment, sans distraction.
- **Édition** : \`Ctrl+M\` (ou bouton **Modification** en haut à droite). Le rendu reste affiché — vous tapez directement dans le résultat.

## Deux vues, un seul document

- **Preview** : rendu WYSIWYG, idéal pour relire ou modifier au fil du texte.
- **Source** : \`Alt+S\` en mode édition. La source markdown brute, avec coloration et numéros de ligne.

Le caret et la position de défilement sont mémorisés indépendamment pour chaque vue et chaque onglet : un aller-retour vous ramène exactement où vous étiez.

## Slash menu

En mode édition, tapez \`/\` pour insérer rapidement un bloc : titres, listes, citations, tables, blocs de code, formules mathématiques, séparateurs… Naviguez avec ↑/↓, validez avec \`Entrée\`.

## Raccourcis essentiels

| Raccourci | Action |
|-----------|--------|
| \`Ctrl+N\` | Nouveau document |
| \`Ctrl+O\` | Ouvrir un fichier |
| \`Ctrl+S\` | Enregistrer |
| \`Ctrl+Maj+S\` | Enregistrer sous… |
| \`Ctrl+M\` | Basculer lecture / édition |
| \`Alt+S\` | Basculer preview / source |
| \`Ctrl+F\` | Rechercher dans le document |
| \`Ctrl+P\` | Imprimer |

## Personnalisation

Ouvrez le panneau **Tweaks** (icône engrenage) pour ajuster :

- thème clair ou sombre
- palette de couleurs (graphite, encre, sépia, forêt)
- police (sans, serif, mono)
- densité d'affichage (aéré, compact)
- largeur de la zone de texte (\`Ctrl + molette\` pour ajuster à la volée)
- style des onglets, position de la barre d'outils
- synchronisation du scroll entre preview et source latérale
- sauvegarde automatique

## Export PDF

Depuis le menu **Fichier → Exporter en PDF…**, choisissez le format (A4 ou Letter) et le mode de couleur. Le rendu produit est identique à la preview.

## Fichiers récents

Les fichiers que vous ouvrez s'ajoutent automatiquement à la liste **Fichier → Récents** (10 derniers). Vous les retrouvez aussi directement sur cet écran d'accueil quand aucun onglet n'est ouvert.

---

Fermez cet onglet pour commencer, ou créez un nouveau document avec \`Ctrl+N\`. Bonne écriture !
`;
