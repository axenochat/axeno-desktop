import { Fragment, useEffect, useRef, useState } from "react";
import { Contact, Message, FileProgress } from "../../types";
import { contactDisplayName, contactInitials, formatClockTime, formatDayDivider, formatFileSize, isSameDay, isSameMinute } from "../../utils";
import { IconDots, IconArrowUp, IconPaperclip, IconDownload, IconFile } from "../icons";
import "./ChatView.css";

interface Props {
  contact: Contact;
  messages: Message[];
  fileProgress: Record<string, FileProgress>;
  onOpenChatSettings: () => void;
  onSendMessage: (text: string) => Promise<void>;
  onSendFile: () => Promise<void>;
  onDownloadFile: (msg: Message) => Promise<void>;
  sendOnEnter: boolean;
  messageTextSize: "small" | "medium" | "large";
}

function messageStatusLabel(status?: string): string {
  switch (status) {
    case "relay_pending": return "sending";
    case "relay_queued": return "queued";
    case "relay_received": return "sent";
    case "send_failed": return "failed";
    default: return "";
  }
}

export default function ChatView({ contact, messages, fileProgress, onOpenChatSettings, onSendMessage, onSendFile, onDownloadFile, sendOnEnter, messageTextSize }: Props) {
  const [input, setInput] = useState("");
  const [sendError, setSendError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  // Whether the view is pinned to the latest message. True while the user is at
  // (or near) the bottom; set false once they scroll up to read history so an
  // incoming message doesn't yank them back down.
  const stickToBottomRef = useRef(true);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 80;
  };

  // Jump to the bottom whenever a different conversation is opened.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickToBottomRef.current = true;
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
    }
  }, [messages]);

  const send = () => {
    const text = input.trim();
    if (!text) return;
    setSendError("");
    setInput("");
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

  return (
    <main className="chat-view">
      <header className="chat-header">
        <div className="chat-avatar">{contactInitials(contact)}</div>
        <div className="chat-header-info">
          <div className="chat-contact-id">{contactDisplayName(contact)}</div>
        </div>
        <button className="chat-icon-button" onClick={onOpenChatSettings} aria-label="Chat settings">
          <IconDots />
        </button>
      </header>

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
                    : msg.text}
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

      <div className="chat-input-wrap">
        <div className="chat-input-row">
          <button
            className="chat-input-attach"
            aria-label="Attach a file"
            title="Attach a file"
            onClick={attach}
          >
            <IconPaperclip />
          </button>
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && (sendOnEnter ? !e.shiftKey : e.ctrlKey)) { e.preventDefault(); send(); } }}
            placeholder="Message"
            className="chat-input"
          />
          <button
            className={`chat-send ${input.length > 0 ? "active" : ""}`}
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
