import type { MdFile } from "../types";

export const SAMPLE_FILES: MdFile[] = [
  {
    id: "journal",
    name: "journal-12-mai.md",
    content: `# Journal — mardi 12 mai

Réveil à 7h12. Le café fume sur le bureau, dehors la rue est encore vide.

## Pensées du matin

Hier soir j'ai relu le brief du **client Aurore** : c'est plus clair que je le craignais. Trois points à trancher aujourd'hui :

- Valider la **direction visuelle** avec Camille
- Renvoyer le devis avant 11h
- Appeler *Théo* pour le pitch de jeudi

> La meilleure idée d'aujourd'hui : simplifier le formulaire d'inscription. On a empilé des champs "au cas où". Tout dégager sauf email + nom.

## À midi

Déjeuner rapide. J'ai lu trois pages de Bachelard, *La poétique de l'espace*. Cette phrase m'a marqué : la maison nous protège des orages célestes.

### Choses faites

1. Compte-rendu envoyé
2. Rétro préparée
3. Bureau rangé (presque)

Voir [le doc partagé](#) pour les détails.

\`git push origin main\` — fait, ça compile.

---

## Soir

Bonne journée dans l'ensemble. Quelques frictions sur le ~~vieux~~ nouveau dashboard mais rien d'insoluble. Demain : focus sur le **design system**, et essayer de ne pas ouvrir Slack avant 10h.
`,
  },
  {
    id: "sprint",
    name: "sprint-18.md",
    content: `# Réunion produit — Sprint 18

**Date :** 11 mai 2026
**Présents :** Camille, Léo, Anaïs, Théo

## Ordre du jour

1. Revue du sprint 17
2. Objectifs sprint 18
3. Blocages techniques

## Décisions

- On reporte la **refonte du dashboard** au sprint 19
- *Léo* prend le lead sur l'export PDF
- Validation du nouveau composant \`Card\` après revue de Camille

> "On garde le scope minimal et on livre vite. On peut toujours ajouter, jamais retirer." — Camille

### Prochaines étapes

- [ ] Mettre à jour le board Notion
- [x] Envoyer le récap par email
- [ ] Planifier la démo de jeudi avec les stakeholders
- [ ] Préparer 3 maquettes pour l'onboarding

---

Prochaine réunion : **mardi 19 mai, 10h**.
`,
  },
  {
    id: "idees",
    name: "idees-vrac.md",
    content: `# Idées vrac

Quelques pensées en désordre que je veux garder quelque part avant qu'elles s'évaporent.

## Pour le produit

- Mode lecture *zen* avec un compteur de temps discret en bas
- Synchronisation iCloud / Drive (mais sans compte obligatoire)
- Plug-ins markdown : diagrammes, math, schémas
- Export en \`.epub\` pour les longs documents

## Pour soi

- Reprendre **Bachelard**, finir *La poétique de l'espace*
- Recommencer le piano (au moins 10 min/jour)
- Cours d'italien — duolingo ne suffit plus
- Voir l'expo Calder avant qu'elle ferme

## Citations à ne pas oublier

> Le simple est juste, le vrai est facile.

> Faire, défaire, refaire — c'est encore travailler.
`,
  },
];
