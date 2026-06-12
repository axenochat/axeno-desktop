import { Contact, Message } from "./types";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const FULL_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function contactDisplayName(contact: Contact): string {
  const name = contact.displayName?.trim();
  return name || "Unknown contact";
}

export function contactInitials(contact: Contact): string {
  const name = contactDisplayName(contact);
  return name.trim().split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase() || "?";
}

export function formatMessageTime(timestamp: number): string {
  const now = new Date();
  const date = new Date(timestamp);

  if (now.toDateString() === date.toDateString()) {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (yesterday.toDateString() === date.toDateString()) return "Yesterday";

  if (now.getTime() - timestamp < 7 * 86_400_000) return DAYS[date.getDay()];

  return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

// Clock time of day, e.g. "14:32". Shown under each chat bubble; the day it
// belongs to is established by the day-divider above it.
export function formatClockTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

// Label for a day-divider in the message list: "Today", "Yesterday", a weekday
// within the past week, otherwise an absolute date (with year only if it isn't
// the current year).
export function formatDayDivider(timestamp: number): string {
  const now = new Date();
  const date = new Date(timestamp);

  if (now.toDateString() === date.toDateString()) return "Today";

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (yesterday.toDateString() === date.toDateString()) return "Yesterday";

  if (now.getTime() - timestamp < 7 * 86_400_000) return FULL_DAYS[date.getDay()];

  const year = date.getFullYear() === now.getFullYear() ? "" : ` ${date.getFullYear()}`;
  return `${date.getDate()} ${MONTHS[date.getMonth()]}${year}`;
}

// Whether two timestamps fall on the same calendar day.
export function isSameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

// Whether two timestamps fall within the same clock minute. Used to clump a run
// of messages so they share a single trailing timestamp.
export function isSameMinute(a: number, b: number): boolean {
  return Math.floor(a / 60_000) === Math.floor(b / 60_000);
}

/** Human-readable byte size, e.g. 1536 -> "1.5 KB", 0 -> "0 B". */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? value : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

/** One-line preview text for a message in the conversation list. */
export function messagePreview(message: Message): string {
  if (message.attachment) return `📎 ${message.attachment.fileName}`;
  return message.text;
}

export function lastMessage(messages: Message[]): Message | undefined {
  if (!messages.length) return undefined;
  return messages.reduce((a, b) => (a.timestamp > b.timestamp ? a : b));
}

function unreadComparisonTime(message: Message): number {
  // Inbound message.timestamp is chosen by the sender. For unread state we need
  // the local receiver clock, otherwise two localhost clients with slightly
  // different clocks can leave a badge stuck forever after mark-as-read.
  return message.receivedAtMs ?? message.timestamp;
}

export function unreadCount(messages: Message[], lastReadAt: number | null): number {
  const inbound = messages.filter(m => !m.mine);
  if (lastReadAt === null) return inbound.length;
  return inbound.filter(m => unreadComparisonTime(m) > lastReadAt).length;
}
