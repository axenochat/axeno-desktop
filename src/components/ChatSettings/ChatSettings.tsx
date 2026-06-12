import { useState } from "react";
import { Contact } from "../../types";
import { contactDisplayName, contactInitials } from "../../utils";
import {
  IconX, IconShield, IconChevronRight, IconServer,
} from "../icons";
import "./ChatSettings.css";

interface Props {
  contact: Contact;
  onClose: () => void;
  onOpenVerify: () => void;
  onMigrateRelay: (code: string) => Promise<void>;
}

export default function ChatSettings({ contact, onClose, onOpenVerify, onMigrateRelay }: Props) {
  const verifyStatusText = contact.trustState === "verified"
    ? "Verified"
    : contact.trustState === "identity_changed_blocked"
      ? "Key changed"
      : "Not verified";
  const verifyStatusClass = contact.trustState === "verified"
    ? "verified"
    : contact.trustState === "identity_changed_blocked"
      ? "blocked"
      : "unverified";

  const [showMigration, setShowMigration] = useState(false);
  const [migrationCode, setMigrationCode] = useState("");
  const [migrationError, setMigrationError] = useState("");
  const [migrationBusy, setMigrationBusy] = useState(false);

  const closeMigration = () => {
    setShowMigration(false);
    setMigrationCode("");
    setMigrationError("");
  };

  const submitMigration = async () => {
    const code = migrationCode.trim();
    if (!code) return;
    setMigrationError("");
    setMigrationBusy(true);
    try {
      await onMigrateRelay(code);
      closeMigration();
    } catch (err) {
      setMigrationError(err instanceof Error ? err.message : String(err));
    } finally {
      setMigrationBusy(false);
    }
  };

  return (
    <>
      <div className="chat-settings-backdrop" onClick={onClose} />
      <aside className="chat-settings-drawer">
        <header className="chat-settings-header">
          <div className="chat-settings-title">Conversation</div>
          <button className="chat-settings-close" onClick={onClose} aria-label="Close">
            <IconX />
          </button>
        </header>

        <div className="chat-settings-body">
          <div className="chat-settings-identity">
            <div className="chat-settings-avatar">{contactInitials(contact)}</div>
            <div className="chat-settings-name">{contactDisplayName(contact)}</div>
            <div className="chat-settings-relay" title={contact.serverUrl || "unknown"}>
              {contact.serverUrl || "unknown relay"}
            </div>
          </div>

          <div className="chat-settings-list">
            <button className="chat-settings-row" onClick={onOpenVerify}>
              <span className="chat-settings-row-icon"><IconShield /></span>
              <span className="chat-settings-row-label">Verify identity</span>
              <span className={`chat-settings-badge ${verifyStatusClass}`}>{verifyStatusText}</span>
              <span className="chat-settings-row-chevron"><IconChevronRight /></span>
            </button>

            <button
              className="chat-settings-row"
              onClick={() => (showMigration ? closeMigration() : setShowMigration(true))}
              aria-expanded={showMigration}
            >
              <span className="chat-settings-row-icon"><IconServer /></span>
              <span className="chat-settings-row-label">Migrate relay</span>
              <span className={`chat-settings-row-chevron ${showMigration ? "open" : ""}`}><IconChevronRight /></span>
            </button>

            {showMigration && (
              <div className="chat-settings-migrate">
                <p className="chat-settings-migrate-hint">
                  Paste a fresh connection code from this contact to move them to a new relay. Axeno rejects it if the identity key differs.
                </p>
                <textarea
                  className="chat-settings-code-input"
                  placeholder="Paste their new connection code"
                  value={migrationCode}
                  onChange={(e) => { setMigrationCode(e.target.value); setMigrationError(""); }}
                  spellCheck={false}
                  autoFocus
                />
                {migrationError && <div className="chat-settings-error">{migrationError}</div>}
                <div className="chat-settings-migrate-actions">
                  <button className="btn btn-secondary" onClick={closeMigration} disabled={migrationBusy}>Cancel</button>
                  <button className="btn btn-primary" onClick={submitMigration} disabled={migrationBusy || !migrationCode.trim()}>
                    {migrationBusy ? "Migrating…" : "Migrate"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
