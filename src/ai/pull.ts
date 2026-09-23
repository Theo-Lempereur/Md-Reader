/** Installation de modèles Ollama et mesure de performance, hors composants :
 * le téléchargement tourne côté Rust quoi que fasse l'interface, sa
 * progression doit donc vivre dans le store et non dans l'écran qui l'a lancé. */

import { aiApi } from "./client";
import { refreshDetection } from "./status";
import { benchKey, getAi, notify, setAi, updateSettings } from "./useAi";

let cancelPull: (() => void) | null = null;

export function startPull(tag: string) {
  if (getAi().pull) return;
  setAi({ pull: { tag, status: "démarrage", ratio: null } });
  cancelPull = aiApi.pull(tag, (ev) => {
    if (ev.type === "progress") {
      setAi((s) =>
        s.pull?.tag === tag
          ? {
              pull: {
                tag,
                status: ev.status,
                ratio: ev.total ? (ev.completed ?? 0) / ev.total : s.pull.ratio,
              },
            }
          : {},
      );
      return;
    }
    cancelPull = null;
    setAi({ pull: null });
    if (ev.type === "done") {
      notify(`${tag} installé.`);
      void refreshDetection().then(() => runBench(tag));
    } else {
      notify(`Installation de ${tag} : ${ev.message}`, "error");
    }
  });
}

export function stopPull() {
  cancelPull?.();
}

export async function runBench(tag: string) {
  if (getAi().benching) return;
  setAi({ benching: tag });
  try {
    const b = await aiApi.benchmark("ollama", tag);
    updateSettings((s) => ({
      ...s,
      benchmarks: { ...s.benchmarks, [benchKey("ollama", tag)]: { ...b, at: Date.now() } },
    }));
  } catch (e) {
    notify(`Mesure impossible : ${e}`, "error");
  } finally {
    setAi({ benching: null });
  }
}
