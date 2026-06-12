import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { BackendContact, Contact, contactFromBackend } from "../../types";
import { IconArrowLeft, IconCopy, IconCheck, IconShield, IconUserX } from "../icons";
import { contactDisplayName } from "../../utils";
import "./VerifyIdentity.css";

interface Props {
  contact: Contact;
  onClose: () => void;
  onContactUpdated: (contact: Contact) => void;
}

interface VerificationCodeResponse {
  code: string;
  safety_number: string;
  created_at: number;
}

function safetyGroups(value?: string): string[] {
  const raw = (value || "").replace(/[^a-fA-F0-9]/g, "").toUpperCase();
  if (!raw) return ["PENDING"];
  const groups = raw.match(/.{1,4}/g) || ["PENDING"];
  return groups.slice(0, 12);
}

function compactCode(code: string): string {
  if (code.length <= 52) return code;
  return `${code.slice(0, 28)}…${code.slice(-16)}`;
}

export default function VerifyIdentity({ contact, onClose, onContactUpdated }: Props) {
  const [verified, setVerified] = useState(contact.trustState === "verified");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [myCode, setMyCode] = useState("");
  const [theirCode, setTheirCode] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setVerified(contact.trustState === "verified");
  }, [contact.trustState]);

  useEffect(() => {
    let cancelled = false;
    setError("");
    setMyCode("");
    invoke<VerificationCodeResponse>("messaging_verification_code_for_contact", { contactId: contact.id })
      .then((res) => { if (!cancelled) setMyCode(res.code); })
      .catch((e) => {
        if (!cancelled) setError(typeof e === "string" ? e : "Could not create verification code yet");
      });
    return () => { cancelled = true; };
  }, [contact.id]);

  const groups = useMemo(() => safetyGroups(contact.safetyNumber), [contact.safetyNumber]);

  const compareManually = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const updated = await invoke<BackendContact>("messaging_mark_contact_verified", { contactId: contact.id, verified: !verified });
      const next = contactFromBackend(updated);
      onContactUpdated(next);
      setVerified(next.trustState === "verified");
    } catch (e) {
      setError(typeof e === "string" ? e : "Could not update verification state");
    } finally {
      setBusy(false);
    }
  };

  const verifyCode = async () => {
    const code = theirCode.trim();
    if (!code || busy) return;
    setBusy(true);
    setError("");
    try {
      const updated = await invoke<BackendContact>("messaging_verify_contact_with_code", { contactId: contact.id, code });
      const next = contactFromBackend(updated);
      onContactUpdated(next);
      setVerified(true);
      setTheirCode("");
    } catch (e) {
      setError(typeof e === "string" ? e : "Verification code did not match this contact");
    } finally {
      setBusy(false);
    }
  };

  const copyMyCode = async () => {
    if (!myCode) return;
    await navigator.clipboard.writeText(myCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const cannotVerify = contact.trustState === "identity_changed_blocked";
  const bannerState = verified ? "verified" : cannotVerify ? "blocked" : "unverified";
  const bannerTitle = verified ? "Verified" : cannotVerify ? "Identity changed" : "Not verified";
  const bannerDesc = verified
    ? "This contact is marked as verified on this device."
    : cannotVerify
      ? "Sending is blocked because this contact's identity key changed. Re-add them with a fresh code after checking out of band."
      : "Confirm one of the methods below before you trust this identity.";

  return (
    <div className="verify-root">
      <header className="verify-topbar">
        <button className="verify-back" onClick={onClose} aria-label="Back">
          <IconArrowLeft />
        </button>
        <div className="verify-topbar-title">Verify {contactDisplayName(contact)}</div>
      </header>

      <div className="verify-content">
        <div className={`verify-banner ${bannerState}`}>
          <span className="verify-banner-icon">
            {verified ? <IconCheck /> : cannotVerify ? <IconUserX /> : <IconShield />}
          </span>
          <div className="verify-banner-text">
            <div className="verify-banner-title">{bannerTitle}</div>
            <div className="verify-banner-desc">{bannerDesc}</div>
          </div>
        </div>

        <section className="verify-method">
          <div className="verify-method-head">
            <h2 className="verify-method-title">Compare safety number</h2>
            <p className="verify-method-desc">Read these digits aloud together over a trusted channel. If they match on both devices, mark this contact as verified.</p>
          </div>
          <div className="verify-safety-number">
            {Array.from({ length: 4 }).map((_, rowIdx) => (
              <div key={rowIdx} className="verify-safety-row">
                {groups.slice(rowIdx * 3, rowIdx * 3 + 3).map((g, i) => (
                  <span key={i} className="verify-safety-group">{g}</span>
                ))}
              </div>
            ))}
          </div>
          <button
            className={`btn ${verified ? "btn-success" : "btn-primary"} verify-full-btn`}
            onClick={compareManually}
            disabled={busy || cannotVerify}
          >
            {verified ? <><IconCheck /> Marked as verified</> : "I compared the number"}
          </button>
        </section>

        <section className="verify-method">
          <div className="verify-method-head">
            <h2 className="verify-method-title">Exchange codes</h2>
            <p className="verify-method-desc">Send your code to them out of band, then paste the one they send back.</p>
          </div>
          <div className="verify-code-field">
            <div className="verify-code-label">Your code</div>
            <div className="verify-code-value" title={myCode}>{myCode ? compactCode(myCode) : "Not available yet"}</div>
            <button className="btn btn-secondary verify-full-btn" onClick={copyMyCode} disabled={!myCode}>
              {copied ? <><IconCheck /> Copied</> : <><IconCopy /> Copy my code</>}
            </button>
          </div>
          <div className="verify-code-field">
            <div className="verify-code-label">Their code</div>
            <textarea
              className="verify-code-input"
              placeholder="axv1_…"
              value={theirCode}
              onChange={(e) => { setTheirCode(e.target.value); setError(""); }}
              spellCheck={false}
            />
            <button className="btn btn-primary verify-full-btn" onClick={verifyCode} disabled={busy || cannotVerify || !theirCode.trim()}>
              Verify pasted code
            </button>
          </div>
        </section>

        {error && <div className="onboarding-error">{error}</div>}
        <p className="verify-footnote">
          A relay can never fake verification. It would need the contact's real identity key.
        </p>
      </div>
    </div>
  );
}
