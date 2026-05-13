import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Icon } from "./Icons";

export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
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

  const win = getCurrentWindow();
  const onMinimize = () => win.minimize();
  const onToggleMaximize = () => win.toggleMaximize();
  const onClose = () => win.close();

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
