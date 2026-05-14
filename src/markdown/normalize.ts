export function normalizeMarkdown(markdown: string): string {
  return markdown.replace(/(\d+)\\+\.(\s+)/g, "$1.$2");
}
