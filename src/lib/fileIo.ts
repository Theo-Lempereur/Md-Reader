import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { PdfColorMode, PdfPageFormat } from "../types";

export type OpenedFile = {
  path: string;
  name: string;
  content: string;
};

const MD_FILTERS = [
  { name: "Markdown", extensions: ["md", "markdown", "txt"] },
];

const IMAGE_FILTERS = [
  {
    name: "Image",
    extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"],
  },
];

export async function openFileDialog(): Promise<OpenedFile | null> {
  const selected = await open({
    multiple: false,
    filters: MD_FILTERS,
  });
  if (!selected || typeof selected !== "string") return null;
  const content = await invoke<string>("read_text_file", { path: selected });
  return {
    path: selected,
    name: basename(selected),
    content,
  };
}

export async function readFileByPath(path: string): Promise<OpenedFile> {
  const content = await invoke<string>("read_text_file", { path });
  return {
    path,
    name: basename(path),
    content,
  };
}

export async function saveAsDialog(
  content: string,
  suggestedName: string,
): Promise<string | null> {
  const target = await save({
    defaultPath: suggestedName,
    filters: MD_FILTERS,
  });
  if (!target) return null;
  await invoke("write_text_file", { path: target, content });
  return target;
}

export async function writeToPath(
  path: string,
  content: string,
): Promise<void> {
  await invoke("write_text_file", { path, content });
}

export function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export async function openImageDialog(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    filters: IMAGE_FILTERS,
  });
  if (!selected || typeof selected !== "string") return null;
  return selected;
}

export async function copyImageAsset(srcPath: string): Promise<string> {
  return await invoke<string>("copy_image_asset", { srcPath });
}

export async function readImageAsDataUri(path: string): Promise<string> {
  return await invoke<string>("read_image_as_data_uri", { path });
}

const IMAGE_MD_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const IMAGE_HTML_RE = /<img\b([^>]*)\/?>/gi;
const ATTR_SRC_RE = /\bsrc\s*=\s*"([^"]*)"/i;

function isLocalImageRef(src: string): boolean {
  if (!src) return false;
  if (/^(https?:|data:|blob:|asset:|http:\/\/asset\.localhost)/i.test(src))
    return false;
  return true;
}

/** Génère une copie du markdown courant où chaque image locale est inlinée
 * en data URI. Les URLs distantes / data: sont laissées intactes. */
export async function embedLocalImages(markdown: string): Promise<string> {
  const replacements = new Map<string, string>();
  const collect = (src: string) => {
    if (!isLocalImageRef(src)) return;
    if (replacements.has(src)) return;
    replacements.set(src, src);
  };
  let m: RegExpExecArray | null;
  IMAGE_MD_RE.lastIndex = 0;
  while ((m = IMAGE_MD_RE.exec(markdown)) !== null) collect(m[2]);
  IMAGE_HTML_RE.lastIndex = 0;
  while ((m = IMAGE_HTML_RE.exec(markdown)) !== null) {
    const attrs = m[1] ?? "";
    const srcMatch = ATTR_SRC_RE.exec(attrs);
    if (srcMatch) collect(srcMatch[1]);
  }

  await Promise.all(
    Array.from(replacements.keys()).map(async (path) => {
      try {
        const uri = await readImageAsDataUri(path);
        replacements.set(path, uri);
      } catch (e) {
        console.warn("embedLocalImages: échec lecture", path, e);
      }
    }),
  );

  let out = markdown.replace(IMAGE_MD_RE, (full, alt, src) => {
    const replaced = replacements.get(src);
    return replaced && replaced !== src ? `![${alt}](${replaced})` : full;
  });
  out = out.replace(IMAGE_HTML_RE, (full, attrs) => {
    const srcMatch = ATTR_SRC_RE.exec(attrs);
    if (!srcMatch) return full;
    const replaced = replacements.get(srcMatch[1]);
    if (!replaced || replaced === srcMatch[1]) return full;
    const newAttrs = attrs.replace(ATTR_SRC_RE, `src="${replaced}"`);
    return `<img${newAttrs} />`;
  });
  return out;
}

export async function exportEmbeddedMarkdownDialog(
  content: string,
  suggestedName: string,
): Promise<string | null> {
  const baseName = suggestedName.replace(/\.(md|markdown|txt)$/i, "");
  const target = await save({
    defaultPath: `${baseName}.embedded.md`,
    filters: MD_FILTERS,
  });
  if (!target) return null;
  const embedded = await embedLocalImages(content);
  await invoke("write_text_file", { path: target, content: embedded });
  return target;
}

export async function exportPdfDialog(
  suggestedName: string,
  options: { format: PdfPageFormat; colorMode: PdfColorMode },
): Promise<string | null> {
  const defaultPath = suggestedName.replace(/\.(md|markdown|txt)$/i, "") + ".pdf";
  const target = await save({
    defaultPath,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!target) return null;

  // Configure le rendu DOM avant l'appel natif : le PDF est généré à partir
  // de l'état visible de la webview à l'instant T.
  document.body.classList.add("is-exporting-pdf");
  document.body.dataset.pdfColors = options.colorMode;

  // Petit délai pour laisser le navigateur appliquer les styles avant capture.
  await new Promise((r) => setTimeout(r, 50));

  // Attend que toutes les images soient chargées (sinon le PDF capture des
  // emplacements vides). On laisse 5s max par image avant d'abandonner.
  const imgs = Array.from(document.querySelectorAll("img"));
  await Promise.all(
    imgs.map((img) => {
      if (img.complete && img.naturalWidth > 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const done = () => resolve();
        img.addEventListener("load", done, { once: true });
        img.addEventListener("error", done, { once: true });
        setTimeout(done, 5000);
      });
    }),
  );

  try {
    await invoke("export_pdf", { path: target, format: options.format });
    return target;
  } finally {
    document.body.classList.remove("is-exporting-pdf");
    delete document.body.dataset.pdfColors;
  }
}
