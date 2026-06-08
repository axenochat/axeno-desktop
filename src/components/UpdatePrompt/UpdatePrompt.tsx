import { useEffect, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import "./UpdatePrompt.css";

type Phase = "idle" | "available" | "downloading" | "ready" | "error";

/**
 * Checks GitHub Releases once on mount (when enabled) and, if a newer signed
 * build is available, prompts the user before downloading and installing it.
 *
 * Privacy note: the check is a direct HTTPS request to github.com and is NOT
 * routed through Tor, so it reveals the user's IP to GitHub and signals that
 * they run Axeno. It is therefore gated behind the `enabled` setting, which the
 * user can turn off in Settings → About.
 */
export default function UpdatePrompt({ enabled }: { enabled: boolean }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [update, setUpdate] = useState<Update | null>(null);
  const [progress, setProgress] = useState(0);
  const [errorText, setErrorText] = useState("");
  // Guard against React 18/19 StrictMode double-invoking the effect, which
  // would fire two concurrent update checks.
  const checkedRef = useRef(false);

  useEffect(() => {
    if (!enabled || checkedRef.current) return;
    checkedRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        const found = await check();
        if (!cancelled && found) {
          setUpdate(found);
          setPhase("available");
        }
      } catch {
        // Offline, behind a captive portal, or GitHub unreachable: stay silent.
        // Update checks must never interrupt normal use.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  if (phase === "idle" || !update) return null;

  const dismiss = () => {
    if (phase === "downloading") return; // don't allow cancelling mid-install
    setPhase("idle");
    setUpdate(null);
  };

  const install = async () => {
    setPhase("downloading");
    setProgress(0);
    try {
      let downloaded = 0;
      let total = 0;
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
      setErrorText(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  };

  return (
    <>
      <div className="context-menu-backdrop" onClick={dismiss} />
      <div className="code-warning-modal update-modal">
        {phase === "available" && (
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

        {phase === "downloading" && (
          <>
            <h3 className="code-warning-title">Installing update…</h3>
            <p className="code-warning-body">Downloading and verifying Axeno {update.version}.</p>
            <div className="update-progress-track">
              <div className="update-progress-fill" style={{ width: `${progress}%` }} />
            </div>
            <p className="code-warning-note">{progress}% — the app will restart automatically.</p>
          </>
        )}

        {phase === "ready" && (
          <>
            <h3 className="code-warning-title">Restarting…</h3>
            <p className="code-warning-body">Axeno {update.version} has been installed.</p>
          </>
        )}

        {phase === "error" && (
          <>
            <div className="code-warning-icon">⚠️</div>
            <h3 className="code-warning-title">Update failed</h3>
            <p className="code-warning-body">The update could not be installed.</p>
            {errorText && <p className="code-warning-note mono">{errorText}</p>}
            <div className="code-warning-actions">
              <button className="btn btn-secondary" onClick={dismiss}>Close</button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
