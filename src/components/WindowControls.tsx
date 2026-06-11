import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Icon } from "./Icons";

/** getCurrentWindow() jette hors contexte Tauri (dev navigateur) : on ne
 * doit jamais laisser ça faire tomber tout le rendu de l'app. */
function tryGetCurrentWindow() {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = tryGetCurrentWindow();
    if (!win) return;
    let unlisten: (() => void) | undefined;

    win.isMaximized().then(setMaximized).catch(() => {});
    win
      .onResized(() => {
        win.isMaximized().then(setMaximized).catch(() => {});
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});

    return () => {
      unlisten?.();
    };
  }, []);

  const onMinimize = () => void tryGetCurrentWindow()?.minimize();
  const onToggleMaximize = () => void tryGetCurrentWindow()?.toggleMaximize();
  const onClose = () => void tryGetCurrentWindow()?.close();

  return (
    <div className="win-controls">
      <button
        type="button"
        className="win-ctl"
        onClick={onMinimize}
        title="Réduire"
        aria-label="Réduire"
      >
        <Icon.WinMinimize />
      </button>
      <button
        type="button"
        className="win-ctl"
        onClick={onToggleMaximize}
        title={maximized ? "Restaurer" : "Agrandir"}
        aria-label={maximized ? "Restaurer" : "Agrandir"}
      >
        {maximized ? <Icon.WinRestore /> : <Icon.WinMaximize />}
      </button>
      <button
        type="button"
        className="win-ctl win-ctl-close"
        onClick={onClose}
        title="Fermer"
        aria-label="Fermer"
      >
        <Icon.WinClose />
      </button>
    </div>
  );
}
