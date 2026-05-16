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
  /** Largeur de la zone de texte, en pourcentage de la largeur visible. */
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
};
