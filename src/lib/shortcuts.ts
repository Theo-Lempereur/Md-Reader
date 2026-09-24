/**
 * Catalogue des raccourcis clavier, affiché par la modale « Raccourcis ».
 * Source unique à tenir à jour quand on ajoute un gestionnaire `keydown`.
 *
 * Les touches s'écrivent de façon neutre (`Mod` = Ctrl, ou ⌘ sur macOS) et
 * sont converties à l'affichage par `formatKeys`.
 */

export type Shortcut = {
  /** Combinaisons alternatives ; chaque combinaison est une suite de touches. */
  keys: string[][];
  label: string;
  /** Précision sur le contexte (mode, élément ciblé…). */
  hint?: string;
};

export type ShortcutGroup = {
  title: string;
  /** Groupe visible seulement si l'assistant IA est compilé. */
  ai?: boolean;
  items: Shortcut[];
};

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "Fichiers",
    items: [
      { keys: [["Mod", "N"]], label: "Nouveau document" },
      { keys: [["Mod", "O"]], label: "Ouvrir un fichier" },
      { keys: [["Mod", "S"]], label: "Enregistrer" },
      { keys: [["Mod", "Shift", "S"]], label: "Enregistrer sous…" },
      { keys: [["Mod", "P"]], label: "Imprimer" },
    ],
  },
  {
    title: "Affichage",
    items: [
      { keys: [["Mod", "M"]], label: "Basculer lecture / édition" },
      {
        keys: [["Alt", "S"]],
        label: "Basculer preview / source",
        hint: "en mode édition",
      },
      { keys: [["Alt", "P"]], label: "Fermer le panneau latéral" },
      { keys: [["Ctrl", "Molette"]], label: "Ajuster la largeur du texte" },
      { keys: [["Mod", "Clic"]], label: "Ouvrir un lien" },
    ],
  },
  {
    title: "Recherche",
    items: [
      { keys: [["Mod", "F"]], label: "Rechercher dans le document" },
      { keys: [["Entrée"]], label: "Occurrence suivante" },
      { keys: [["Shift", "Entrée"]], label: "Occurrence précédente" },
      { keys: [["Échap"]], label: "Fermer la recherche" },
    ],
  },
  {
    title: "Édition",
    items: [
      { keys: [["Mod", "Z"]], label: "Annuler" },
      { keys: [["Mod", "Y"], ["Mod", "Shift", "Z"]], label: "Rétablir" },
      {
        keys: [["Mod", "L"]],
        label: "Aller en fin de bloc",
        hint: "fin de ligne en mode source",
      },
      {
        keys: [["Mod", "Entrée"]],
        label: "Passer au bloc suivant",
        hint: "ligne suivante en mode source",
      },
      {
        keys: [["Alt", "Entrée"]],
        label: "Insérer une ligne vide en dessous",
        hint: "mode source",
      },
    ],
  },
  {
    title: "Slash menu",
    items: [
      { keys: [["/"]], label: "Ouvrir le menu d'insertion" },
      { keys: [["↑"], ["↓"]], label: "Naviguer dans les commandes" },
      { keys: [["Entrée"], ["Tab"]], label: "Insérer la commande" },
      { keys: [["Échap"]], label: "Fermer le menu" },
    ],
  },
  {
    title: "Tableaux & formules",
    items: [
      { keys: [["Tab"]], label: "Cellule suivante", hint: "crée une ligne en fin de tableau" },
      { keys: [["Shift", "Tab"]], label: "Cellule précédente" },
      { keys: [["Mod", "Entrée"]], label: "Cellule du dessous" },
      { keys: [["Tab"]], label: "Placeholder suivant", hint: "dans une formule" },
      { keys: [["Entrée"]], label: "Valider la formule" },
      {
        keys: [["Entrée"]],
        label: "Sortir du format en cours",
        hint: "après /gras, /italique, /barré",
      },
    ],
  },
  {
    title: "Assistant IA",
    ai: true,
    items: [
      { keys: [["Mod", "J"]], label: "Ouvrir / fermer l'assistant" },
      { keys: [["Entrée"]], label: "Envoyer le message" },
      { keys: [["Shift", "Entrée"]], label: "Retour à la ligne dans le message" },
      { keys: [["Ctrl", "Espace"]], label: "Proposer une suite au texte" },
      { keys: [["Tab"]], label: "Accepter la suggestion" },
      { keys: [["Échap"]], label: "Rejeter la suggestion" },
    ],
  },
];

/** Événement global qui ouvre la modale (émis par la commande `/raccourcis`). */
export const OPEN_SHORTCUTS_EVENT = "md-reader:open-shortcuts";

export function openShortcuts() {
  window.dispatchEvent(new Event(OPEN_SHORTCUTS_EVENT));
}

const IS_MAC =
  typeof navigator !== "undefined" && /mac os/i.test(navigator.userAgent);

const MAC_KEYS: Record<string, string> = {
  Mod: "⌘",
  Ctrl: "⌃",
  Shift: "⇧",
  Alt: "⌥",
  Entrée: "↩",
};

const PC_KEYS: Record<string, string> = {
  Mod: "Ctrl",
  Shift: "Maj",
};

/** Libellés adaptés à la plateforme (Ctrl / Maj sur PC, ⌘ / ⇧ sur macOS). */
export function formatKeys(combo: string[]): string[] {
  const map = IS_MAC ? MAC_KEYS : PC_KEYS;
  return combo.map((k) => map[k] ?? k);
}
