export function normalizeMarkdown(markdown: string): string {
  return markdown
    // Fichiers venant de Windows / messageries : BOM + fins de ligne CRLF/CR.
    // Le parseur raisonne ligne par ligne sur "\n" uniquement.
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/(\d+)\+\.(\s+)/g, "$1.$2");
}
