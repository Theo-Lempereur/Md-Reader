import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

export type OpenedFile = {
  path: string;
  name: string;
  content: string;
};

const MD_FILTERS = [
  { name: "Markdown", extensions: ["md", "markdown", "txt"] },
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
