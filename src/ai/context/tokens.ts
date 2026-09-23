import type { AiSettings, ProviderId } from "../types";

/** Estimation grossière mais stable : ≈ 4 caractères par token. */
export const estimateTokens = (chars: number) => Math.ceil(chars / 4);

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")} k`;
  return `${Math.round(n / 1000)} k`;
}

/** Fenêtre de contexte connue ou supposée pour un modèle. Les réglages
 * permettent de la forcer (utile pour Ollama, dont la fenêtre réelle dépend
 * de sa configuration). */
export function contextWindow(settings: AiSettings, provider: ProviderId, model: string): number {
  const forced = settings.contextWindows[provider];
  if (forced && forced > 0) return forced;
  const m = model.toLowerCase();
  switch (provider) {
    case "anthropic":
      return m.includes("haiku") ? 200_000 : 1_000_000;
    case "codex":
      return 200_000;
    case "openai":
      if (m.startsWith("gpt-4.1")) return 1_000_000;
      if (m.startsWith("gpt-5")) return 400_000;
      if (m.startsWith("o3") || m.startsWith("o4")) return 200_000;
      return 128_000;
    case "mistral":
      return 128_000;
    case "openrouter":
      if (m.includes("claude")) return 200_000;
      if (m.includes("gemini")) return 1_000_000;
      return 128_000;
    case "ollama":
    case "lmstudio":
      // Valeur prudente : la fenêtre réellement allouée par le serveur local
      // est souvent bien plus petite que celle du modèle.
      return 8192;
  }
}
