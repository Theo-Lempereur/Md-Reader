export type MdFile = {
  id: string;
  name: string;
  content: string;
  /** Chemin disque absolu, undefined pour les onglets non encore sauvegardés. */
  path?: string;
  /** Modifications non sauvegardées. */
  dirty?: boolean;
};

export type Theme = "light" | "dark";
export type Palette = "graphite" | "encre" | "sepia" | "foret";
export type FontVariant = "sans" | "serif" | "mono";
export type Density = "aere" | "compact";
export type TabStyle = "browser" | "vscode" | "pastille";
export type ToolbarPos = "top" | "floating";
export type ViewMode = "preview" | "source";

export type PdfPageFormat = "a4" | "letter";
export type PdfColorMode = "bw" | "palette-light" | "palette-exact";

export type Tweaks = {
  theme: Theme;
  palette: Palette;
  font: FontVariant;
  density: Density;
  tabStyle: TabStyle;
  toolbarPos: ToolbarPos;
  autoSave: boolean;
  /** Largeur fixe de la zone de texte, en pixels. */
  textWidth: number;
  /** Synchronisation du scroll entre la preview et la source latérale. */
  syncScroll: boolean;
  /** Format de page pour l'export PDF. */
  pdfPageFormat: PdfPageFormat;
  /** Mode de couleurs pour l'export PDF. */
  pdfColorMode: PdfColorMode;
};

export type SearchHit = {
  line: number;
  start: number;
  end: number;
};

/** Position du caret dans la vue Source (ligne 0-indexée, colonne en caractères). */
export type SourceCaret = { line: number; column: number };

/** Position du caret dans le WYSIWYG, exprimée en offset textuel cumulé depuis la racine. */
export type PreviewCaret = { offset: number };

/** État UI mémorisé par fichier, séparé pour chaque vue. */
export type PersistedUiState = {
  source?: { caret?: SourceCaret; scrollTop?: number };
  preview?: { caret?: PreviewCaret; scrollTop?: number };
};

/** Forme persistée de la session (localStorage + Tauri store). */
export type PersistedSession = {
  openPaths: string[];
  activePath: string | null;
  perFile: Record<string, PersistedUiState>;
  /** Historique des fichiers ouverts, plus récent en tête, max 10 entrées. */
  recentPaths: string[];
  /** Vrai dès qu'on a affiché l'onglet Bienvenue au premier lancement. */
  firstRunDone: boolean;
};
