export interface InviteCode {
  id: string;
  code: string;
  createdAt: number;
  serverUrl: string;
  serverName?: string;
  reusable?: boolean;
}

export interface Contact {
  id: string;
  displayName?: string | null;
  lastReadAt: number | null;
  recipientId?: string;
  serverUrl?: string;
  serverId?: string;
  safetyNumber?: string;
  serverChoice?: ServerChoice;
  trustState?: string;
  verifiedAtMs?: number | null;
}


/** A file rendered on a message bubble. Mirrors the backend FileAttachment,
 * minus the decryption key (which the UI never needs). `downloadState` is
 * "downloaded" for files we sent, and "available"/"downloading"/"downloaded"/
 * "failed" for files we received. */
export interface Attachment {
  transferId: string;
  fileName: string;
  mime: string;
  size: number;
  totalChunks: number;
  serverUrl: string;
  localPath?: string | null;
  downloadState?: string | null;
}

/** Live progress for an in-flight file transfer, keyed by message id in the UI. */
export interface FileProgress {
  direction: "upload" | "download";
  transferred: number;
  total: number;
  done: boolean;
  error?: string | null;
}

export interface Message {
  id: string;
  mine: boolean;
  text: string;
  timestamp: number;
  /** Local receiver-clock time for inbound messages. Used for unread logic so
   * sender clock skew cannot keep a message unread forever.
   */
  receivedAtMs?: number | null;
  status?: string;
  attachment?: Attachment | null;
}

export interface PrivateServer {
  id: string;
  name: string;
  onion: string;
}

export type ServerChoice =
  | { kind: "none" }
  | { kind: "private"; serverId: string };

export interface AppSettings {
  defaultServer: ServerChoice;
  privateServers: PrivateServer[];
  inviteCodes: InviteCode[];
  readReceipts: boolean;
  defaultDisappearingMessages: number;
  notificationsEnabled: boolean;
  notificationShowPreview: boolean;
  notificationShowSender: boolean;
  sendOnEnter: boolean;
  messageTextSize: "small" | "medium" | "large";
  // When on, the app checks GitHub Releases for updates on launch.
  autoUpdateCheck: boolean;
  // When on, update checks and downloads are routed through Tor so GitHub does
  // not see the user's IP. GitHub sometimes blocks Tor, in which case updates
  // fail and the user can retry or turn this off.
  updateOverTor: boolean;
  // When on, relay connections are established on randomly staggered delays at
  // unlock and closed on staggered delays at quit, so a logging relay can't
  // group your per-contact mailboxes by a synchronized burst of connects/closes.
  // Costs a brief delay opening and closing the app. Opt-out (defaults on).
  staggerConnections: boolean;
}

export const defaultSettings: AppSettings = {
  defaultServer: { kind: "none" },
  privateServers: [],
  inviteCodes: [],
  readReceipts: true,
  defaultDisappearingMessages: 0,
  notificationsEnabled: true,
  notificationShowPreview: false,
  notificationShowSender: false,
  sendOnEnter: true,
  messageTextSize: "medium",
  autoUpdateCheck: true,
  updateOverTor: true,
  staggerConnections: true,
};

export interface BackendContact {
  id: string;
  display_name?: string | null;
  recipient_id: string;
  server_url: string;
  server_id: string;
  safety_number: string;
  identity_public_b64?: string;
  registration_id?: number;
  device_id?: number;
  delivery_token?: string;
  trust_state?: string;
  verified_at_ms?: number | null;
  local_route_id?: string | null;
  signed_prekey_id?: number;
  opk_id?: number | null;
  last_read_at?: number | null;
}

export interface BackendAttachment {
  transfer_id: string;
  key_b64: string;
  file_name: string;
  mime: string;
  size: number;
  chunk_size: number;
  total_chunks: number;
  server_url: string;
  local_path?: string | null;
  download_state?: string | null;
}

export interface BackendMessage {
  id: string;
  contact_id: string;
  mine: boolean;
  text: string;
  timestamp: number;
  received_at_ms?: number | null;
  status: string;
  attachment?: BackendAttachment | null;
}

export interface MessagingSnapshot {
  my_recipient_id: string;
  contacts: BackendContact[];
  messages: Record<string, BackendMessage[]>;
}

export function contactFromBackend(c: BackendContact): Contact {
  return {
    id: c.id,
    displayName: c.display_name,
    lastReadAt: c.last_read_at ?? null,
    recipientId: c.recipient_id,
    serverUrl: c.server_url,
    serverId: c.server_id,
    safetyNumber: c.safety_number,
    trustState: c.trust_state,
    verifiedAtMs: c.verified_at_ms ?? null,
  };
}

export function messageFromBackend(m: BackendMessage): Message {
  return {
    id: m.id,
    mine: m.mine,
    text: m.text,
    timestamp: m.timestamp,
    receivedAtMs: m.received_at_ms ?? null,
    status: m.status,
    attachment: m.attachment ? attachmentFromBackend(m.attachment) : null,
  };
}

export function attachmentFromBackend(a: BackendAttachment): Attachment {
  return {
    transferId: a.transfer_id,
    fileName: a.file_name,
    mime: a.mime,
    size: a.size,
    totalChunks: a.total_chunks,
    serverUrl: a.server_url,
    localPath: a.local_path ?? null,
    downloadState: a.download_state ?? null,
  };
}
