import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Sidebar from "./components/Sidebar/Sidebar";
import ChatView from "./components/ChatView/ChatView";
import Settings from "./components/Settings/Settings";
import ChatSettings from "./components/ChatSettings/ChatSettings";
import AddContact from "./components/AddContact/AddContact";
import Onboarding from "./components/Onboarding/Onboarding";
import VerifyIdentity from "./components/VerifyIdentity/VerifyIdentity";
import UpdatePrompt from "./components/UpdatePrompt/UpdatePrompt";
import {
  Contact, Message, AppSettings, defaultSettings,
  MessagingSnapshot, BackendMessage, BackendContact, contactFromBackend, messageFromBackend,
  FileProgress,
} from "./types";
import "./App.css";
import "./components/Onboarding/Onboarding.css";

interface UnlockResponse { fingerprint: string; display_name: string; }
type TorStatus = "connecting" | "connected" | "failed";

interface TorStatusEvent { status: TorStatus; reason?: string; }
interface IncomingMessageEvent { contact_id: string; message: BackendMessage; }
interface BlockContactResponse { active_code_count: number; active_code_ids: string[]; }
interface SendMessageResponse { message: BackendMessage; }
interface SendReceiptEvent { server_id: string; id: string; queued: boolean; client_ref?: string | null; }
interface SendFailedEvent { server_id: string; client_ref?: string | null; code: string; message: string; }
interface ServerStatusEvent { server_id: string; status: string; reason?: string | null; }
interface SyncStatusEvent { syncing: boolean; }
interface FileProgressEvent { message_id: string; contact_id: string; direction: string; transferred_bytes: number; total_bytes: number; done: boolean; error?: string | null; }
interface BackendPrivateServerSettings { private_servers: { id: string; name: string; onion: string }[]; default_server_url?: string | null; }

function sanitizeSettingsForStorage(settings: AppSettings): AppSettings {
  return {
    ...settings,
    // Connection codes and private relay selections contain routing metadata.
    // They live only in the encrypted Rust-side message store, never localStorage.
    inviteCodes: [],
    privateServers: [],
    defaultServer: { kind: "none" },
  };
}

function parseStoredSettings(raw: string | null): AppSettings {
  if (!raw) return defaultSettings;
  const parsed = JSON.parse(raw) as Partial<AppSettings>;
  return { ...defaultSettings, ...parsed, inviteCodes: [], privateServers: [], defaultServer: { kind: "none" } };
}

function computeInitials(name: string): string {
  return name.trim().split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase() || "?";
}

function groupMessages(snapshot: MessagingSnapshot): Record<string, Message[]> {
  const result: Record<string, Message[]> = {};
  Object.entries(snapshot.messages).forEach(([contactId, msgs]) => {
    result[contactId] = msgs.map(messageFromBackend);
  });
  return result;
}

export default function App() {
  const [appState, setAppState] = useState<"loading" | "onboarding" | "login" | "chat">("loading");
  const [torStatus, setTorStatus] = useState<TorStatus>("connecting");
  const [, setTorError] = useState<string>("");

  const [displayName, setDisplayName] = useState("");

  const loginPasswordRef = useRef<HTMLInputElement>(null);
  const [loginPasswordReady, setLoginPasswordReady] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [isUnlocking, setIsUnlocking] = useState(false);

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  // Live transfer progress keyed by message id, for the upload/download bars.
  const [fileProgress, setFileProgress] = useState<Record<string, FileProgress>>({});
  const [activeContactId, setActiveContactId] = useState("");
  const activeContactIdRef = useRef("");
  const reconnectTimersRef = useRef<Record<string, number>>({});

  // Non-blocking "syncing messages" indicator, driven by the backend's
  // authoritative `axeno-sync-status` event: it reports true while any relay
  // connection is still delivering its offline backlog (cleared precisely by the
  // relay's `synced` marker). The cap only guards against a missed event.
  const [syncing, setSyncing] = useState(false);
  const syncCapTimerRef = useRef<number | null>(null);

  // Staggered-shutdown overlay: while closing, we hold the window and close the
  // relay sockets on independent random delays so a logging relay can't see all
  // our mailboxes drop at once. The ref lets the server-status listener know not
  // to fight the teardown with auto-reconnects.
  const [shuttingDown, setShuttingDown] = useState(false);
  const [shutdownProgress, setShutdownProgress] = useState<{ closed: number; total: number }>({ closed: 0, total: 0 });
  const shuttingDownRef = useRef(false);
  // Startup counterpart to the shutdown overlay: while the backend staggers each
  // route's connection across the jitter window, show a non-blocking banner that
  // counts the window down so the wait is visible instead of looking stalled.
  // `null` = hidden. Non-blocking (banner, not overlay) so history stays usable.
  const [connectCountdown, setConnectCountdown] = useState<number | null>(null);
  const connectCountdownTimerRef = useRef<number | null>(null);
  // Mirror of settings.staggerConnections for the close-intercept handler (whose
  // effect captures props once) and to push the preference to the backend.
  const staggerRef = useRef(true);
  const [settings, setSettings] = useState<AppSettings>(() => {
    try {
      return parseStoredSettings(localStorage.getItem("axeno.settings.v1"));
    } catch {
      return defaultSettings;
    }
  });

  const [serverSettingsLoaded, setServerSettingsLoaded] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showAddContact, setShowAddContact] = useState(false);
  const [showChatSettings, setShowChatSettings] = useState(false);
  const [codeWarning, setCodeWarning] = useState<{ codeIds: string[] } | null>(null);
  const [isDeletingCodes, setIsDeletingCodes] = useState(false);
  const [showVerify, setShowVerify] = useState(false);

  useEffect(() => {
    try { localStorage.setItem("axeno.settings.v1", JSON.stringify(sanitizeSettingsForStorage(settings))); } catch {}
  }, [settings]);

  // Push the connection-timing-obfuscation preference to the backend (which gates
  // the staggered connect) and mirror it into a ref for the close handler.
  useEffect(() => {
    staggerRef.current = settings.staggerConnections;
    invoke("messaging_set_stagger_connections", { enabled: settings.staggerConnections }).catch(() => {});
  }, [settings.staggerConnections]);

  useEffect(() => {
    invoke("messaging_set_jitter_maxes", {
      connectMaxSecs: settings.connectJitterMaxSecs,
      shutdownMaxSecs: settings.shutdownJitterMaxSecs,
    }).catch(() => {});
  }, [settings.connectJitterMaxSecs, settings.shutdownJitterMaxSecs]);

  useEffect(() => {
    if (appState !== "chat" || !serverSettingsLoaded) return;
    const defaultServerUrl = settings.defaultServer.kind === "private"
      ? settings.privateServers.find(s => s.id === (settings.defaultServer as { kind: "private"; serverId: string }).serverId)?.onion ?? null
      : null;
    invoke("messaging_save_private_server_settings", {
      settings: {
        private_servers: settings.privateServers,
        default_server_url: defaultServerUrl,
      },
    }).catch(() => {});
  }, [settings.privateServers, settings.defaultServer, appState, serverSettingsLoaded]);

  // Mirror the backend's sync state. The cap is pure defense-in-depth: if a
  // `syncing: false` event were ever missed, force the indicator off rather than
  // leave it spinning forever. The backend self-heals (every connection clears
  // its flag on the relay's marker, a fallback, or disconnect), so this should
  // not normally fire.
  const applySyncStatus = useCallback((value: boolean) => {
    if (syncCapTimerRef.current) { window.clearTimeout(syncCapTimerRef.current); syncCapTimerRef.current = null; }
    if (value) {
      syncCapTimerRef.current = window.setTimeout(() => { syncCapTimerRef.current = null; setSyncing(false); }, 90000);
    }
    setSyncing(value);
  }, []);

  // Show the staggered-connect countdown using the actual max jitter for this
  // run (returned by messaging_connect_all). A zero maxMs means staggering is
  // off or there are no routes, so no banner is shown.
  const startConnectStaggerIndicator = useCallback((maxMs: number) => {
    if (maxMs <= 0) return;
    if (connectCountdownTimerRef.current !== null) {
      window.clearInterval(connectCountdownTimerRef.current);
      connectCountdownTimerRef.current = null;
    }
    const maxSecs = Math.ceil(maxMs / 1000);
    setConnectCountdown(maxSecs);
    connectCountdownTimerRef.current = window.setInterval(() => {
      setConnectCountdown(prev => {
        if (prev === null || prev <= 1) {
          if (connectCountdownTimerRef.current !== null) {
            window.clearInterval(connectCountdownTimerRef.current);
            connectCountdownTimerRef.current = null;
          }
          return null;
        }
        return prev - 1;
      });
    }, 1000);
  }, []);

  // Pull the latest contacts/messages from the backend into the UI. This is a
  // pure read: it never (re)connects routes or shows the connect-stagger banner,
  // so it is safe to call on every inbound message and other frequent refreshes.
  const refreshSnapshot = useCallback(async () => {
    const snap = await invoke<MessagingSnapshot>("messaging_snapshot");
    const nextContacts = snap.contacts.map(contactFromBackend);
    setContacts(nextContacts);
    setMessages(groupMessages(snap));
    setActiveContactId(prev => prev || nextContacts[0]?.id || "");
    return nextContacts;
  }, []);

  // Establish/keep-alive all route connections. connect_all is idempotent —
  // healthy routes are reused, dead ones rebuilt — and it triggers the relay's
  // queued-message replay (the backend emits axeno-sync-status while that backlog
  // is in flight). Crucially it keeps the sender routes warm so replies send
  // instantly instead of building a Tor circuit on demand.
  //
  // `showBanner` controls only the cosmetic stagger countdown. Show it at genuine
  // (re)connect moments — login, onboarding, add/migrate contact — but NOT on the
  // keep-alive after an inbound message, which would flash the banner on every
  // received message. connect_all returns the actual max jitter ms for this run
  // so the countdown reflects the real window.
  const connectAll = useCallback(async (showBanner: boolean) => {
    const maxJitterMs = await invoke<number>("messaging_connect_all").catch(() => 0);
    if (showBanner) startConnectStaggerIndicator(maxJitterMs);
  }, [startConnectStaggerIndicator]);

  // Initial session load: refresh the snapshot, then connect all routes (banner).
  const loadMessaging = useCallback(async () => {
    const nextContacts = await refreshSnapshot();
    await connectAll(nextContacts.length > 0);
  }, [refreshSnapshot, connectAll]);

  const loadPrivateServerSettings = useCallback(async () => {
    const persisted = await invoke<BackendPrivateServerSettings>("messaging_load_private_server_settings");
    setSettings(prev => {
      const privateServers = persisted.private_servers.map(s => ({ id: s.id, name: s.name, onion: s.onion }));
      const matching = persisted.default_server_url
        ? privateServers.find(s => s.onion === persisted.default_server_url)
        : undefined;
      return {
        ...prev,
        privateServers,
        defaultServer: matching ? { kind: "private", serverId: matching.id } : { kind: "none" },
      };
    });
    setServerSettingsLoaded(true);
  }, []);

  const markContactRead = useCallback(async (contactId: string) => {
    if (!contactId) return;

    // Clear instantly in the UI, then replace with the exact persisted backend value.
    const optimisticReadAt = Date.now();
    setContacts(prev => prev.map(c => c.id === contactId ? { ...c, lastReadAt: optimisticReadAt } : c));

    const updated = await invoke<BackendContact>("messaging_mark_contact_read", { contactId });
    const next = contactFromBackend(updated);
    setContacts(prev => prev.map(c => c.id === contactId ? next : c));
  }, []);

  useEffect(() => () => { if (syncCapTimerRef.current) window.clearTimeout(syncCapTimerRef.current); }, []);

  const activeContactIdForUi = activeContactId || contacts[0]?.id || "";

  useEffect(() => {
    activeContactIdRef.current = activeContactIdForUi;
  }, [activeContactIdForUi]);

  useEffect(() => {
    if (appState !== "chat" || !activeContactIdForUi) return;
    markContactRead(activeContactIdForUi).catch(() => {});
  }, [appState, activeContactIdForUi, markContactRead]);

  // Suppress the default Chromium right-click menu so our own context menus are
  // the only ones that appear. Editable fields keep the native menu so copy and
  // paste still work (connection codes and messages are routinely pasted).
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const editable = target?.closest('input, textarea, [contenteditable="true"]');
      if (!editable) e.preventDefault();
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);


  useEffect(() => {
    const unlistenTor = listen<TorStatusEvent>("tor-status", (event) => {
      setTorStatus(event.payload.status);
      setTorError(event.payload.reason ?? "");
      if (event.payload.status === "connected") {
        invoke("messaging_connect_all").catch(() => {});
      }
    });

    const unlistenSyncStatus = listen<SyncStatusEvent>("axeno-sync-status", (event) => {
      applySyncStatus(event.payload.syncing);
    });

    const unlistenServerStatus = listen<ServerStatusEvent>("axeno-server-status", (event) => {
      // While quitting, the staggered teardown intentionally disconnects every
      // socket; don't schedule auto-reconnects that would race the shutdown.
      if (shuttingDownRef.current) return;
      const { server_id: serverId, status } = event.payload;
      if (status === "ready" || status === "connected" || status === "connecting") {
        const existing = reconnectTimersRef.current[serverId];
        if (existing) {
          window.clearTimeout(existing);
          delete reconnectTimersRef.current[serverId];
        }
        return;
      }
      if (status !== "failed" && status !== "disconnected") return;
      if (reconnectTimersRef.current[serverId]) return;
      reconnectTimersRef.current[serverId] = window.setTimeout(() => {
        delete reconnectTimersRef.current[serverId];
        invoke("messaging_connect_all").catch(() => {});
      }, 1500);
    });


    const unlistenSendReceipt = listen<SendReceiptEvent>("axeno-send-receipt", async (event) => {
      const messageId = event.payload.client_ref;
      if (!messageId) return;
      try {
        const updated = await invoke<BackendMessage | null>("messaging_mark_message_relay_received", {
          messageId,
          queued: event.payload.queued,
        });
        if (!updated) return;
        const msg = messageFromBackend(updated);
        setMessages(prev => {
          const contactId = updated.contact_id;
          const existing = prev[contactId] ?? [];
          return { ...prev, [contactId]: existing.map(m => m.id === msg.id ? msg : m) };
        });
      } catch {}
    });

    const unlistenSendFailed = listen<SendFailedEvent>("axeno-send-failed", async (event) => {
      const messageId = event.payload.client_ref;
      if (!messageId) return;
      try {
        const updated = await invoke<BackendMessage | null>("messaging_mark_message_send_failed", { messageId });
        if (!updated) return;
        const msg = messageFromBackend(updated);
        setMessages(prev => {
          const contactId = updated.contact_id;
          const existing = prev[contactId] ?? [];
          return { ...prev, [contactId]: existing.map(m => m.id === msg.id ? msg : m) };
        });
      } catch {}
    });

    const unlistenFileProgress = listen<FileProgressEvent>("axeno-file-progress", (event) => {
      const p = event.payload;
      setFileProgress(prev => ({
        ...prev,
        [p.message_id]: {
          direction: p.direction === "download" ? "download" : "upload",
          transferred: p.transferred_bytes,
          total: p.total_bytes,
          done: p.done,
          error: p.error ?? null,
        },
      }));
      // Drop a finished/failed entry shortly after so the map doesn't grow; the
      // bubble reflects the final state from the stored message by then.
      if (p.done || p.error) {
        window.setTimeout(() => {
          setFileProgress(prev => {
            const next = { ...prev };
            delete next[p.message_id];
            return next;
          });
        }, 1500);
      }
    });

    const unlistenMessage = listen<IncomingMessageEvent>("axeno-message", (event) => {
      const contactId = event.payload.contact_id;
      const msg = messageFromBackend(event.payload.message);
      setMessages(prev => {
        const existing = prev[contactId] ?? [];
        if (existing.some(m => m.id === msg.id)) return prev;
        return { ...prev, [contactId]: [...existing, msg] };
      });

      const activeNow = activeContactIdRef.current;
      const isOpenChat = !activeNow || activeNow === contactId;
      if (!activeNow) {
        activeContactIdRef.current = contactId;
        setActiveContactId(contactId);
      }

      // Pull the authoritative snapshot, then keep routes warm so a reply sends
      // instantly. Warm silently — no stagger banner — since this fires on every
      // received message (showing it here was the spurious-banner bug).
      const refreshAfterRead = async () => {
        if (isOpenChat) await markContactRead(contactId).catch(() => {});
        await refreshSnapshot().catch(() => {});
        await connectAll(false).catch(() => {});
      };
      void refreshAfterRead();
    });

    const init = async () => {
      try {
        const exists = await invoke<boolean>("has_identity");
        setAppState(exists ? "login" : "onboarding");
        await invoke("bootstrap_tor");
      } catch {
        setAppState("onboarding");
      }
    };
    init();

    return () => {
      unlistenTor.then(f => f());
      unlistenSyncStatus.then(f => f());
      unlistenServerStatus.then(f => f());
      unlistenSendReceipt.then(f => f());
      unlistenSendFailed.then(f => f());
      unlistenFileProgress.then(f => f());
      unlistenMessage.then(f => f());
      Object.values(reconnectTimersRef.current).forEach(timer => window.clearTimeout(timer));
      reconnectTimersRef.current = {};
      if (connectCountdownTimerRef.current !== null) {
        window.clearInterval(connectCountdownTimerRef.current);
        connectCountdownTimerRef.current = null;
      }
    };
  }, [refreshSnapshot, connectAll, loadPrivateServerSettings, markContactRead, applySyncStatus]);

  // Intercept the window close: hold it open, stagger-close the relay sockets so
  // a logging relay can't see all our mailboxes drop in one burst, then destroy
  // the window. See transport::disconnect_all_staggered.
  useEffect(() => {
    const win = getCurrentWindow();
    const unlistenProgress = listen<{ closed: number; total: number }>("axeno-shutdown-progress", (e) => {
      setShutdownProgress(e.payload);
    });
    const unlistenClose = win.onCloseRequested(async (event) => {
      if (shuttingDownRef.current) return; // teardown already running
      if (!staggerRef.current) return; // feature off — allow the normal immediate close
      event.preventDefault();
      shuttingDownRef.current = true;
      setShutdownProgress({ closed: 0, total: 0 });
      setShuttingDown(true);
      try {
        await invoke("transport_disconnect_all_staggered");
      } catch { /* best effort — close regardless */ }
      // Actually close. destroy() can reject (e.g. if the ACL ever lacks the
      // permission); never let that leave the window stuck open behind the
      // overlay. Fall back to close(), which re-fires this handler — the guard
      // above then lets it through without re-staggering.
      try {
        await win.destroy();
      } catch {
        try { await win.close(); } catch { /* nothing more we can do */ }
      }
    });
    return () => {
      unlistenProgress.then(f => f());
      unlistenClose.then(f => f());
    };
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError("");
    setIsUnlocking(true);
    try {
      const passphrase = loginPasswordRef.current?.value ?? "";
      const res = await invoke<UnlockResponse>("unlock_identity", { passphrase });
      if (loginPasswordRef.current) loginPasswordRef.current.value = "";
      setLoginPasswordReady(false);
      setDisplayName(res.display_name);
      await loadMessaging();
      await loadPrivateServerSettings().catch(() => setServerSettingsLoaded(true));
      setAppState("chat");
    } catch {
      setLoginError("Incorrect password.");
    } finally {
      if (loginPasswordRef.current) loginPasswordRef.current.value = "";
      setLoginPasswordReady(false);
      setIsUnlocking(false);
    }
  };

  const handleOnboardingComplete = async (name: string) => {
    setDisplayName(name);
    await loadMessaging().catch(() => {});
    await loadPrivateServerSettings().catch(() => setServerSettingsLoaded(true));
    setAppState("chat");
  };

  const handleAddedContact = async (contact: BackendContact) => {
    const c = contactFromBackend(contact);
    setContacts(prev => prev.some(x => x.id === c.id) ? prev : [...prev, c]);
    setActiveContactId(c.id);
    invoke("messaging_connect_all").catch(() => {});
  };

  const sendMessage = async (contactId: string, text: string) => {
    // Optimistic: show bubble immediately with "sending" status
    const optimisticId = `pending_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const optimisticMsg: Message = {
      id: optimisticId,
      text,
      mine: true,
      timestamp: Date.now(),
      status: "relay_pending",
    };
    setMessages(prev => ({ ...prev, [contactId]: [...(prev[contactId] ?? []), optimisticMsg] }));

    try {
      const res = await invoke<SendMessageResponse>("messaging_send_text_message", { contactId, text });
      const msg = messageFromBackend(res.message);
      // Replace optimistic message with real one from backend
      setMessages(prev => {
        const existing = prev[contactId] ?? [];
        return { ...prev, [contactId]: existing.map(m => m.id === optimisticId ? msg : m) };
      });
    } catch (e) {
      // Mark optimistic message as failed
      setMessages(prev => {
        const existing = prev[contactId] ?? [];
        return { ...prev, [contactId]: existing.map(m => m.id === optimisticId ? { ...m, status: "send_failed" } : m) };
      });
      throw e;
    }
  };

  const sendFile = async (contactId: string) => {
    // The file dialog runs in Rust; the backend only accepts paths it handed
    // out here, so the webview never names arbitrary filesystem paths.
    const picked = await invoke<{ path: string; fileName: string } | null>("pick_file_for_send");
    if (!picked) return;
    const filePath = picked.path;
    const fileName = picked.fileName;
    // Pre-generate the id so the optimistic bubble and the backend's upload
    // progress events line up on the same message.
    const messageId = (crypto as Crypto).randomUUID();
    const optimisticMsg: Message = {
      id: messageId,
      text: "",
      mine: true,
      timestamp: Date.now(),
      status: "relay_pending",
      attachment: {
        transferId: "", fileName, mime: "", size: 0, totalChunks: 0,
        serverUrl: "", localPath: filePath, downloadState: "uploading",
      },
    };
    setMessages(prev => ({ ...prev, [contactId]: [...(prev[contactId] ?? []), optimisticMsg] }));
    try {
      const res = await invoke<SendMessageResponse>("messaging_send_file_message", { contactId, filePath, messageId });
      const msg = messageFromBackend(res.message);
      setMessages(prev => {
        const existing = prev[contactId] ?? [];
        return { ...prev, [contactId]: existing.map(m => m.id === messageId ? msg : m) };
      });
    } catch (e) {
      setMessages(prev => {
        const existing = prev[contactId] ?? [];
        return { ...prev, [contactId]: existing.map(m => m.id === messageId
          ? { ...m, status: "send_failed", attachment: m.attachment ? { ...m.attachment, downloadState: "failed" } : m.attachment }
          : m) };
      });
      throw e;
    }
  };

  // Stamp a download_state onto a message's attachment wherever it lives in the
  // map. Used to flip the bubble to "downloading" the instant the user clicks,
  // since the first progress event can lag behind Tor circuit setup.
  const setAttachmentState = (messageId: string, downloadState: string) => {
    setMessages(prev => {
      const next = { ...prev };
      for (const cid of Object.keys(next)) {
        if (!next[cid].some(m => m.id === messageId)) continue;
        next[cid] = next[cid].map(m => m.id === messageId && m.attachment
          ? { ...m, attachment: { ...m.attachment, downloadState } }
          : m);
        break;
      }
      return next;
    });
  };

  const downloadFile = async (msg: Message) => {
    if (!msg.attachment) return;
    // The save dialog runs in Rust; the backend only writes to paths it handed
    // out here.
    const savePath = await invoke<string | null>("pick_save_path", { defaultName: msg.attachment.fileName });
    if (!savePath) return;
    setAttachmentState(msg.id, "downloading");
    try {
      const updated = await invoke<BackendMessage>("messaging_download_file", { messageId: msg.id, savePath });
      const next = messageFromBackend(updated);
      const contactId = updated.contact_id;
      setMessages(prev => {
        const existing = prev[contactId] ?? [];
        return { ...prev, [contactId]: existing.map(m => m.id === next.id ? next : m) };
      });
    } catch (e) {
      setAttachmentState(msg.id, "failed");
      throw e;
    }
  };

  const migrateContactRelay = async (contactId: string, code: string) => {
    const updated = await invoke<BackendContact>("messaging_migrate_contact_with_code", { contactId, code });
    const next = contactFromBackend(updated);
    setContacts(prev => prev.map(c => c.id === contactId ? next : c));
    // Migrating points this contact at a new relay/route, so connect once (with
    // the banner) — not via loadMessaging, which would connect a second time.
    await refreshSnapshot().catch(() => {});
    await connectAll(true);
  };

  const selectContact = async (id: string) => {
    setActiveContactId(id);
    activeContactIdRef.current = id;
    await markContactRead(id).catch(() => {});
  };

  const deleteContact = async (contactId: string, retireRelay: boolean) => {
    await invoke("messaging_delete_contact", { contactId, retireRelay });
    setContacts(prev => prev.filter(c => c.id !== contactId));
    setMessages(prev => {
      const next = { ...prev };
      delete next[contactId];
      return next;
    });
    setActiveContactId(prev => (prev === contactId ? "" : prev));
  };

  const deleteAndBlockContact = async (contactId: string) => {
    const res = await invoke<BlockContactResponse>("messaging_delete_and_block_contact", { contactId });
    setContacts(prev => prev.filter(c => c.id !== contactId));
    setMessages(prev => {
      const next = { ...prev };
      delete next[contactId];
      return next;
    });
    setActiveContactId(prev => (prev === contactId ? "" : prev));
    // Layer 3: if there are active codes on the same relay, warn.
    if (res.active_code_count > 0) {
      setCodeWarning({ codeIds: res.active_code_ids });
    }
  };

  const dismissCodeWarning = () => setCodeWarning(null);

  const deleteWarningCodes = async () => {
    if (!codeWarning) return;
    setIsDeletingCodes(true);
    try {
      for (const id of codeWarning.codeIds) {
        await invoke("messaging_delete_connection_code", { id });
      }
      setSettings(prev => ({
        ...prev,
        inviteCodes: prev.inviteCodes.filter(c => !codeWarning.codeIds.includes(c.id)),
      }));
      setCodeWarning(null);
    } catch { /* best effort */ }
    finally { setIsDeletingCodes(false); }
  };

  const active = contacts.find(c => c.id === activeContactIdForUi) || contacts[0];


  if (shuttingDown) {
    const { closed, total } = shutdownProgress;
    const pct = total > 0 ? Math.round((closed / total) * 100) : 0;
    const r = 18, circ = 2 * Math.PI * r;
    return (
      <div className="app-root app-centered">
        <div className="shutdown-overlay">
          <svg width="44" height="44" viewBox="0 0 44 44">
            <circle cx="22" cy="22" r={r} fill="none" stroke="var(--border-default)" strokeWidth="3" />
            <circle cx="22" cy="22" r={r} fill="none" stroke="var(--accent)" strokeWidth="3"
              strokeDasharray={circ} strokeDashoffset={circ - (pct / 100) * circ}
              strokeLinecap="round"
              style={{ transform: "rotate(-90deg)", transformOrigin: "22px 22px", transition: "stroke-dashoffset 0.3s ease" }} />
          </svg>
          <p className="shutdown-title">Closing connections…</p>
          <p className="shutdown-subtitle">Disconnecting each conversation on a random delay so they're harder to correlate.</p>
          <div className="shutdown-bar"><div className="shutdown-bar-fill" style={{ width: `${pct}%` }} /></div>
          {total > 0 && <p className="shutdown-count">{closed} / {total}</p>}
        </div>
      </div>
    );
  }

  if (appState === "loading") {
    return <div className="app-root app-centered"><div className="onboarding-spinner app-loading-spinner" /></div>;
  }

  if (appState === "onboarding") return <Onboarding onComplete={handleOnboardingComplete} />;

  if (appState === "login") {
    return (
      <div className="onboarding-root">
        <div className="onboarding-card">
          <h1 className="onboarding-title">Welcome back</h1>
          <form onSubmit={handleLogin} className="login-form">
            <input type="password" className="onboarding-key-input" placeholder="Password" ref={loginPasswordRef} onChange={(e) => { setLoginPasswordReady(e.currentTarget.value.length > 0); setLoginError(""); }} autoFocus />
            {loginError && <div className="onboarding-error">{loginError}</div>}
            <button type="submit" className="btn btn-primary onboarding-btn" disabled={isUnlocking || !loginPasswordReady}>{isUnlocking ? "Unlocking..." : "Unlock"}</button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="app-root">
      <UpdatePrompt enabled={settings.autoUpdateCheck} updateOverTor={settings.updateOverTor} />
      <Sidebar contacts={contacts} allMessages={messages} activeContactId={activeContactIdForUi} onSelectContact={selectContact} onDeleteContact={deleteContact} onBlockContact={deleteAndBlockContact} onOpenAddContact={() => setShowAddContact(true)} onOpenSettings={() => setShowSettings(true)} myInitials={computeInitials(displayName)} myDisplayName={displayName || "Me"} torStatus={torStatus} syncing={syncing} connectCountdown={connectCountdown} />

      {active ? (
        <ChatView contact={active} messages={messages[active.id] || []} fileProgress={fileProgress} onOpenChatSettings={() => setShowChatSettings(true)} onSendMessage={(text) => sendMessage(active.id, text)} onSendFile={() => sendFile(active.id)} onDownloadFile={downloadFile} sendOnEnter={settings.sendOnEnter} messageTextSize={settings.messageTextSize} />
      ) : (
        <main className="chat-view empty-chat">Generate a connection code or add a contact to start messaging.</main>
      )}

      {showSettings && <Settings settings={settings} onChange={setSettings} displayName={displayName} onChangeName={setDisplayName} onClose={() => setShowSettings(false)} />}
      {showAddContact && <AddContact onClose={() => setShowAddContact(false)} onAdded={handleAddedContact} />}
      {showChatSettings && active && <ChatSettings contact={active} onClose={() => setShowChatSettings(false)} onOpenVerify={() => { setShowChatSettings(false); setShowVerify(true); }} onMigrateRelay={(code) => migrateContactRelay(active.id, code)} />}
      {showVerify && active && <VerifyIdentity contact={active} onClose={() => setShowVerify(false)} onContactUpdated={(updated) => setContacts(prev => prev.map(c => c.id === updated.id ? updated : c))} />}

      {codeWarning && (
        <>
          <div className="context-menu-backdrop" onClick={dismissCodeWarning} />
          <div className="code-warning-modal">
            <div className="code-warning-icon">⚠️</div>
            <h3 className="code-warning-title">Active connection codes detected</h3>
            <p className="code-warning-body">
              You have {codeWarning.codeIds.length} active connection code{codeWarning.codeIds.length > 1 ? "s" : ""} on
              the same relay as the blocked contact. They may still hold a code you
              created. Delete {codeWarning.codeIds.length > 1 ? "them" : "it"} to fully
              cut off access to your relay.
            </p>
            <p className="code-warning-note">
              This will also disconnect anyone else you shared {codeWarning.codeIds.length > 1 ? "those codes" : "that code"} with.
            </p>
            <div className="code-warning-actions">
              <button className="btn btn-secondary" onClick={dismissCodeWarning} disabled={isDeletingCodes}>Keep codes</button>
              <button className="btn btn-danger" onClick={deleteWarningCodes} disabled={isDeletingCodes}>
                {isDeletingCodes ? "Deleting…" : `Delete ${codeWarning.codeIds.length} code${codeWarning.codeIds.length > 1 ? "s" : ""}`}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
