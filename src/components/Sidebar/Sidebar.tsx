import { useEffect, useMemo, useState } from "react";
import { Contact, Message } from "../../types";
import { contactDisplayName, contactInitials, formatMessageTime, lastMessage, messagePreview, unreadCount } from "../../utils";
import { IconSearch, IconPlus, IconSettings } from "../icons";
import "./Sidebar.css";

interface Props {
  contacts: Contact[];
  allMessages: Record<string, Message[]>;
  activeContactId: string;
  onSelectContact: (id: string) => void;
  onDeleteContact: (contactId: string, retireRelay: boolean) => void | Promise<void>;
  onBlockContact: (contactId: string) => void | Promise<void>;
  onOpenAddContact: () => void;
  onOpenSettings: () => void;
  myInitials: string;
  myDisplayName: string;
  torStatus: "connecting" | "connected" | "failed"; // NEW
  syncing: boolean;
}

interface ContextMenuState {
  contactId: string;
  x: number;
  y: number;
}

const MENU_WIDTH = 232;
const MENU_HEIGHT = 132;

export default function Sidebar({
  contacts, allMessages, activeContactId, onSelectContact, onDeleteContact, onBlockContact,
  onOpenAddContact, onOpenSettings,
  myInitials, myDisplayName, torStatus, syncing
}: Props) {
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);

  const menuContact = menu ? contacts.find(c => c.id === menu.contactId) : undefined;

  const runDelete = async () => {
    if (!menu || deleting) return;
    const contactId = menu.contactId;
    setDeleting(true);
    try {
      await onDeleteContact(contactId, false);
      setMenu(null);
    } finally {
      setDeleting(false);
    }
  };

  const runBlock = async () => {
    if (!menu || deleting) return;
    const contactId = menu.contactId;
    setDeleting(true);
    try {
      await onBlockContact(contactId);
      setMenu(null);
    } finally {
      setDeleting(false);
    }
  };
  const visibleContacts = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter(c => {
      const msgs = allMessages[c.id] ?? [];
      const lastMsg = lastMessage(msgs);
      const last = lastMsg ? messagePreview(lastMsg) : "";
      return [contactDisplayName(c), c.recipientId ?? "", last].some(v => v.toLowerCase().includes(q));
    });
  }, [contacts, allMessages, query]);

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="brand">Axeno</div>
        
        {/* NEW TOR INDICATOR */}
        <div className="sidebar-tor-status" title={`Tor: ${torStatus}`}>
          <span className={`tor-dot ${torStatus}`} />
          <span className="tor-text">Tor</span>
        </div>
      </div>

      <div className="sidebar-search">
        <span className="sidebar-search-icon"><IconSearch /></span>
        <input type="text" placeholder="Search" className="sidebar-search-input" value={query} onChange={e => setQuery(e.target.value)} />
      </div>

      {syncing && (
        <div className="sidebar-sync" role="status" aria-live="polite">
          <span className="sidebar-sync-spinner" />
          <span className="sidebar-sync-text">Syncing messages…</span>
        </div>
      )}

      <div className="sidebar-list">
        {visibleContacts.map((c) => {
          const isActive = c.id === activeContactId;
          const msgs = allMessages[c.id] ?? [];
          const last = lastMessage(msgs);
          const preview = last ? messagePreview(last) : "";
          const time = last ? formatMessageTime(last.timestamp) : "";
          const unread = isActive ? 0 : unreadCount(msgs, c.lastReadAt);
          return (
            <div
              key={c.id}
              onClick={() => onSelectContact(c.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ contactId: c.id, x: e.clientX, y: e.clientY });
              }}
              className={`contact-row ${isActive ? "active" : ""}`}
            >
              <div className="avatar">{contactInitials(c)}</div>
              <div className="contact-info">
                <div className="contact-id">{contactDisplayName(c)}</div>
                <div className="contact-preview">{preview}</div>
              </div>
              <div className="contact-meta">
                <span className="contact-time">{time}</span>
                {unread > 0 && <div className="unread-badge">{unread}</div>}
              </div>
            </div>
          );
        })}
      </div>

      <div className="sidebar-footer">
        <div className="me-avatar">{myInitials}</div>
        <span className="me-name">{myDisplayName}</span>
        <button className="icon-button" onClick={onOpenAddContact} aria-label="Add contact">
          <IconPlus />
        </button>
        <button className="icon-button" onClick={onOpenSettings} aria-label="Settings">
          <IconSettings />
        </button>
      </div>

      {menu && (
        <>
          <div
            className="context-menu-backdrop"
            onClick={() => { if (!deleting) setMenu(null); }}
            onContextMenu={(e) => { e.preventDefault(); if (!deleting) setMenu(null); }}
          />
          <div
            className="context-menu"
            role="menu"
            style={{
              left: Math.min(menu.x, window.innerWidth - MENU_WIDTH - 8),
              top: Math.min(menu.y, window.innerHeight - MENU_HEIGHT - 8),
            }}
          >
            <div className="context-menu-label">
              {menuContact ? contactDisplayName(menuContact) : "Conversation"}
            </div>
            <button className="context-menu-item danger" disabled={deleting} onClick={runDelete}>
              Delete conversation
            </button>
            <button className="context-menu-item danger block" disabled={deleting} onClick={runBlock}>
              Delete & block
            </button>
          </div>
        </>
      )}
    </aside>
  );
}