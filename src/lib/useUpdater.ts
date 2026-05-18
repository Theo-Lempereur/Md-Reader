import { useEffect, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdaterStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "error";

export type UpdaterState = {
  status: UpdaterStatus;
  update: Update | null;
  version: string | null;
  progress: number;
  error: string | null;
  install: () => Promise<void>;
  recheck: () => Promise<void>;
};

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function useUpdater(): UpdaterState {
  const [status, setStatus] = useState<UpdaterStatus>("idle");
  const [update, setUpdate] = useState<Update | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const runCheck = async () => {
    setStatus("checking");
    setError(null);
    try {
      const next = await check();
      if (next?.available) {
        setUpdate(next);
        setVersion(next.version);
        setStatus("available");
      } else {
        setUpdate(null);
        setVersion(null);
        setStatus("idle");
      }
    } catch (e) {
      setError(String(e));
      setStatus("error");
    }
  };

  useEffect(() => {
    runCheck();
    const id = window.setInterval(runCheck, CHECK_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, []);

  const install = async () => {
    if (!update) return;
    setStatus("downloading");
    setProgress(0);
    setError(null);
    try {
      let downloaded = 0;
      let total = 0;
      await update.downloadAndInstall((evt) => {
        switch (evt.event) {
          case "Started":
            total = evt.data.contentLength ?? 0;
            break;
          case "Progress":
            downloaded += evt.data.chunkLength;
            setProgress(total > 0 ? downloaded / total : 0);
            break;
          case "Finished":
            setProgress(1);
            setStatus("ready");
            break;
        }
      });
      await relaunch();
    } catch (e) {
      setError(String(e));
      setStatus("error");
    }
  };

  return {
    status,
    update,
    version,
    progress,
    error,
    install,
    recheck: runCheck,
  };
}
