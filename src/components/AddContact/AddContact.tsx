import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IconX } from "../icons";
import { BackendContact } from "../../types";
import "./AddContact.css";

interface Props {
  onClose: () => void;
  onAdded: (contact: BackendContact) => void | Promise<void>;
}

interface InspectedConnectionCode {
  server_url: string;
  server_name: string;
  is_known_private: boolean;
  is_official: boolean;
}

export default function AddContact({ onClose, onAdded }: Props) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // When set, we have decoded which relay the code routes through and are waiting
  // for the user to confirm before doing the slow Tor add.
  const [warn, setWarn] = useState<InspectedConnectionCode | null>(null);

  const runAdd = async (trimmed: string) => {
    setBusy(true);
    setError("");
    try {
      const contact = await invoke<BackendContact>("messaging_add_contact_from_code", {
        code: trimmed,
      });
      await onAdded(contact);
      onClose();
    } catch (e) {
      setError(typeof e === "string" ? e : "Could not add contact");
      setWarn(null);
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    const trimmed = code.trim();
    if (!trimmed || busy) return;
    setError("");
    // Decode the code locally first (no network) to see which relay it routes
    // through, and surface it for confirmation before connecting over Tor.
    let inspected: InspectedConnectionCode;
    try {
      inspected = await invoke<InspectedConnectionCode>("messaging_inspect_connection_code", {
        code: trimmed,
      });
    } catch (e) {
      setError(typeof e === "string" ? e : "Could not read connection code");
      return;
    }
    // The official relay is the client's own default, so it needs no extra trust
    // decision: add directly without the confirm-relay prompt. Any other relay
    // still gets confirmed before the slow Tor connect.
    if (inspected.is_official) {
      await runAdd(trimmed);
      return;
    }
    setWarn(inspected);
  };

  const confirmWarned = async () => {
    if (busy) return;
    await runAdd(code.trim());
  };

  const relayLabel = (info: InspectedConnectionCode) => {
    const name = info.server_name && info.server_name !== "Unknown relay" ? info.server_name : null;
    if (info.is_known_private && name) return `a private relay you've added (${name})`;
    if (name) return `“${name}”`;
    return "an unrecognized relay";
  };

  return (
    <>
      <div className="modal-backdrop" onClick={busy ? undefined : onClose} />
      <div className="modal add-contact-modal">
        <header className="modal-header">
          <div className="modal-title">Add contact</div>
          <button className="modal-close" onClick={onClose} aria-label="Close" disabled={busy}><IconX /></button>
        </header>

        <div className="modal-body">
          {warn && !busy ? (
            <>
              <div className="add-contact-warning">
                <div className="add-contact-warning-title">Confirm relay</div>
                <p className="add-contact-warning-text">
                  This connection code routes your messages with this contact through {relayLabel(warn)}.
                  Continue only if you trust whoever gave you this code.
                </p>
                <div className="add-contact-warning-url mono">{warn.server_url}</div>
              </div>

              <div className="add-contact-actions add-contact-actions-split">
                <button className="btn btn-secondary" onClick={() => setWarn(null)}>Cancel</button>
                <button className="btn btn-primary" onClick={confirmWarned}>Continue anyway</button>
              </div>
            </>
          ) : (
            <>
              <p className="add-contact-desc">Enter the connection code you received from someone to start an encrypted text conversation.</p>

              <input type="text" className="text-input mono add-contact-input" placeholder="axn1_..." value={code} onChange={e => { setCode(e.target.value); setError(""); }} autoFocus spellCheck={false} disabled={busy} onKeyDown={e => { if (e.key === "Enter") add(); }} />

              {error && <div className="onboarding-error">{error}</div>}

              <div className="add-contact-actions">
                <button className="btn btn-primary" disabled={!code.trim() || busy} onClick={add}>
                  {busy ? (
                    <><span className="onboarding-spinner" style={{ width: 16, height: 16, borderWidth: 2, marginRight: 8 }} /> Adding…</>
                  ) : "Add contact"}
                </button>
              </div>

              {busy && <div className="add-contact-busy-note">Connecting over Tor, this may take a minute…</div>}
            </>
          )}
        </div>
      </div>
    </>
  );
}
