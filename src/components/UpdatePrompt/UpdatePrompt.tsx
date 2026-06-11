import { useEffect, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { invoke } from "@tauri-apps/api/core";
import "./UpdatePrompt.css";

type Phase = "idle" | "available" | "downloading" | "ready" | "error";

/**
 * Checks GitHub Releases once on mount (when enabled) and, if a newer signed
 * build is available, prompts before downloading and installing it.
 *
 * When "Update over Tor" is on, both the check and the download are routed
 * through the local Arti SOCKS proxy, so GitHub never sees the user's IP. There
 * is no silent clearnet fallback: if Tor cannot reach GitHub (its CDN often
 * blocks Tor exits) the attempt fails and the user can retry or turn the option
 * off in Settings.
 */
export default function UpdatePrompt({ enabled, updateOverTor }: { enabled: boolean; updateOverTor: boolean }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [update, setUpdate] = useState<Update | null>(null);
  const [progress, setProgress] = useState(0);
  const [errorText, setErrorText] = useState("");
  // Whether the last failure was during the check or the download, so Retry
  // re-runs the right step.
  const [failedAction, setFailedAction] = useState<"check" | "download">("check");
  // Guard against React StrictMode double-invoking the effect (two checks), and
  // against setting state after unmount.
  const startedRef = useRef(false);
  const aliveRef = useRef(true);

  // Poll the backend for the Tor SOCKS proxy URL, which becomes available once
  // Tor finishes bootstrapping. Returns undefined if it does not come up in time.
  const resolveTorProxy = async (timeoutMs: number): Promise<string | undefined> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const url = await invoke<string | null>("tor_proxy_url");
        if (url) return url;
      } catch { /* ignore and retry */ }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return undefined;
  };

  const runCheck = async (manual: boolean) => {
    try {
      let proxy: string | undefined;
      if (updateOverTor) {
        // On the launch check, wait a while for Tor to bootstrap. On a manual
        // retry, only briefly: if Tor still is not up, say so rather than hang.
        proxy = await resolveTorProxy(manual ? 5000 : 90000);
        if (!proxy) {
          if (manual && aliveRef.current) {
            setFailedAction("check");
            setErrorText("Tor is not connected yet.");
            setPhase("error");
          }
          return; // Tor not ready: skip silently on the launch check.
        }
      }
      const found = await check(proxy ? { proxy } : {});
      if (!aliveRef.current) return;
      if (found) {
        setUpdate(found);
        setPhase("available");
      } else if (manual) {
        setPhase("idle");
        setUpdate(null);
      }
    } catch (e) {
      if (!aliveRef.current) return;
      setFailedAction("check");
      setErrorText(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  };

  useEffect(() => {
    aliveRef.current = true;
    if (!enabled || startedRef.current) return;
    startedRef.current = true;
    void runCheck(false);
    return () => { aliveRef.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  if (phase === "idle" || (!update && phase !== "error")) return null;

  const dismiss = () => {
    if (phase === "downloading") return; // don't cancel mid-install
    setPhase("idle");
    setUpdate(null);
  };

  const install = async () => {
    if (!update) return;
    setPhase("downloading");
    setProgress(0);
    try {
      let downloaded = 0;
      let total = 0;
      // Reuses the proxy the Update was checked with, so this stays on Tor when
      // the check was over Tor.
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? 0;
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            setProgress(total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0);
            break;
          case "Finished":
            setProgress(100);
            break;
        }
      });
      setPhase("ready");
      await relaunch();
    } catch (e) {
      setFailedAction("download");
      setErrorText(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  };

  const retry = () => { if (failedAction === "download") void install(); else void runCheck(true); };

  return (
    <>
      <div className="context-menu-backdrop" onClick={dismiss} />
      <div className="code-warning-modal update-modal">
        {phase === "available" && update && (
          <>
            <h3 className="code-warning-title">Update available</h3>
            <p className="code-warning-body">
              Axeno {update.version} is available
              {update.currentVersion ? ` (you have ${update.currentVersion})` : ""}. The
              update is cryptographically signed and verified before it is installed.
            </p>
            {update.body && <p className="update-notes">{update.body}</p>}
            <div className="code-warning-actions">
              <button className="btn btn-secondary" onClick={dismiss}>Later</button>
              <button className="btn btn-primary" onClick={install}>Install &amp; restart</button>
            </div>
          </>
        )}

        {phase === "downloading" && update && (
          <>
            <h3 className="code-warning-title">Installing update…</h3>
            <p className="code-warning-body">
              Downloading and verifying Axeno {update.version}{updateOverTor ? " over Tor" : ""}.
            </p>
            <div className="update-progress-track">
              <div className="update-progress-fill" style={{ width: `${progress}%` }} />
            </div>
            <p className="code-warning-note">{progress}%. The app will restart automatically.</p>
          </>
        )}

        {phase === "ready" && update && (
          <>
            <h3 className="code-warning-title">Restarting…</h3>
            <p className="code-warning-body">Axeno {update.version} has been installed.</p>
          </>
        )}

        {phase === "error" && (
          <>
            <div className="code-warning-icon">⚠️</div>
            <h3 className="code-warning-title">{updateOverTor ? "Update over Tor failed" : "Update failed"}</h3>
            <p className="code-warning-body">
              {updateOverTor
                ? "The update could not be completed. Your download may be blocked because you are using Tor. Retry, or turn off “Update over Tor” in Settings → About and try again."
                : "The update could not be completed."}
            </p>
            {errorText && <p className="code-warning-note mono">{errorText}</p>}
            <div className="code-warning-actions">
              <button className="btn btn-secondary" onClick={dismiss}>Close</button>
              <button className="btn btn-primary" onClick={retry}>Retry</button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
