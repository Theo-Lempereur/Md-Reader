import { Icon } from "./Icons";
import { basename } from "../lib/fileIo";

type Props = {
  open: boolean;
  setOpen: (v: boolean) => void;
  onNew: () => void;
  onOpen: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onExportPdf: () => void;
  onExportEmbeddedMd: () => void;
  recents: string[];
  onOpenRecent: (path: string) => void;
};

export function FileMenu({
  open,
  setOpen,
  onNew,
  onOpen,
  onSave,
  onSaveAs,
  onExportPdf,
  onExportEmbeddedMd,
  recents,
  onOpenRecent,
}: Props) {
  const run = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <div className="file-menu-wrap">
      <button
        type="button"
        className={`file-btn ${open ? "open" : ""}`}
        onClick={() => setOpen(!open)}
      >
        <span>Fichier</span>
        <Icon.ChevronDown />
      </button>
      {open && (
        <div className="file-menu" onMouseLeave={() => setOpen(false)}>
          <button onClick={run(onNew)}>
            <span className="menu-icon">
              <Icon.Plus />
            </span>
            Nouveau
            <span className="kbd">⌘N</span>
          </button>
          <button onClick={run(onOpen)}>
            <span className="menu-icon">
              <Icon.FileText />
            </span>
            Ouvrir…
            <span className="kbd">⌘O</span>
          </button>
          {recents.length > 0 && (
            <>
              <div className="file-menu-section">Récents</div>
              {recents.map((path) => (
                <button
                  key={path}
                  className="file-menu-recent"
                  title={path}
                  onClick={run(() => onOpenRecent(path))}
                >
                  <span className="menu-icon">
                    <Icon.FileText />
                  </span>
                  <span className="file-menu-recent-name">
                    {basename(path)}
                  </span>
                </button>
              ))}
            </>
          )}
          <hr />
          <button onClick={run(onSave)}>
            <span className="menu-icon">
              <Icon.Download />
            </span>
            Enregistrer
            <span className="kbd">⌘S</span>
          </button>
          <button onClick={run(onSaveAs)}>
            <span className="menu-icon">
              <Icon.Download />
            </span>
            Enregistrer sous…
            <span className="kbd">⇧⌘S</span>
          </button>
          <hr />
          <button onClick={run(onExportPdf)}>
            <span className="menu-icon">
              <Icon.Download />
            </span>
            Exporter en PDF…
          </button>
          <button onClick={run(onExportEmbeddedMd)}>
            <span className="menu-icon">
              <Icon.Download />
            </span>
            Exporter avec images embarquées…
          </button>
        </div>
      )}
    </div>
  );
}
