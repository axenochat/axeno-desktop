import { Fragment, useEffect, useRef, useState } from "react";
import { Contact, Message, FileProgress } from "../../types";
import { contactDisplayName, contactInitials, formatClockTime, formatDayDivider, formatFileSize, isSameDay, isSameMinute, linkifySegments } from "../../utils";
import { IconDots, IconArrowUp, IconPaperclip, IconDownload, IconFile, IconShield, IconChevronDown } from "../icons";
import "./ChatView.css";

interface Props {
  contact: Contact;
  messages: Message[];
  fileProgress: Record<string, FileProgress>;
  onOpenChatSettings: () => void;
  onOpenVerify: () => void;
  onSendMessage: (text: string) => Promise<void>;
  onSendFile: () => Promise<void>;
  onDownloadFile: (msg: Message) => Promise<void>;
  onOpenLink: (url: string) => void;
  sendOnEnter: boolean;
  messageTextSize: "small" | "medium" | "large";
}

// A small, dependency-free palette of common emoji for the composer picker.
const EMOJI = [
  "😀", "😂", "🙂", "😉", "😍", "😎", "🤔", "😅", "😭", "😡",
  "👍", "👎", "🙏", "👋", "💪", "🔥", "🎉", "✅", "❌", "⚠️",
  "❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "💔", "⭐", "✨",
  "📎", "📁", "🔒", "🔑", "🕵️", "👀", "💬", "⏰", "☕", "🍺",
];

function messageStatusLabel(status?: string): string {
  switch (status) {
    case "relay_pending": return "sending";
    case "relay_queued": return "queued";
    case "relay_received": return "sent";
    case "send_failed": return "failed";
    default: return "";
  }
}

// Render a message body as plain text with clickable http(s) links. Links never
// navigate directly; they call onOpenLink, which the app gates behind a
// deanonymisation warning before handing the URL to the OS opener.
// The wrapper carries white-space: pre-wrap so the line breaks the sender typed
// survive; without it the browser collapses them into single spaces.
function MessageText({ text, onOpenLink }: { text: string; onOpenLink: (url: string) => void }) {
  const segments = linkifySegments(text);
  return (
    <span className="msg-text">
      {segments.map((seg, i) =>
        seg.type === "link" ? (
          <span
            key={i}
            className="msg-link"
            role="link"
            tabIndex={0}
            title={seg.value}
            onClick={(e) => { e.stopPropagation(); onOpenLink(seg.value); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onOpenLink(seg.value); } }}
          >
            {seg.value}
          </span>
        ) : (
          <Fragment key={i}>{seg.value}</Fragment>
        )
      )}
    </span>
  );
}

export default function ChatView({ contact, messages, fileProgress, onOpenChatSettings, onOpenVerify, onSendMessage, onSendFile, onDownloadFile, onOpenLink, sendOnEnter, messageTextSize }: Props) {
  const [input, setInput] = useState("");
  const [sendError, setSendError] = useState("");
  const [showEmoji, setShowEmoji] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Whether the view is pinned to the latest message. True while the user is at
  // (or near) the bottom; set false once they scroll up to read history so an
  // incoming message doesn't yank them back down.
  const stickToBottomRef = useRef(true);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const near = distanceFromBottom < 80;
    stickToBottomRef.current = near;
    setAtBottom(near);
  };

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickToBottomRef.current = true;
    setAtBottom(true);
  };

  // Jump to the bottom whenever a different conversation is opened.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickToBottomRef.current = true;
    setAtBottom(true);
    setShowEmoji(false);
  }, [contact.id]);

  // Keep the newest message visible as messages arrive. We always follow our own
  // sent message; for incoming messages we only follow when the user is already
  // at the bottom, so reading older history isn't interrupted.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const lastMine = messages[messages.length - 1]?.mine ?? false;
    if (stickToBottomRef.current || lastMine) {
      el.scrollTop = el.scrollHeight;
      setAtBottom(true);
    }
  }, [messages]);

  // Grow the composer with its content, up to a cap, then let it scroll.
  const autosize = () => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };
  useEffect(autosize, [input]);

  const send = () => {
    // Normalise CRLF/CR pasted from other apps to plain LF — the bubble renders
    // with pre-wrap, where a stray CR shows up as an extra blank line.
    const text = input.replace(/\r\n?/g, "\n").trim();
    if (!text) return;
    setSendError("");
    setInput("");
    setShowEmoji(false);
    // Reset the textarea height after clearing.
    requestAnimationFrame(autosize);
    // Fire-and-forget: each message gets its own optimistic bubble with a
    // per-message status, so an in-flight send must not block typing the next.
    onSendMessage(text).catch(e => {
      setSendError(typeof e === "string" ? e : "Could not send message");
    });
  };

  const attach = () => {
    setSendError("");
    onSendFile().catch(e => {
      setSendError(typeof e === "string" ? e : "Could not send file");
    });
  };

  const download = (msg: Message) => {
    setSendError("");
    onDownloadFile(msg).catch(e => {
      setSendError(typeof e === "string" ? e : "Could not download file");
    });
  };

  const insertEmoji = (emoji: string) => {
    const el = inputRef.current;
    if (el && typeof el.selectionStart === "number") {
      const start = el.selectionStart;
      const end = el.selectionEnd ?? start;
      const next = input.slice(0, start) + emoji + input.slice(end);
      setInput(next);
      requestAnimationFrame(() => {
        el.focus();
        const pos = start + emoji.length;
        el.setSelectionRange(pos, pos);
      });
    } else {
      setInput(prev => prev + emoji);
    }
  };

  const trust = contact.trustState ?? "unverified";
  const showVerifyChip = trust !== "verified";

  return (
    <main className="chat-view">
      <header className="chat-header">
        <div className="chat-avatar">{contactInitials(contact)}</div>
        <div className="chat-header-info">
          <div className="chat-contact-id">{contactDisplayName(contact)}</div>
        </div>
        {showVerifyChip && (
          <button
            className={`chat-verify-chip ${trust === "identity_changed_blocked" ? "danger" : ""}`}
            onClick={onOpenVerify}
            title={trust === "identity_changed_blocked"
              ? "This contact's identity key changed. Re-verify before trusting."
              : "You haven't verified this contact's safety number yet."}
          >
            <IconShield />
            <span>{trust === "identity_changed_blocked" ? "Identity changed" : "Verify"}</span>
          </button>
        )}
        <button className="chat-icon-button" onClick={onOpenChatSettings} aria-label="Chat settings">
          <IconDots />
        </button>
      </header>

      <div className="chat-messages-wrap">
        <div className="chat-messages" ref={scrollRef} onScroll={handleScroll}>
          {messages.map((msg, i) => {
            const prev = messages[i - 1];
            const next = messages[i + 1];
            const isSequenceStart = !prev || prev.mine !== msg.mine;
            const showDivider = !prev || !isSameDay(prev.timestamp, msg.timestamp);
            // Clump a run of same-sender messages from the same minute under one
            // trailing timestamp; always surface a failed send.
            const endOfClump = !next || next.mine !== msg.mine || !isSameMinute(msg.timestamp, next.timestamp);
            const statusLabel = msg.mine ? messageStatusLabel(msg.status) : "";
            const showMeta = endOfClump || msg.status === "send_failed";
            return (
              <Fragment key={msg.id}>
                {showDivider && (
                  <div className="date-divider">
                    <span className="date-line"></span>
                    <span className="date-label">{formatDayDivider(msg.timestamp)}</span>
                    <span className="date-line"></span>
                  </div>
                )}
                <div
                  className={`message-row ${msg.mine ? "mine" : "theirs"} ${isSequenceStart && prev && !showDivider ? "sequence-start" : ""}`}
                >
                  <div className={`bubble ${msg.mine ? "bubble-mine" : "bubble-theirs"} text-${messageTextSize}${msg.attachment ? " bubble-file" : ""}`}>
                    {msg.attachment
                      ? <FileBubble msg={msg} progress={fileProgress[msg.id]} onDownload={() => download(msg)} />
                      : <MessageText text={msg.text} onOpenLink={onOpenLink} />}
                  </div>
                  {showMeta && (
                    <div className="message-time">
                      {formatClockTime(msg.timestamp)}
                      {statusLabel && <span className={`message-status status-${msg.status}`}> · {statusLabel}</span>}
                    </div>
                  )}
                </div>
              </Fragment>
            );
          })}
        </div>

        {!atBottom && (
          <button className="chat-jump-latest" onClick={scrollToBottom} aria-label="Jump to latest messages" title="Jump to latest">
            <IconChevronDown />
          </button>
        )}
      </div>

      <div className="chat-input-wrap">
        {showEmoji && (
          <div className="emoji-panel" role="listbox" aria-label="Emoji">
            {EMOJI.map(e => (
              <button key={e} className="emoji-item" onClick={() => insertEmoji(e)} tabIndex={0}>{e}</button>
            ))}
          </div>
        )}
        <div className="chat-input-row">
          <button
            className="chat-input-attach"
            aria-label="Attach a file"
            title="Attach a file"
            onClick={attach}
          >
            <IconPaperclip />
          </button>
          <button
            className={`chat-input-emoji ${showEmoji ? "active" : ""}`}
            aria-label="Insert emoji"
            title="Emoji"
            onClick={() => setShowEmoji(s => !s)}
          >
            <span aria-hidden>🙂</span>
          </button>
          <textarea
            ref={inputRef}
            value={input}
            rows={1}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && (sendOnEnter ? !e.shiftKey : e.ctrlKey)) { e.preventDefault(); send(); }
            }}
            placeholder="Message"
            className="chat-input"
          />
          <button
            className={`chat-send ${input.trim().length > 0 ? "active" : ""}`}
            aria-label="Send message"
            onClick={send}
            disabled={!input.trim()}
          >
            <IconArrowUp />
          </button>
        </div>
        {sendError && <div className="onboarding-error chat-error">{sendError}</div>}
      </div>
    </main>
  );
}

function FileBubble({ msg, progress, onDownload }: { msg: Message; progress?: FileProgress; onDownload: () => void }) {
  const att = msg.attachment!;
  const state = att.downloadState ?? (msg.mine ? "downloaded" : "available");
  // A live progress event wins over the stored state while a transfer runs.
  const active = progress && !progress.done && !progress.error;
  const pct = active && progress!.total > 0
    ? Math.min(100, Math.round((progress!.transferred / progress!.total) * 100))
    : null;

  let action: React.ReactNode = null;
  if (active) {
    const verb = progress!.direction === "upload" ? "Uploading" : "Downloading";
    action = <span className="file-status">{verb}{pct !== null ? ` ${pct}%` : "…"}</span>;
  } else if (msg.mine) {
    // Our own files: the message-level status row ("sending"/"sent") already
    // conveys delivery, so no redundant bubble label here. The upload % above
    // covers the in-flight case.
    action = null;
  } else if (state === "downloaded") {
    action = <span className="file-status">Saved</span>;
  } else if (state === "downloading") {
    action = <span className="file-status">Downloading…</span>;
  } else {
    action = (
      <button className="file-download" onClick={onDownload} aria-label="Download file" title="Download">
        <IconDownload />
      </button>
    );
  }

  return (
    <div className="file-bubble">
      <div className="file-icon"><IconFile /></div>
      <div className="file-meta">
        <div className="file-name" title={att.fileName}>{att.fileName}</div>
        <div className="file-sub">
          {att.size > 0 ? formatFileSize(att.size) : ""}
          {state === "failed" && <span className="file-failed"> · failed</span>}
        </div>
        {pct !== null && (
          <div className="file-progress-track"><div className="file-progress-fill" style={{ width: `${pct}%` }} /></div>
        )}
      </div>
      <div className="file-action">{action}</div>
    </div>
  );
}
