import { Icon } from "./Icons";

type Props = {
  open: boolean;
  setOpen: (v: boolean) => void;
  onNew: () => void;
  onOpen: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onExportPdf: () => void;
};

export function FileMenu({
  open,
  setOpen,
  onNew,
  onOpen,
  onSave,
  onSaveAs,
  onExportPdf,
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
        </div>
      )}
    </div>
  );
}
