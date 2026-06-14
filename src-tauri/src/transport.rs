//! WebSocket transport for Axeno.
//!
//! This module implements one live WebSocket connection per route/mailbox plus
//! short-lived standalone relay requests for opaque invite-bundle upload/fetch.
//! It only moves opaque envelopes and opaque encrypted bundles.

use std::{collections::{HashMap, HashSet}, sync::{Arc, OnceLock}, time::{SystemTime, UNIX_EPOCH}};

use arti_client::{DataStream, IsolationToken, StreamPrefs, TorClient};
use futures_util::{Sink, SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt}, net::{TcpListener, TcpStream}, sync::{mpsc, oneshot, Mutex, Notify}, time::{sleep, timeout, Duration, Instant}};
use tokio_tungstenite::{connect_async, client_async, tungstenite::{client::IntoClientRequest, Message}, WebSocketStream};
use tor_rtcompat::PreferredRuntime;
use uuid::Uuid;

const PROTOCOL_MIN_SUPPORTED: u16 = 4;
// v6 adds the `synced` server frame (terminal end-of-backlog marker).
// v7 adds chunked file transfer (upload/fetch/delete frames) and the
// `max_file_bytes` field on `hello_ok`.
const PROTOCOL_VERSION: u16 = 7;
/// If a relay never sends `Synced` (it predates protocol v6), clear this
/// connection's syncing flag this long after HelloOk so the indicator can't
/// stick on. A v6 relay sends `Synced` right after the flush, well within this.
const SYNC_FALLBACK_AFTER_HELLO: Duration = Duration::from_secs(6);
const OUTBOUND_QUEUE_CAPACITY: usize = 256;
const ONION_CONNECT_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(30);
const ONION_CONNECT_RETRY_WINDOW: Duration = Duration::from_secs(150);
/// How often the persistent receive socket sends a keepalive Ping. Over Tor an
/// idle stream can be reaped without producing a prompt read error, leaving the
/// receive socket silently dead so incoming envelopes stall. A periodic write
/// both keeps the circuit warm and surfaces a dead circuit fast (the failed
/// write tears the connection down and triggers the frontend reconnect).
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(30);
/// Proof-of-work difficulty: the required number of leading zero bits on the
/// SHA-256 of the challenge. This MUST equal the relay's `POW_LEADING_ZERO_BITS`
/// (axeno-relay `config.rs`). The relay rejects any PoW with fewer leading zero
/// bits, so to change it, ship the higher client value first and only then raise
/// the relay. Keeping it a single named constant (read by `pow_hash_ok` below)
/// removes the old hand-inlined bit test that silently encoded "22" in three
/// places.
const POW_LEADING_ZERO_BITS: u32 = 22;

/// True if `hash` begins with at least [`POW_LEADING_ZERO_BITS`] zero bits.
/// Mirrors the relay's `pow_hash_ok` (axeno-relay `util.rs`) byte-for-byte so the
/// two ends never disagree on how the bit count is read off the digest.
fn pow_hash_ok(hash: &[u8]) -> bool {
    let mut bits = POW_LEADING_ZERO_BITS;
    for &byte in hash {
        if bits == 0 { break; }
        if bits >= 8 {
            if byte != 0 { return false; }
            bits -= 8;
        } else {
            return (byte >> (8 - bits)) == 0;
        }
    }
    true
}

#[derive(Clone, Default)]
pub struct TransportState {
    connections: Arc<Mutex<HashMap<String, ServerConnection>>>,
    pending_sender_certs: Arc<Mutex<HashMap<String, oneshot::Sender<SenderCertificateResponse>>>>,
    sender_cert_cache: Arc<Mutex<HashMap<String, SenderCertificateResponse>>>,
    pending_token_updates: Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>,
    pending_sends: Arc<Mutex<HashMap<String, oneshot::Sender<Result<SendEnvelopeAck, String>>>>>,
    /// In-flight file-transfer requests (upload/fetch/delete), keyed by their
    /// per-request id. The receive loop resolves each with the relay's reply.
    pending_files: Arc<Mutex<HashMap<String, oneshot::Sender<FileOpReply>>>>,
    /// Per-server operator-advertised per-file byte cap, captured from HelloOk so
    /// the client can pre-check a file size and surface the limit in the UI.
    server_file_limits: Arc<Mutex<HashMap<String, u64>>>,
    server_trust_roots: Arc<Mutex<HashMap<String, String>>>,
    /// Connection ids whose offline backlog is still being delivered (from the
    /// start of the connection attempt until the relay's `Synced` marker, a
    /// fallback timeout, or disconnect). The frontend shows a "syncing" indicator
    /// while this set is non-empty.
    syncing_conns: Arc<Mutex<HashSet<String>>>,
}

impl TransportState {
    pub fn new() -> Self { Self::default() }
}

struct ServerConnection {
    url: String,
    recipient_id: String,
    instance_id: Uuid,
    outbound: mpsc::Sender<ClientFrame>,
    /// Fires a graceful close of this connection's read loop so the underlying
    /// Tor stream is dropped on demand — letting staggered shutdown make the relay
    /// see this mailbox go offline at its own time, rather than every socket
    /// dropping together when the process exits.
    shutdown: Arc<Notify>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredEnvelope {
    pub id: Uuid,
    pub to: String,
    pub envelope_type: String,
    pub ciphertext: String,
}

async fn generate_pow(recipient_id: &str) -> String {
    let rid = recipient_id.to_string();
    tokio::task::spawn_blocking(move || {
        use sha2::{Sha256, Digest};
        use std::time::{SystemTime, UNIX_EPOCH};
        let mut nonce = 0u64;
        // Include a coarse timestamp (10-minute window) so the PoW nonce
        // cannot be replayed outside a narrow time window.
        let ts_window = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() / 600;
        let prefix = format!("{rid}:{ts_window}:");
        loop {
            let input = format!("{prefix}{nonce}");
            let hash = Sha256::digest(input.as_bytes());
            if pow_hash_ok(&hash) {
                return format!("{ts_window}:{nonce}");
            }
            nonce += 1;
        }
    }).await.unwrap_or_else(|_| "0:0".to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[allow(dead_code)]
enum ClientFrame {
    Hello { recipient_id: String, auth_token: String, delivery_token: String, protocol_min: u16, protocol_max: u16, pow: Option<String>, cert_only: bool },
    SetDeliveryTokens { request_id: String, tokens: Vec<String> },
    IssueSenderCertificate { request_id: String, sender_uuid: String, sender_device_id: u32, sender_cert_public_b64: String },
    SendEnvelope {
        client_ref: Option<String>,
        to: String,
        delivery_token: String,
        envelope_type: String,
        ciphertext: String,
    },
    UploadBundle { request_id: String, bundle_id: String, ciphertext: String, expires_at_ms: u64, pow: Option<String> },
    FetchBundle { request_id: String, bundle_id: String },
    UploadFileChunk { request_id: String, transfer_id: String, chunk_index: u32, total_chunks: u32, total_bytes: u64, ciphertext: String, pow: Option<String> },
    FetchFileChunk { request_id: String, transfer_id: String, chunk_index: u32 },
    DeleteTransfer { request_id: String, transfer_id: String },
    Ack { ids: Vec<Uuid> },
    RetireMailbox,
    Ping,
}

/// The relay's reply to one in-flight file-transfer request, routed back to the
/// waiting `upload_file_chunk` / `fetch_file_chunk` / `delete_transfer` call by
/// request id.
#[derive(Debug)]
enum FileOpReply {
    ChunkStored { received_chunks: u32, total_chunks: u32 },
    Chunk { total_chunks: u32, total_bytes: u64, ciphertext: String },
    Deleted,
    Error { code: String, message: String },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[allow(dead_code)]
enum ServerFrame {
    HelloOk { protocol_version: u16, server_time_ms: u64, trust_root_b64: String, #[serde(default)] min_supported: Option<u16>, #[serde(default)] current_protocol: Option<u16>, #[serde(default)] max_file_bytes: Option<u64> },
    SenderCertificate { request_id: String, certificate_b64: String, trust_root_b64: String, expires_at_ms: u64 },
    BundleUploaded { request_id: String, bundle_id: String, expires_at_ms: u64 },
    Bundle { request_id: String, bundle_id: String, ciphertext: String, expires_at_ms: u64 },
    FileChunkStored { request_id: String, transfer_id: String, chunk_index: u32, received_chunks: u32, total_chunks: u32 },
    FileChunk { request_id: String, transfer_id: String, chunk_index: u32, total_chunks: u32, total_bytes: u64, ciphertext: String },
    TransferDeleted { request_id: String, transfer_id: String },
    FileError { request_id: String, transfer_id: String, code: String, message: String },
    Envelope { envelope: StoredEnvelope },
    /// Terminal end-of-backlog marker (relay protocol v6+). See `ServerFrame` in
    /// the relay's protocol.rs.
    Synced { count: u64 },
    SendOk { id: Uuid, queued: bool, client_ref: Option<String> },
    SendError { client_ref: Option<String>, code: String, message: String },
    DeliveryTokensSet { request_id: String, active_count: usize },
    AckOk { removed: usize },
    Pong { server_time_ms: u64 },
    Error { code: String, message: String },
    /// Forward compatibility: any frame type this client does not recognize
    /// deserializes here and is ignored, instead of failing the whole connection.
    /// This makes future relay protocol additions non-breaking for old clients.
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
pub struct TransportStatusEvent {
    pub server_id: String,
    pub status: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SyncStatusEvent {
    /// True while any connection is still delivering its offline backlog.
    pub syncing: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct IncomingEnvelopeEvent {
    pub server_id: String,
    pub envelope: StoredEnvelope,
}

#[derive(Debug, Clone, Serialize)]
pub struct SendReceipt {
    pub server_id: String,
    pub id: Uuid,
    pub queued: bool,
    pub client_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SendFailure {
    pub server_id: String,
    pub client_ref: Option<String>,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SenderCertificateResponse {
    pub certificate_b64: String,
    pub trust_root_b64: String,
    pub expires_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendEnvelopeAck {
    pub id: Uuid,
    pub queued: bool,
    pub client_ref: Option<String>,
}

pub async fn connect_server(
    app: AppHandle,
    state: &TransportState,
    tor_client: Arc<Mutex<Option<TorClient<PreferredRuntime>>>>,
    server_id: String,
    url: String,
    recipient_id: String,
    auth_token: String,
    delivery_token: String,
) -> Result<(), String> {
    validate_ws_url(&url)?;
    validate_recipient_id(&recipient_id)?;
    validate_token(&auth_token, "auth token")?;
    validate_token(&delivery_token, "delivery token")?;

    let mut guard = state.connections.lock().await;
    if let Some(existing) = guard.get(&server_id) {
        if existing.url == url && existing.recipient_id == recipient_id && !existing.outbound.is_closed() {
            return Ok(());
        }
        guard.remove(&server_id);
    }

    let (tx, rx) = mpsc::channel::<ClientFrame>(OUTBOUND_QUEUE_CAPACITY);
    let instance_id = Uuid::new_v4();
    let shutdown = Arc::new(Notify::new());
    guard.insert(server_id.clone(), ServerConnection { url: url.clone(), recipient_id: recipient_id.clone(), instance_id, outbound: tx.clone(), shutdown: shutdown.clone() });
    drop(guard);

    let (ready_tx, ready_rx) = oneshot::channel::<Result<(), String>>();
    let app_for_task = app.clone();
    let pending_certs = state.pending_sender_certs.clone();
    let pending_token_updates = state.pending_token_updates.clone();
    let pending_sends = state.pending_sends.clone();
    let pending_files = state.pending_files.clone();
    let server_file_limits = state.server_file_limits.clone();
    let trust_roots = state.server_trust_roots.clone();
    let connections = state.connections.clone();
    let syncing_conns = state.syncing_conns.clone();
    let task_server_id = server_id.clone();
    tokio::spawn(async move {
        let _ = emit_status(&app_for_task, &task_server_id, "connecting", None);
        // Mark this connection as syncing for its whole lifetime up to the
        // relay's `Synced` marker (set during the run). The backlog replay spans
        // the Tor connect + handshake, so marking here — not at HelloOk — keeps
        // the indicator on through the slow part too.
        set_conn_syncing(&app_for_task, &syncing_conns, &task_server_id, true).await;
        let result = run_connection(app_for_task.clone(), tor_client, pending_certs, pending_token_updates, pending_sends, pending_files, server_file_limits, trust_roots, syncing_conns.clone(), task_server_id.clone(), url, recipient_id, auth_token, delivery_token, rx, shutdown, Some(ready_tx)).await;
        remove_connection_if_same(&connections, &task_server_id, instance_id).await;
        // Cleanup: if the connection ended before `Synced` (e.g. it failed during
        // connect), clear its syncing flag so the indicator can't stick.
        set_conn_syncing(&app_for_task, &syncing_conns, &task_server_id, false).await;
        match result {
            Ok(()) => { let _ = emit_status(&app_for_task, &task_server_id, "disconnected", None); }
            Err(e) => { let _ = emit_status(&app_for_task, &task_server_id, "failed", Some(e)); }
        }
    });

    match timeout(Duration::from_secs(10), ready_rx).await {
        Ok(Ok(Ok(()))) => Ok(()),
        Ok(Ok(Err(e))) => { remove_connection_if_same(&state.connections, &server_id, instance_id).await; Err(e) }
        Ok(Err(_)) => { remove_connection_if_same(&state.connections, &server_id, instance_id).await; Err("relay connection closed before registration completed".to_string()) }
        Err(_) => {
            // Onion hidden-service circuits often take longer than the UI wait
            // budget immediately after a relay restart. Keep this in-progress
            // route in the map so queued cert requests can complete once the
            // background websocket reaches HelloOk.
            Err("timed out waiting for relay registration".to_string())
        }
    }
}

async fn remove_connection_if_same(
    connections: &Arc<Mutex<HashMap<String, ServerConnection>>>,
    server_id: &str,
    instance_id: Uuid,
) {
    let mut guard = connections.lock().await;
    let is_ours = guard.get(server_id).map(|c| c.instance_id == instance_id).unwrap_or(false);
    if is_ours {
        guard.remove(server_id);
    }
}

pub async fn disconnect_server(
    state: &TransportState,
    server_id: String,
) -> Result<(), String> {
    // Removing drops the outbound sender (ending the writer); the explicit
    // shutdown signal additionally breaks the read loop so the Tor stream is
    // dropped now and the relay observes the disconnect, instead of the socket
    // lingering until the process exits.
    if let Some(conn) = state.connections.lock().await.remove(&server_id) {
        conn.shutdown.notify_one();
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct ShutdownProgress {
    pub closed: usize,
    pub total: usize,
}

/// Longest random delay before any one socket is closed during staggered
/// shutdown. Kept short so quitting still feels responsive.
const SHUTDOWN_STAGGER_MAX_MS: u64 = 6_000;

fn random_stagger_delay() -> Duration {
    let mut buf = [0u8; 8];
    if getrandom::getrandom(&mut buf).is_err() { return Duration::ZERO; }
    Duration::from_millis(u64::from_le_bytes(buf) % (SHUTDOWN_STAGGER_MAX_MS + 1))
}

/// Close every live relay connection on an independent, randomly staggered
/// schedule — the offline counterpart to the jittered connect (see messaging
/// `jittered_connect_delay`). Dropping every socket at once on quit would let a
/// logging relay see this client's mailboxes all go offline in one burst and
/// group them as one user; spreading the closes breaks that signal. Emits
/// `axeno-shutdown-progress` as each socket closes so the UI can hold a progress
/// bar, and resolves once the last one is closed.
pub async fn disconnect_all_staggered(app: &AppHandle, state: &TransportState) {
    let ids: Vec<String> = state.connections.lock().await.keys().cloned().collect();
    let total = ids.len();
    let _ = app.emit("axeno-shutdown-progress", ShutdownProgress { closed: 0, total });
    if total == 0 { return; }

    let closed = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let mut handles = Vec::new();
    for id in ids {
        let state = state.clone();
        let app = app.clone();
        let closed = closed.clone();
        handles.push(tokio::spawn(async move {
            sleep(random_stagger_delay()).await;
            let _ = disconnect_server(&state, id).await;
            let n = closed.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
            let _ = app.emit("axeno-shutdown-progress", ShutdownProgress { closed: n, total });
        }));
    }
    for h in handles { let _ = h.await; }
}

pub async fn set_delivery_tokens_confirmed(
    state: &TransportState,
    server_id: String,
    tokens: Vec<String>,
) -> Result<(), String> {
    if tokens.is_empty() { return Err("delivery-token allowlist may not be empty".into()); }
    for token in &tokens { validate_token(token, "delivery token")?; }
    let request_id = Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    state.pending_token_updates.lock().await.insert(request_id.clone(), tx);

    let send_result = {
        let guard = state.connections.lock().await;
        match guard.get(&server_id) {
            Some(conn) => conn.outbound.try_send(ClientFrame::SetDeliveryTokens { request_id: request_id.clone(), tokens })
                .map_err(|e| format!("server connection is not accepting frames; reconnect and try again: {e}")),
            None => Err("server is not connected".to_string()),
        }
    };

    if let Err(e) = send_result {
        state.pending_token_updates.lock().await.remove(&request_id);
        return Err(e);
    }

    match timeout(Duration::from_secs(10), rx).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(_)) => {
            state.pending_token_updates.lock().await.remove(&request_id);
            Err("delivery-token update response channel closed".to_string())
        }
        Err(_) => {
            state.pending_token_updates.lock().await.remove(&request_id);
            Err("timed out waiting for delivery-token update confirmation".to_string())
        }
    }
}

pub async fn send_envelope(
    state: &TransportState,
    server_id: String,
    to: String,
    delivery_token: String,
    envelope_type: String,
    ciphertext: String,
    client_ref: Option<String>,
) -> Result<SendEnvelopeAck, String> {
    validate_recipient_id(&to)?;
    validate_token(&delivery_token, "delivery token")?;
    if envelope_type.len() > 32 { return Err("envelope_type is too long".into()); }
    if ciphertext.len() > 512 * 1024 { return Err("ciphertext exceeds 512 KiB frame limit".into()); }

    // Wait for the relay's SendOk/SendError here, but only from the Rust async
    // worker path. The UI freeze came from calling this through a synchronous
    // Tauri block_on; the command now runs off the UI thread, while this ACK wait
    // gives the caller a real truth signal instead of leaving messages stuck at
    // relay_pending forever when the relay rejects or wedges.
    let client_ref = client_ref.unwrap_or_else(|| Uuid::new_v4().to_string());
    let (tx, rx) = oneshot::channel();
    state.pending_sends.lock().await.insert(client_ref.clone(), tx);

    let send_result = {
        let guard = state.connections.lock().await;
        match guard.get(&server_id) {
            Some(conn) => conn.outbound.try_send(ClientFrame::SendEnvelope {
                client_ref: Some(client_ref.clone()),
                to,
                delivery_token,
                envelope_type,
                ciphertext,
            }).map_err(|e| format!("server connection is not accepting frames; reconnect and try again: {e}")),
            None => Err("server is not connected".to_string()),
        }
    };

    if let Err(e) = send_result {
        state.pending_sends.lock().await.remove(&client_ref);
        return Err(e);
    }

    match timeout(Duration::from_secs(15), rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => {
            state.pending_sends.lock().await.remove(&client_ref);
            Err("send acknowledgement channel closed".to_string())
        }
        Err(_) => {
            state.pending_sends.lock().await.remove(&client_ref);
            Err("timed out waiting for relay send acknowledgement".to_string())
        }
    }
}

/// Number of Tor circuits in the per-relay pool. Streams are spread across this
/// many circuits per onion host for failure isolation (one dead circuit only
/// stalls a fraction of routes, not all of them) and to avoid head-of-line
/// blocking (a large file transfer can't choke every chat that shares one
/// circuit). It is deliberately small — see `pool_key` for why circuit isolation
/// is NOT a privacy feature here.
const CIRCUIT_POOL_SIZE: u64 = 3;

/// Stable Tor stream-isolation token for a pool key. Streams sharing a token may
/// share a Tor circuit; streams with different tokens are forced onto separate
/// circuits. The token is generated once per key and reused, so reconnects map
/// back to the same pool circuit instead of churning a fresh circuit each time.
fn isolation_token_for(key: &str) -> IsolationToken {
    static TOKENS: OnceLock<std::sync::Mutex<HashMap<String, IsolationToken>>> = OnceLock::new();
    let tokens = TOKENS.get_or_init(|| std::sync::Mutex::new(HashMap::new()));
    let mut guard = tokens.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard.entry(key.to_string()).or_insert_with(IsolationToken::new)
}

/// Map a route/mailbox/transfer id to one of a small fixed pool of circuits for
/// the given onion host.
///
/// We deliberately do NOT isolate per mailbox for anonymity. The relay terminates
/// its onion service with a stock `HiddenServicePort .. 127.0.0.1:<port>` forward
/// (see axeno-relay `tor.rs`), so it sees only loopback TCP connections and has no
/// visibility into which Tor circuit a connection rode. Per-mailbox circuits would
/// therefore hide nothing from the relay that the mailbox ids and connect/
/// disconnect timing don't already reveal — and there is no exit node for an onion
/// service to correlate at either. So isolation buys no unlinkability here; the
/// only reasons to split circuits are reliability and head-of-line blocking, which
/// a tiny pool serves at a fraction of the rendezvous-circuit and keepalive cost
/// of one circuit per mailbox. Bucketing is stable across runs, so a given id
/// keeps reusing the same pool circuit across reconnects.
fn pool_key(host: &str, isolation_key: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    isolation_key.hash(&mut hasher);
    let bucket = hasher.finish() % CIRCUIT_POOL_SIZE;
    format!("{host}#{bucket}")
}

async fn connect_onion_stream_with_retries(
    tor_client: Arc<Mutex<Option<TorClient<PreferredRuntime>>>>,
    isolation_key: &str,
    host: &str,
    port: u16,
) -> Result<DataStream, String> {
    let client = tor_client.lock().await.clone().ok_or_else(|| "Tor is not bootstrapped yet; call bootstrap_tor first".to_string())?;
    let mut prefs = StreamPrefs::new();
    prefs.set_isolation(isolation_token_for(&pool_key(host, isolation_key)));
    let started = Instant::now();
    let mut attempt = 0u32;

    loop {
        attempt = attempt.saturating_add(1);
        let last_error = match timeout(ONION_CONNECT_ATTEMPT_TIMEOUT, client.connect_with_prefs((host, port), &prefs)).await {
            Ok(Ok(stream)) => return Ok(stream),
            Ok(Err(e)) => format!("Tor connect failed: {e}"),
            Err(_) => format!("Tor connect timed out after {}s", ONION_CONNECT_ATTEMPT_TIMEOUT.as_secs()),
        };

        let elapsed = started.elapsed();
        if elapsed >= ONION_CONNECT_RETRY_WINDOW {
            return Err(format!(
                "{last_error}; gave up after {attempt} attempts over about {}s while waiting for hidden-service reachability after restart",
                elapsed.as_secs()
            ));
        }
        let delay_secs = match attempt {
            0 | 1 => 1,
            2 => 2,
            3 => 4,
            4 => 8,
            _ => 12,
        };
        let remaining = ONION_CONNECT_RETRY_WINDOW.saturating_sub(elapsed);
        sleep(Duration::from_secs(delay_secs).min(remaining)).await;
    }
}

/// Send one opaque envelope over a fresh unauthenticated WebSocket.
///
/// This is the FALLBACK send path, used only when no live connection is available
/// for the route (see `send_signal_payload_internal`). It opens a fresh circuit
/// with no Hello/auth, so the relay gets no socket-level sender mailbox for the
/// send — it sees only ciphertext, destination mailbox, timing, and size.
///
/// Note the steady-state path differs: to avoid a brand-new onion circuit per
/// message, the primary path reuses the warm, already-authenticated route socket
/// (the same one that requested the sender certificate). On that path the relay
/// does observe authenticated-sender-mailbox -> destination-mailbox for the send.
/// Because every route mailbox is a per-contact pseudonym unlinkable to the stable
/// Signal identity and to the user's other routes, that linkage is confined to the
/// single contact pair; it is not linkage to the user's identity or contact graph.
/// Sender authenticity in both cases lives inside the sealed-sender/Signal envelope.
pub async fn send_envelope_once(
    tor_client: Arc<Mutex<Option<TorClient<PreferredRuntime>>>>,
    url: String,
    to: String,
    delivery_token: String,
    envelope_type: String,
    ciphertext: String,
    client_ref: Option<String>,
) -> Result<SendEnvelopeAck, String> {
    validate_ws_url(&url)?;
    validate_recipient_id(&to)?;
    validate_token(&delivery_token, "delivery token")?;
    if envelope_type.len() > 32 { return Err("envelope_type is too long".into()); }
    if ciphertext.len() > 512 * 1024 { return Err("ciphertext exceeds 512 KiB frame limit".into()); }

    let client_ref = client_ref.unwrap_or_else(|| Uuid::new_v4().to_string());
    let isolation_key = to.clone();
    let frame = ClientFrame::SendEnvelope {
        client_ref: Some(client_ref.clone()),
        to,
        delivery_token,
        envelope_type,
        ciphertext,
    };
    let parsed = parse_ws_url(&url)?;
    if parsed.host.ends_with(".onion") {
        let stream = connect_onion_stream_with_retries(tor_client.clone(), &isolation_key, &parsed.host, parsed.port).await?;
        let request = url.clone().into_client_request().map_err(|e| e.to_string())?;
        let (ws, _) = client_async(request, stream).await.map_err(|e| format!("onion websocket handshake failed: {e}"))?;
        run_send_envelope_ws(ws, frame, client_ref).await
    } else {
        if !parsed.is_local_dev_host() { return Err("direct WebSocket is only allowed for localhost development. Use a .onion server URL for real transport.".into()); }
        let (ws, _) = connect_async(&url).await.map_err(|e| format!("websocket connect failed: {e}"))?;
        run_send_envelope_ws(ws, frame, client_ref).await
    }
}

async fn run_send_envelope_ws<S>(
    mut ws: WebSocketStream<S>,
    frame: ClientFrame,
    client_ref: String,
) -> Result<SendEnvelopeAck, String>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    send_frame(&mut ws, frame).await?;
    let response = timeout(Duration::from_secs(15), ws.next()).await.map_err(|_| "timed out waiting for relay send acknowledgement".to_string())?;
    let Some(response) = response else { return Err("relay closed before send acknowledgement".to_string()); };
    let msg = response.map_err(|e| format!("websocket read failed: {e}"))?;
    let Message::Text(text) = msg else { return Err("unexpected non-text relay response to send".to_string()); };
    match serde_json::from_str::<ServerFrame>(&text).map_err(|e| format!("bad relay send response: {e}"))? {
        ServerFrame::SendOk { id, queued, client_ref: response_ref } => {
            if response_ref.as_deref() != Some(client_ref.as_str()) {
                return Err("relay send acknowledgement did not match request".to_string());
            }
            Ok(SendEnvelopeAck { id, queued, client_ref: response_ref })
        }
        ServerFrame::SendError { code, message, .. } => Err(format!("{code}: {message}")),
        ServerFrame::Error { code, message } => Err(format!("{code}: {message}")),
        _ => Err("unexpected relay response to send".to_string()),
    }
}

pub async fn request_sender_certificate(
    state: &TransportState,
    server_id: String,
    sender_uuid: String,
    sender_device_id: u32,
    sender_cert_public_b64: String,
) -> Result<SenderCertificateResponse, String> {
    validate_recipient_id(&sender_uuid)?;
    if sender_device_id == 0 || sender_device_id > 127 { return Err("invalid sender device id".into()); }
    if sender_cert_public_b64.len() > 64 { return Err("sender certificate public key is too large".into()); }
    let cache_key = format!("{}|{}|{}|{}", server_id, sender_uuid, sender_device_id, sender_cert_public_b64);
    if let Some(cached) = state.sender_cert_cache.lock().await.get(&cache_key).cloned() {
        if cached.expires_at_ms > now_ms().saturating_add(60 * 60 * 1000) {
            return Ok(cached);
        }
    }
    let request_id = Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    state.pending_sender_certs.lock().await.insert(request_id.clone(), tx);

    let send_result = {
        let guard = state.connections.lock().await;
        match guard.get(&server_id) {
            Some(conn) => conn.outbound.try_send(ClientFrame::IssueSenderCertificate { request_id: request_id.clone(), sender_uuid, sender_device_id, sender_cert_public_b64 })
                .map_err(|e| format!("server connection is not accepting certificate requests: {e}")),
            None => Err("server is not connected".to_string()),
        }
    };

    if let Err(e) = send_result {
        state.pending_sender_certs.lock().await.remove(&request_id);
        return Err(e);
    }

    match timeout(Duration::from_secs(10), rx).await {
        Ok(Ok(response)) => {
            let mut cache = state.sender_cert_cache.lock().await;
            // Evict expired certificates and cap cache size to prevent
            // unbounded growth from route rotations.
            let now = now_ms();
            cache.retain(|_, cert| cert.expires_at_ms > now);
            const MAX_CERT_CACHE: usize = 256;
            if cache.len() >= MAX_CERT_CACHE {
                // Remove oldest by expiry
                if let Some(oldest_key) = cache.iter()
                    .min_by_key(|(_, v)| v.expires_at_ms)
                    .map(|(k, _)| k.clone())
                {
                    cache.remove(&oldest_key);
                }
            }
            cache.insert(cache_key, response.clone());
            Ok(response)
        },
        Ok(Err(_)) => {
            state.pending_sender_certs.lock().await.remove(&request_id);
            Err("sender certificate response channel closed".to_string())
        }
        Err(_) => {
            state.pending_sender_certs.lock().await.remove(&request_id);
            Err("timed out waiting for sender certificate".to_string())
        }
    }
}


pub async fn request_sender_certificate_once(
    tor_client: Arc<Mutex<Option<TorClient<PreferredRuntime>>>>,
    url: String,
    sender_uuid: String,
    auth_token: String,
    delivery_token: String,
    sender_device_id: u32,
    sender_cert_public_b64: String,
) -> Result<SenderCertificateResponse, String> {
    validate_ws_url(&url)?;
    validate_recipient_id(&sender_uuid)?;
    validate_token(&auth_token, "auth token")?;
    validate_token(&delivery_token, "delivery token")?;
    if sender_device_id == 0 || sender_device_id > 127 { return Err("invalid sender device id".into()); }
    if sender_cert_public_b64.len() > 64 { return Err("sender certificate public key is too large".into()); }

    let parsed = parse_ws_url(&url)?;
    if parsed.host.ends_with(".onion") {
        let stream = connect_onion_stream_with_retries(tor_client.clone(), &sender_uuid, &parsed.host, parsed.port).await?;
        let request = url.clone().into_client_request().map_err(|e| e.to_string())?;
        let (ws, _) = client_async(request, stream).await.map_err(|e| format!("onion websocket handshake failed: {e}"))?;
        run_sender_certificate_once_ws(ws, sender_uuid, auth_token, delivery_token, sender_device_id, sender_cert_public_b64).await
    } else {
        if !parsed.is_local_dev_host() { return Err("direct WebSocket is only allowed for localhost development. Use a .onion server URL for real transport.".into()); }
        let (ws, _) = connect_async(&url).await.map_err(|e| format!("websocket connect failed: {e}"))?;
        run_sender_certificate_once_ws(ws, sender_uuid, auth_token, delivery_token, sender_device_id, sender_cert_public_b64).await
    }
}

async fn run_sender_certificate_once_ws<S>(
    mut ws: WebSocketStream<S>,
    sender_uuid: String,
    auth_token: String,
    delivery_token: String,
    sender_device_id: u32,
    sender_cert_public_b64: String,
) -> Result<SenderCertificateResponse, String>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    send_frame(&mut ws, ClientFrame::Hello {
        recipient_id: sender_uuid.clone(),
        auth_token,
        delivery_token,
        protocol_min: PROTOCOL_MIN_SUPPORTED,
        protocol_max: PROTOCOL_VERSION,
        pow: Some(generate_pow(&sender_uuid).await),
        cert_only: true,
    }).await?;

    let response = timeout(Duration::from_secs(15), ws.next()).await.map_err(|_| "timed out waiting for sender-certificate hello".to_string())?;
    let Some(response) = response else { return Err("relay closed before sender-certificate hello".to_string()); };
    let message = response.map_err(|e| format!("websocket read failed: {e}"))?;
    let Message::Text(text) = message else { return Err("unexpected non-text relay response".to_string()); };
    match serde_json::from_str::<ServerFrame>(&text).map_err(|e| format!("bad server frame: {e}"))? {
        ServerFrame::HelloOk { .. } => {}
        ServerFrame::Error { code, message } => return Err(format!("{code}: {message}")),
        _ => return Err("unexpected relay response to sender-certificate hello".to_string()),
    }

    let request_id = Uuid::new_v4().to_string();
    send_frame(&mut ws, ClientFrame::IssueSenderCertificate {
        request_id: request_id.clone(),
        sender_uuid,
        sender_device_id,
        sender_cert_public_b64,
    }).await?;

    let response = timeout(Duration::from_secs(15), ws.next()).await.map_err(|_| "timed out waiting for sender certificate".to_string())?;
    let Some(response) = response else { return Err("relay closed before sender certificate".to_string()); };
    let message = response.map_err(|e| format!("websocket read failed: {e}"))?;
    let Message::Text(text) = message else { return Err("unexpected non-text relay response".to_string()); };
    match sender_certificate_response_from_frame(&text, &request_id)? {
        CertificateReadResult::Matched(response) => Ok(response),
        CertificateReadResult::KeepReading => {
            let deadline = Instant::now() + Duration::from_secs(15);
            loop {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Err("timed out waiting for sender certificate".to_string());
                }
                let response = timeout(remaining, ws.next()).await.map_err(|_| "timed out waiting for sender certificate".to_string())?;
                let Some(response) = response else { return Err("relay closed before sender certificate".to_string()); };
                let message = response.map_err(|e| format!("websocket read failed: {e}"))?;
                let Message::Text(text) = message else { continue; };
                if let CertificateReadResult::Matched(response) = sender_certificate_response_from_frame(&text, &request_id)? {
                    return Ok(response);
                }
            }
        }
    }
}

enum CertificateReadResult {
    Matched(SenderCertificateResponse),
    KeepReading,
}

fn sender_certificate_response_from_frame(text: &str, request_id: &str) -> Result<CertificateReadResult, String> {
    match serde_json::from_str::<ServerFrame>(text).map_err(|e| format!("bad server frame: {e}"))? {
        ServerFrame::SenderCertificate { request_id: got_request, certificate_b64, trust_root_b64, expires_at_ms } if got_request == request_id => {
            Ok(CertificateReadResult::Matched(SenderCertificateResponse { certificate_b64, trust_root_b64, expires_at_ms }))
        }
        ServerFrame::SenderCertificate { .. } => Ok(CertificateReadResult::KeepReading),
        ServerFrame::Envelope { .. } => Ok(CertificateReadResult::KeepReading),
        ServerFrame::AckOk { .. } | ServerFrame::Pong { .. } => Ok(CertificateReadResult::KeepReading),
        ServerFrame::Error { code, message } => Err(format!("{code}: {message}")),
        ServerFrame::SendError { code, message, .. } => Err(format!("{code}: {message}")),
        _ => Err("unexpected relay response to sender-certificate request".to_string()),
    }
}

pub async fn upload_invite_bundle(
    tor_client: Arc<Mutex<Option<TorClient<PreferredRuntime>>>>,
    url: String,
    bundle_id: String,
    ciphertext: String,
    expires_at_ms: u64,
) -> Result<(), String> {
    validate_ws_url(&url)?;
    validate_bundle_id(&bundle_id)?;
    if ciphertext.len() > 16 * 1024 { return Err("invite bundle exceeds relay limit".into()); }
    let request_id = Uuid::new_v4().to_string();
    let pow = Some(generate_pow(&bundle_id).await);
    let frame = ClientFrame::UploadBundle { request_id: request_id.clone(), bundle_id: bundle_id.clone(), ciphertext, expires_at_ms, pow };
    let parsed = parse_ws_url(&url)?;
    if parsed.host.ends_with(".onion") {
        let stream = connect_onion_stream_with_retries(tor_client.clone(), &bundle_id, &parsed.host, parsed.port).await?;
        let request = url.clone().into_client_request().map_err(|e| e.to_string())?;
        let (ws, _) = client_async(request, stream).await.map_err(|e| format!("onion websocket handshake failed: {e}"))?;
        run_upload_bundle_ws(ws, frame, request_id, bundle_id).await
    } else {
        if !parsed.is_local_dev_host() { return Err("direct WebSocket is only allowed for localhost development. Use a .onion server URL for real transport.".into()); }
        let (ws, _) = connect_async(&url).await.map_err(|e| format!("websocket connect failed: {e}"))?;
        run_upload_bundle_ws(ws, frame, request_id, bundle_id).await
    }
}

pub async fn fetch_invite_bundle(
    tor_client: Arc<Mutex<Option<TorClient<PreferredRuntime>>>>,
    url: String,
    bundle_id: String,
) -> Result<String, String> {
    validate_ws_url(&url)?;
    validate_bundle_id(&bundle_id)?;
    let request_id = Uuid::new_v4().to_string();
    let frame = ClientFrame::FetchBundle { request_id: request_id.clone(), bundle_id: bundle_id.clone() };
    let parsed = parse_ws_url(&url)?;
    if parsed.host.ends_with(".onion") {
        let stream = connect_onion_stream_with_retries(tor_client.clone(), &bundle_id, &parsed.host, parsed.port).await?;
        let request = url.clone().into_client_request().map_err(|e| e.to_string())?;
        let (ws, _) = client_async(request, stream).await.map_err(|e| format!("onion websocket handshake failed: {e}"))?;
        run_fetch_bundle_ws(ws, frame, request_id, bundle_id).await
    } else {
        if !parsed.is_local_dev_host() { return Err("direct WebSocket is only allowed for localhost development. Use a .onion server URL for real transport.".into()); }
        let (ws, _) = connect_async(&url).await.map_err(|e| format!("websocket connect failed: {e}"))?;
        run_fetch_bundle_ws(ws, frame, request_id, bundle_id).await
    }
}

/// The operator-advertised per-file byte cap for a connected server, captured
/// from its HelloOk. `None` if the server is not connected or advertised no cap
/// (a pre-v7 relay).
pub async fn server_file_limit(state: &TransportState, server_id: &str) -> Option<u64> {
    state.server_file_limits.lock().await.get(server_id).copied()
}

/// Upload one already-encrypted chunk of a file transfer over the server's live
/// connection, awaiting the relay's ack. `chunk_index == 0` creates the transfer
/// and is proof-of-work gated (computed here); later chunks ride the existing
/// transfer. Returns `(received_chunks, total_chunks)` so the caller can report
/// progress and detect completion.
pub async fn upload_file_chunk(
    state: &TransportState,
    server_id: &str,
    transfer_id: String,
    chunk_index: u32,
    total_chunks: u32,
    total_bytes: u64,
    ciphertext_b64: String,
) -> Result<(u32, u32), String> {
    validate_bundle_id(&transfer_id)?;
    if ciphertext_b64.len() > 512 * 1024 { return Err("file chunk exceeds 512 KiB frame limit".into()); }
    // The first chunk creates the transfer and must carry proof-of-work, computed
    // here (off the caller) to match the relay's gate. Later chunks need none.
    let pow = if chunk_index == 0 { Some(generate_pow(&transfer_id).await) } else { None };
    let reply = file_request(state, server_id, |request_id| ClientFrame::UploadFileChunk {
        request_id,
        transfer_id,
        chunk_index,
        total_chunks,
        total_bytes,
        ciphertext: ciphertext_b64,
        pow,
    }).await?;
    match reply {
        FileOpReply::ChunkStored { received_chunks, total_chunks } => Ok((received_chunks, total_chunks)),
        FileOpReply::Error { code, message } => Err(format!("{code}: {message}")),
        _ => Err("unexpected relay reply to file chunk upload".into()),
    }
}

/// Fetch one chunk of a transfer over the server's live connection. Returns the
/// chunk ciphertext (base64) and the transfer's declared shape.
pub async fn fetch_file_chunk(
    state: &TransportState,
    server_id: &str,
    transfer_id: String,
    chunk_index: u32,
) -> Result<(String, u32, u64), String> {
    validate_bundle_id(&transfer_id)?;
    let reply = file_request(state, server_id, |request_id| ClientFrame::FetchFileChunk { request_id, transfer_id, chunk_index }).await?;
    match reply {
        FileOpReply::Chunk { total_chunks, total_bytes, ciphertext } => Ok((ciphertext, total_chunks, total_bytes)),
        FileOpReply::Error { code, message } => Err(format!("{code}: {message}")),
        _ => Err("unexpected relay reply to file chunk fetch".into()),
    }
}

/// Delete a whole transfer over the server's live connection (idempotent).
pub async fn delete_transfer(
    state: &TransportState,
    server_id: &str,
    transfer_id: String,
) -> Result<(), String> {
    validate_bundle_id(&transfer_id)?;
    let reply = file_request(state, server_id, |request_id| ClientFrame::DeleteTransfer { request_id, transfer_id }).await?;
    match reply {
        FileOpReply::Deleted => Ok(()),
        FileOpReply::Error { code, message } => Err(format!("{code}: {message}")),
        _ => Err("unexpected relay reply to transfer delete".into()),
    }
}

/// Send one file-transfer frame on a server's existing connection and await its
/// reply, correlated by a freshly minted request id. `build` stamps that id into
/// the frame. Shared by the upload, fetch, and delete helpers above.
async fn file_request(
    state: &TransportState,
    server_id: &str,
    build: impl FnOnce(String) -> ClientFrame,
) -> Result<FileOpReply, String> {
    let request_id = Uuid::new_v4().to_string();
    let frame = build(request_id.clone());

    let (tx, rx) = oneshot::channel();
    state.pending_files.lock().await.insert(request_id.clone(), tx);

    let send_result = {
        let guard = state.connections.lock().await;
        match guard.get(server_id) {
            Some(conn) => conn.outbound.try_send(frame)
                .map_err(|e| format!("server connection is not accepting frames; reconnect and try again: {e}")),
            None => Err("server is not connected".to_string()),
        }
    };
    if let Err(e) = send_result {
        state.pending_files.lock().await.remove(&request_id);
        return Err(e);
    }

    // Generous per-chunk budget: a 256 KiB chunk round-trip over a Tor circuit
    // can be slow, especially right after the circuit is built.
    match timeout(Duration::from_secs(90), rx).await {
        Ok(Ok(reply)) => Ok(reply),
        Ok(Err(_)) => {
            state.pending_files.lock().await.remove(&request_id);
            Err("file transfer reply channel closed".to_string())
        }
        Err(_) => {
            state.pending_files.lock().await.remove(&request_id);
            Err("timed out waiting for relay file transfer reply".to_string())
        }
    }
}

/// One downloaded chunk, still E2E-encrypted (base64, exactly as it sat on the
/// relay). The caller decrypts and reassembles. `total_bytes` is the relay's
/// declared size for the whole transfer, repeated on every chunk for a cheap
/// consistency check.
pub struct DownloadedChunk {
    pub chunk_index: u32,
    pub total_bytes: u64,
    pub ciphertext_b64: String,
}

/// Download every chunk of `transfer_id` from `url` over a single WebSocket, so
/// the whole transfer rides one warm Tor circuit instead of rebuilding one per
/// chunk. Fetching needs no `Hello`, so this reaches any relay — including one
/// where we hold no mailbox, which is the normal case since a file lives on the
/// sender's relay, not the downloader's. Chunks are pushed in order to the
/// returned receiver; the first `Err` ends the stream. The caller decrypts,
/// reassembles, writes to disk, and reports progress.
pub async fn download_transfer(
    tor_client: Arc<Mutex<Option<TorClient<PreferredRuntime>>>>,
    url: String,
    transfer_id: String,
    total_chunks: u32,
) -> Result<mpsc::Receiver<Result<DownloadedChunk, String>>, String> {
    validate_ws_url(&url)?;
    validate_bundle_id(&transfer_id)?;
    if total_chunks == 0 { return Err("transfer declares no chunks".into()); }
    let parsed = parse_ws_url(&url)?;
    // A small buffer lets the network task stay a chunk or two ahead of the
    // decrypt/write consumer without unbounded memory growth.
    let (tx, rx) = mpsc::channel(4);
    if parsed.host.ends_with(".onion") {
        let stream = connect_onion_stream_with_retries(tor_client.clone(), &transfer_id, &parsed.host, parsed.port).await?;
        let request = url.clone().into_client_request().map_err(|e| e.to_string())?;
        let (ws, _) = client_async(request, stream).await.map_err(|e| format!("onion websocket handshake failed: {e}"))?;
        tokio::spawn(run_download_transfer_ws(ws, transfer_id, total_chunks, tx));
    } else {
        if !parsed.is_local_dev_host() { return Err("direct WebSocket is only allowed for localhost development. Use a .onion server URL for real transport.".into()); }
        let (ws, _) = connect_async(&url).await.map_err(|e| format!("websocket connect failed: {e}"))?;
        tokio::spawn(run_download_transfer_ws(ws, transfer_id, total_chunks, tx));
    }
    Ok(rx)
}

async fn run_download_transfer_ws<S>(
    mut ws: WebSocketStream<S>,
    transfer_id: String,
    total_chunks: u32,
    tx: mpsc::Sender<Result<DownloadedChunk, String>>,
) where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    for chunk_index in 0..total_chunks {
        let request_id = Uuid::new_v4().to_string();
        let frame = ClientFrame::FetchFileChunk { request_id: request_id.clone(), transfer_id: transfer_id.clone(), chunk_index };
        if let Err(e) = send_frame(&mut ws, frame).await {
            let _ = tx.send(Err(e)).await;
            return;
        }
        let result = loop {
            let response = match timeout(Duration::from_secs(90), ws.next()).await {
                Ok(r) => r,
                Err(_) => break Err("timed out waiting for file chunk".to_string()),
            };
            let Some(response) = response else { break Err("relay closed during file download".to_string()); };
            let message = match response {
                Ok(m) => m,
                Err(e) => break Err(format!("websocket read failed: {e}")),
            };
            let text = match message {
                Message::Text(t) => t,
                Message::Close(_) => break Err("relay closed during file download".to_string()),
                _ => continue, // ignore pings/pongs/binary and keep waiting
            };
            match serde_json::from_str::<ServerFrame>(&text) {
                Ok(ServerFrame::FileChunk { request_id: got, chunk_index: got_idx, total_bytes, ciphertext, .. })
                    if got == request_id && got_idx == chunk_index =>
                {
                    break Ok(DownloadedChunk { chunk_index, total_bytes, ciphertext_b64: ciphertext });
                }
                Ok(ServerFrame::FileError { code, message, .. }) => break Err(format!("{code}: {message}")),
                Ok(_) => continue, // unrelated frame on this socket; keep reading
                Err(e) => break Err(format!("bad server frame: {e}")),
            }
        };
        let is_err = result.is_err();
        if tx.send(result).await.is_err() { return; } // consumer dropped (cancelled)
        if is_err { return; }
    }
    let _ = ws.close(None).await;
}

pub async fn retire_mailbox_once(
    tor_client: Arc<Mutex<Option<TorClient<PreferredRuntime>>>>,
    url: String,
    recipient_id: String,
    auth_token: String,
    delivery_token: String,
) -> Result<(), String> {
    validate_ws_url(&url)?;
    validate_recipient_id(&recipient_id)?;
    validate_token(&auth_token, "auth token")?;
    validate_token(&delivery_token, "delivery token")?;
    let parsed = parse_ws_url(&url)?;
    if parsed.host.ends_with(".onion") {
        let stream = connect_onion_stream_with_retries(tor_client.clone(), &recipient_id, &parsed.host, parsed.port).await?;
        let request = url.clone().into_client_request().map_err(|e| e.to_string())?;
        let (ws, _) = client_async(request, stream).await.map_err(|e| format!("onion websocket handshake failed: {e}"))?;
        run_retire_mailbox_ws(ws, recipient_id, auth_token, delivery_token).await
    } else {
        if !parsed.is_local_dev_host() { return Err("direct WebSocket is only allowed for localhost development. Use a .onion server URL for real transport.".into()); }
        let (ws, _) = connect_async(&url).await.map_err(|e| format!("websocket connect failed: {e}"))?;
        run_retire_mailbox_ws(ws, recipient_id, auth_token, delivery_token).await
    }
}

async fn run_upload_bundle_ws<S>(
    mut ws: WebSocketStream<S>,
    frame: ClientFrame,
    request_id: String,
    bundle_id: String,
) -> Result<(), String>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    send_frame(&mut ws, frame).await?;
    let response = timeout(Duration::from_secs(15), ws.next()).await.map_err(|_| "timed out waiting for invite bundle upload ack".to_string())?;
    let Some(response) = response else { return Err("relay closed before invite bundle upload ack".to_string()); };
    let message = response.map_err(|e| format!("websocket read failed: {e}"))?;
    let Message::Text(text) = message else { return Err("unexpected non-text relay response".to_string()); };
    match serde_json::from_str::<ServerFrame>(&text).map_err(|e| format!("bad server frame: {e}"))? {
        ServerFrame::BundleUploaded { request_id: got_request, bundle_id: got_bundle, .. } if got_request == request_id && got_bundle == bundle_id => Ok(()),
        ServerFrame::Error { code, message } => Err(format!("{code}: {message}")),
        _ => Err("unexpected relay response to invite bundle upload".to_string()),
    }
}

async fn run_fetch_bundle_ws<S>(
    mut ws: WebSocketStream<S>,
    frame: ClientFrame,
    request_id: String,
    bundle_id: String,
) -> Result<String, String>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    send_frame(&mut ws, frame).await?;
    let response = timeout(Duration::from_secs(15), ws.next()).await.map_err(|_| "timed out waiting for invite bundle".to_string())?;
    let Some(response) = response else { return Err("relay closed before returning invite bundle".to_string()); };
    let message = response.map_err(|e| format!("websocket read failed: {e}"))?;
    let Message::Text(text) = message else { return Err("unexpected non-text relay response".to_string()); };
    match serde_json::from_str::<ServerFrame>(&text).map_err(|e| format!("bad server frame: {e}"))? {
        ServerFrame::Bundle { request_id: got_request, bundle_id: got_bundle, ciphertext, .. } if got_request == request_id && got_bundle == bundle_id => Ok(ciphertext),
        ServerFrame::Error { code, message } => Err(format!("{code}: {message}")),
        _ => Err("unexpected relay response to invite bundle fetch".to_string()),
    }
}

async fn run_retire_mailbox_ws<S>(
    mut ws: WebSocketStream<S>,
    recipient_id: String,
    auth_token: String,
    delivery_token: String,
) -> Result<(), String>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    send_frame(&mut ws, ClientFrame::Hello {
        recipient_id: recipient_id.clone(),
        auth_token,
        delivery_token,
        protocol_min: PROTOCOL_MIN_SUPPORTED,
        protocol_max: PROTOCOL_VERSION,
        pow: Some(generate_pow(&recipient_id).await),
        cert_only: false,
    }).await?;

    let response = timeout(Duration::from_secs(15), ws.next()).await.map_err(|_| "timed out waiting for mailbox-retire hello".to_string())?;
    let Some(response) = response else { return Err("relay closed before mailbox-retire hello".to_string()); };
    let message = response.map_err(|e| format!("websocket read failed: {e}"))?;
    let Message::Text(text) = message else { return Err("unexpected non-text relay response".to_string()); };
    match serde_json::from_str::<ServerFrame>(&text).map_err(|e| format!("bad server frame: {e}"))? {
        ServerFrame::HelloOk { .. } => {}
        ServerFrame::Error { code, message } => return Err(format!("{code}: {message}")),
        _ => return Err("unexpected relay response to mailbox-retire hello".to_string()),
    }

    send_frame(&mut ws, ClientFrame::RetireMailbox).await?;
    let response = timeout(Duration::from_secs(15), ws.next()).await.map_err(|_| "timed out waiting for mailbox-retire ack".to_string())?;
    let Some(response) = response else { return Err("relay closed before mailbox-retire ack".to_string()); };
    let message = response.map_err(|e| format!("websocket read failed: {e}"))?;
    let Message::Text(text) = message else { return Err("unexpected non-text relay response".to_string()); };
    match serde_json::from_str::<ServerFrame>(&text).map_err(|e| format!("bad server frame: {e}"))? {
        ServerFrame::AckOk { .. } => Ok(()),
        ServerFrame::Error { code, message } => Err(format!("{code}: {message}")),
        _ => Err("unexpected relay response to mailbox-retire".to_string()),
    }
}

pub async fn get_server_trust_root(
    state: &TransportState,
    server_id: String,
) -> Result<Option<String>, String> {
    Ok(state.server_trust_roots.lock().await.get(&server_id).cloned())
}

pub async fn ack_envelopes(
    state: &TransportState,
    server_id: String,
    ids: Vec<Uuid>,
) -> Result<(), String> {
    let guard = state.connections.lock().await;
    let conn = guard.get(&server_id).ok_or_else(|| "server is not connected".to_string())?;
    conn.outbound.try_send(ClientFrame::Ack { ids }).map_err(|e| format!("server connection is not accepting ACKs; reconnect and try again: {e}"))
}

pub async fn retire_mailbox(
    state: &TransportState,
    server_id: String,
) -> Result<(), String> {
    let conn = {
        let guard = state.connections.lock().await;
        guard.get(&server_id).map(|c| c.outbound.clone())
    };
    if let Some(outbound) = conn {
        let _ = outbound.try_send(ClientFrame::RetireMailbox);
    }
    state.connections.lock().await.remove(&server_id);
    Ok(())
}

pub async fn list_connections(state: &TransportState) -> Result<Vec<(String, String, String)>, String> {
    let guard = state.connections.lock().await;
    Ok(guard.iter().map(|(id, c)| (id.clone(), c.url.clone(), c.recipient_id.clone())).collect())
}

async fn run_connection(
    app: AppHandle,
    tor_client: Arc<Mutex<Option<TorClient<PreferredRuntime>>>>,
    pending_certs: Arc<Mutex<HashMap<String, oneshot::Sender<SenderCertificateResponse>>>>,
    pending_token_updates: Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>,
    pending_sends: Arc<Mutex<HashMap<String, oneshot::Sender<Result<SendEnvelopeAck, String>>>>>,
    pending_files: Arc<Mutex<HashMap<String, oneshot::Sender<FileOpReply>>>>,
    server_file_limits: Arc<Mutex<HashMap<String, u64>>>,
    server_trust_roots: Arc<Mutex<HashMap<String, String>>>,
    syncing_conns: Arc<Mutex<HashSet<String>>>,
    server_id: String,
    url: String,
    recipient_id: String,
    auth_token: String,
    delivery_token: String,
    outbound_rx: mpsc::Receiver<ClientFrame>,
    shutdown: Arc<Notify>,
    ready_tx: Option<oneshot::Sender<Result<(), String>>>,
) -> Result<(), String> {
    let parsed = parse_ws_url(&url)?;

    if parsed.host.ends_with(".onion") {
        if parsed.scheme != "ws" {
            return Err("onion WebSocket URLs must use ws:// because Tor already provides the transport privacy; wss:// onion TLS is not implemented yet".into());
        }
        let stream = connect_onion_stream_with_retries(tor_client.clone(), &recipient_id, &parsed.host, parsed.port).await?;
        let request = url.clone().into_client_request().map_err(|e| e.to_string())?;
        let (ws, _) = client_async(request, stream)
            .await
            .map_err(|e| format!("onion websocket handshake failed: {e}"))?;
        run_websocket(app, pending_certs, pending_token_updates, pending_sends, pending_files, server_file_limits, server_trust_roots, syncing_conns, server_id, recipient_id, auth_token, delivery_token, outbound_rx, shutdown, ws, ready_tx).await
    } else {
        if !parsed.is_local_dev_host() {
            return Err("direct WebSocket is only allowed for localhost development. Use a .onion server URL for real transport.".into());
        }
        let (ws, _) = connect_async(&url).await.map_err(|e| format!("websocket connect failed: {e}"))?;
        run_websocket(app, pending_certs, pending_token_updates, pending_sends, pending_files, server_file_limits, server_trust_roots, syncing_conns, server_id, recipient_id, auth_token, delivery_token, outbound_rx, shutdown, ws, ready_tx).await
    }
}

async fn run_websocket<S>(
    app: AppHandle,
    pending_certs: Arc<Mutex<HashMap<String, oneshot::Sender<SenderCertificateResponse>>>>,
    pending_token_updates: Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>,
    pending_sends: Arc<Mutex<HashMap<String, oneshot::Sender<Result<SendEnvelopeAck, String>>>>>,
    pending_files: Arc<Mutex<HashMap<String, oneshot::Sender<FileOpReply>>>>,
    server_file_limits: Arc<Mutex<HashMap<String, u64>>>,
    server_trust_roots: Arc<Mutex<HashMap<String, String>>>,
    syncing_conns: Arc<Mutex<HashSet<String>>>,
    server_id: String,
    recipient_id: String,
    auth_token: String,
    delivery_token: String,
    mut outbound_rx: mpsc::Receiver<ClientFrame>,
    shutdown: Arc<Notify>,
    ws: WebSocketStream<S>,
    mut ready_tx: Option<oneshot::Sender<Result<(), String>>>,
) -> Result<(), String>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (mut write, mut read) = ws.split();

    send_frame(&mut write, ClientFrame::Hello {
        recipient_id: recipient_id.clone(),
        auth_token,
        delivery_token,
        protocol_min: PROTOCOL_MIN_SUPPORTED,
        protocol_max: PROTOCOL_VERSION,
        pow: Some(generate_pow(&recipient_id).await),
        cert_only: false,
    }).await?;
    let _ = emit_status(&app, &server_id, "connected", None);

    let writer_server_id = server_id.clone();
    let writer_app = app.clone();
    let writer = tokio::spawn(async move {
        let mut keepalive = tokio::time::interval(KEEPALIVE_INTERVAL);
        // The first tick fires immediately; consume it so the keepalive does not
        // emit a Ping the moment the socket opens. Delay missed ticks instead of
        // bursting them if a large frame ever holds up the writer.
        keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        keepalive.tick().await;
        loop {
            let frame = tokio::select! {
                maybe_frame = outbound_rx.recv() => match maybe_frame {
                    Some(frame) => frame,
                    None => break,
                },
                _ = keepalive.tick() => ClientFrame::Ping,
            };
            let send_ref = match &frame {
                ClientFrame::SendEnvelope { client_ref, .. } => client_ref.clone(),
                _ => None,
            };
            if let Err(e) = send_frame(&mut write, frame).await {
                if send_ref.is_some() {
                    let _ = writer_app.emit("axeno-send-failed", SendFailure {
                        server_id: writer_server_id.clone(),
                        client_ref: send_ref,
                        code: "websocket_write_failed".to_string(),
                        message: e.clone(),
                    });
                }
                let _ = emit_status(&writer_app, &writer_server_id, "failed", Some(e));
                break;
            }
        }
    });

    // Fallback that clears this connection's syncing flag if the relay never
    // sends `Synced` (a pre-v6 relay). Armed at HelloOk, aborted by `Synced` or
    // when the connection ends so a stale timer can't clear a later reconnect.
    let mut sync_fallback: Option<tokio::task::JoinHandle<()>> = None;

    loop {
        let next = tokio::select! {
            biased;
            // Graceful close requested (staggered app shutdown). Break so the
            // stream is dropped below, closing the Tor stream now — the relay
            // sees this mailbox go offline at its own staggered time.
            _ = shutdown.notified() => break,
            msg = read.next() => msg,
        };
        let Some(message) = next else { break; };
        let message = match message {
            Ok(m) => m,
            Err(e) => {
                if let Some(h) = sync_fallback.take() { h.abort(); }
                return Err(format!("websocket read failed: {e}"));
            }
        };
        let Message::Text(text) = message else { continue; };
        let frame: ServerFrame = serde_json::from_str(&text).map_err(|e| format!("bad server frame: {e}"))?;
        match frame {
            ServerFrame::HelloOk { protocol_version, trust_root_b64, server_time_ms, min_supported, current_protocol, max_file_bytes } => {
                if let Some(limit) = max_file_bytes {
                    server_file_limits.lock().await.insert(server_id.clone(), limit);
                }
                let local_time = now_ms();
                let skew = if server_time_ms > local_time { server_time_ms - local_time } else { local_time - server_time_ms };
                if skew > 5 * 60 * 1000 {
                    let minutes = skew / 60_000;
                    let _ = emit_status(&app, &server_id, "clock_skew", Some(format!("local clock differs from relay by about {minutes} minutes")));
                }
                let server_min = min_supported.unwrap_or(protocol_version);
                let server_max = current_protocol.unwrap_or(protocol_version);
                if protocol_version < PROTOCOL_MIN_SUPPORTED || protocol_version > PROTOCOL_VERSION || protocol_version < server_min || protocol_version > server_max {
                    return Err(format!("relay protocol mismatch: client supports {PROTOCOL_MIN_SUPPORTED}-{PROTOCOL_VERSION}, relay selected {protocol_version}"));
                }
                let mut roots = server_trust_roots.lock().await;
                if let Some(existing) = roots.get(&server_id) {
                    if existing != &trust_root_b64 {
                        return Err("relay trust root changed during this session".to_string());
                    }
                }
                roots.insert(server_id.clone(), trust_root_b64);
                drop(roots);
                if let Some(tx) = ready_tx.take() { let _ = tx.send(Ok(())); }
                let _ = emit_status(&app, &server_id, "ready", None);
                // Arm the pre-v6 fallback. A v6 relay's `Synced` aborts it.
                if sync_fallback.is_none() {
                    let fb_app = app.clone();
                    let fb_syncing = syncing_conns.clone();
                    let fb_id = server_id.clone();
                    sync_fallback = Some(tokio::spawn(async move {
                        sleep(SYNC_FALLBACK_AFTER_HELLO).await;
                        set_conn_syncing(&fb_app, &fb_syncing, &fb_id, false).await;
                    }));
                }
            }
            ServerFrame::SenderCertificate { request_id, certificate_b64, trust_root_b64, expires_at_ms } => {
                let mut roots = server_trust_roots.lock().await;
                if let Some(existing) = roots.get(&server_id) {
                    if existing != &trust_root_b64 {
                        return Err("relay trust root changed during sender-certificate issuance".to_string());
                    }
                }
                roots.insert(server_id.clone(), trust_root_b64.clone());
                drop(roots);
                if let Some(tx) = pending_certs.lock().await.remove(&request_id) {
                    let _ = tx.send(SenderCertificateResponse { certificate_b64, trust_root_b64, expires_at_ms });
                }
            }
            ServerFrame::Envelope { envelope } => {
                // Process the envelope directly in the Rust backend instead of
                // round-tripping through the webview. This eliminates the attack
                // surface where a compromised webview could inject fake envelopes
                // via the Tauri invoke handler.
                //
                // Note: handle_incoming_envelope uses non-Send libsignal futures,
                // so we isolate it on a blocking thread with its own runtime,
                // matching the pattern used by the Tauri command handler.
                let app_clone = app.clone();
                let server_id_clone = server_id.clone();
                tokio::task::spawn_blocking(move || {
                    let session = app_clone.state::<crate::AppSessionState>();
                    let runtime = app_clone.state::<crate::messaging::MessagingRuntimeState>();
                    let ts = app_clone.state::<TransportState>();
                    let tor_state = app_clone.state::<crate::AppTorState>();
                    let result = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                        .map_err(|e| format!("envelope worker runtime failed: {e}"))
                        .and_then(|rt| {
                            rt.block_on(crate::messaging::handle_incoming_envelope(
                                app_clone.clone(),
                                &session,
                                &runtime,
                                &ts,
                                tor_state.client.clone(),
                                server_id_clone.clone(),
                                envelope.clone(),
                            ))
                        });
                    if let Err(e) = result {
                        eprintln!("[axeno] failed to handle incoming envelope on {}: {}", server_id_clone, e);
                    }
                });
            }
            ServerFrame::Synced { .. } => {
                // The offline backlog for this mailbox is fully delivered.
                if let Some(h) = sync_fallback.take() { h.abort(); }
                set_conn_syncing(&app, &syncing_conns, &server_id, false).await;
            }
            ServerFrame::SendOk { id, queued, client_ref } => {
                if let Some(ref reference) = client_ref {
                    if let Some(tx) = pending_sends.lock().await.remove(reference) {
                        let _ = tx.send(Ok(SendEnvelopeAck { id, queued, client_ref: client_ref.clone() }));
                    }
                }
                let _ = app.emit("axeno-send-receipt", SendReceipt { server_id: server_id.clone(), id, queued, client_ref });
            }
            ServerFrame::SendError { client_ref, code, message } => {
                if let Some(ref reference) = client_ref {
                    if let Some(tx) = pending_sends.lock().await.remove(reference) {
                        let _ = tx.send(Err(format!("{code}: {message}")));
                    }
                }
                let _ = app.emit("axeno-send-failed", SendFailure {
                    server_id: server_id.clone(),
                    client_ref: client_ref.clone(),
                    code: code.clone(),
                    message: message.clone(),
                });
                let _ = emit_status(&app, &server_id, "send_error", Some(format!("{code}: {message}")));
            }
            ServerFrame::DeliveryTokensSet { request_id, .. } => {
                if let Some(tx) = pending_token_updates.lock().await.remove(&request_id) {
                    let _ = tx.send(());
                }
            }
            ServerFrame::FileChunkStored { request_id, received_chunks, total_chunks, .. } => {
                if let Some(tx) = pending_files.lock().await.remove(&request_id) {
                    let _ = tx.send(FileOpReply::ChunkStored { received_chunks, total_chunks });
                }
            }
            ServerFrame::FileChunk { request_id, total_chunks, total_bytes, ciphertext, .. } => {
                if let Some(tx) = pending_files.lock().await.remove(&request_id) {
                    let _ = tx.send(FileOpReply::Chunk { total_chunks, total_bytes, ciphertext });
                }
            }
            ServerFrame::TransferDeleted { request_id, .. } => {
                if let Some(tx) = pending_files.lock().await.remove(&request_id) {
                    let _ = tx.send(FileOpReply::Deleted);
                }
            }
            ServerFrame::FileError { request_id, code, message, .. } => {
                if let Some(tx) = pending_files.lock().await.remove(&request_id) {
                    let _ = tx.send(FileOpReply::Error { code, message });
                }
            }
            ServerFrame::AckOk { .. } => {}
            ServerFrame::Pong { .. } => {}
            ServerFrame::BundleUploaded { .. } | ServerFrame::Bundle { .. } => {}
            ServerFrame::Unknown => {}
            ServerFrame::Error { code, message } => {
                if let Some(tx) = ready_tx.take() { let _ = tx.send(Err(format!("{code}: {message}"))); }
                let _ = emit_status(&app, &server_id, "server_error", Some(format!("{code}: {message}")));
            }
        }
    }

    // Connection ended; stop the fallback so it can't clear a later reconnect's
    // flag. The connect_server task clears this connection's syncing flag.
    if let Some(h) = sync_fallback.take() { h.abort(); }

    if let Some(tx) = ready_tx.take() { let _ = tx.send(Err("relay connection ended before registration completed".to_string())); }
    writer.abort();
    Ok(())
}

async fn send_frame<S>(write: &mut S, frame: ClientFrame) -> Result<(), String>
where
    S: Sink<Message> + Unpin,
    S::Error: std::fmt::Display,
{
    let text = serde_json::to_string(&frame).map_err(|e| e.to_string())?;
    write.send(Message::Text(text.into())).await.map_err(|e| e.to_string())
}

fn emit_status(app: &AppHandle, server_id: &str, status: &str, reason: Option<String>) -> Result<(), tauri::Error> {
    app.emit("axeno-server-status", TransportStatusEvent { server_id: server_id.to_string(), status: status.to_string(), reason })
}

/// Add or remove a connection from the "currently syncing" set and emit the
/// resulting global syncing state. Idempotent: marking a connection done that
/// is already absent (e.g. `Synced` then disconnect) is a no-op. The emitted
/// flag is simply whether the set is non-empty, so the frontend can mirror it.
async fn set_conn_syncing(app: &AppHandle, syncing_conns: &Arc<Mutex<HashSet<String>>>, conn_id: &str, syncing: bool) {
    let any = {
        let mut set = syncing_conns.lock().await;
        if syncing { set.insert(conn_id.to_string()); } else { set.remove(conn_id); }
        !set.is_empty()
    };
    let _ = app.emit("axeno-sync-status", SyncStatusEvent { syncing: any });
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

#[derive(Debug)]
struct ParsedWsUrl {
    scheme: String,
    host: String,
    port: u16,
}

impl ParsedWsUrl {
    fn is_local_dev_host(&self) -> bool {
        matches!(self.host.as_str(), "127.0.0.1" | "localhost" | "[::1]" | "::1")
    }
}

fn parse_ws_url(url: &str) -> Result<ParsedWsUrl, String> {
    let (scheme, rest) = if let Some(rest) = url.strip_prefix("ws://") {
        ("ws", rest)
    } else if let Some(rest) = url.strip_prefix("wss://") {
        ("wss", rest)
    } else {
        return Err("server URL must start with ws:// or wss://".into());
    };

    let authority = rest.split('/').next().unwrap_or_default();
    if authority.is_empty() { return Err("server URL is missing a host".into()); }

    let (host, port) = if authority.starts_with('[') {
        let end = authority.find(']').ok_or_else(|| "invalid IPv6 host".to_string())?;
        let host = authority[..=end].to_string();
        let port = authority[end + 1..]
            .strip_prefix(':')
            .and_then(|p| p.parse::<u16>().ok())
            .unwrap_or(if scheme == "wss" { 443 } else { 80 });
        (host, port)
    } else if let Some((host, port)) = authority.rsplit_once(':') {
        (host.to_string(), port.parse::<u16>().map_err(|_| "invalid server port".to_string())?)
    } else {
        (authority.to_string(), if scheme == "wss" { 443 } else { 80 })
    };

    Ok(ParsedWsUrl { scheme: scheme.to_string(), host, port })
}

fn validate_ws_url(url: &str) -> Result<(), String> {
    if url.starts_with("ws://") || url.starts_with("wss://") { Ok(()) } else { Err("server URL must start with ws:// or wss://".into()) }
}

fn validate_token(token: &str, label: &str) -> Result<(), String> {
    if (16..=128).contains(&token.len()) && token.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')) {
        Ok(())
    } else {
        Err(format!("{label} must be 16-128 URL-safe characters"))
    }
}

fn validate_recipient_id(id: &str) -> Result<(), String> {
    if id.starts_with("mbx_")
        && (16..=128).contains(&id.len())
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        Ok(())
    } else {
        Err("recipient id must start with mbx_ and be 16-128 URL-safe characters".into())
    }
}

/// Start a minimal SOCKS5 proxy on `127.0.0.1:<ephemeral>` backed by the Tor
/// client, returning the bound port. The in-app updater is pointed at this with
/// `socks5h://127.0.0.1:<port>` so its HTTPS requests to GitHub go through Tor.
///
/// Only the CONNECT command is supported, and with `socks5h` the client sends
/// hostnames (not pre-resolved IPs), so DNS is resolved over Tor too. No auth is
/// negotiated; the listener is loopback-only.
pub async fn start_socks_proxy(
    tor_client: Arc<Mutex<Option<TorClient<PreferredRuntime>>>>,
) -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| format!("SOCKS bind failed: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((sock, _)) => {
                    let tc = tor_client.clone();
                    tokio::spawn(async move { let _ = handle_socks_conn(sock, tc).await; });
                }
                Err(_) => continue,
            }
        }
    });
    Ok(port)
}

async fn handle_socks_conn(
    mut sock: TcpStream,
    tor_client: Arc<Mutex<Option<TorClient<PreferredRuntime>>>>,
) -> Result<(), String> {
    // Greeting: VER, NMETHODS, METHODS...
    let mut head = [0u8; 2];
    sock.read_exact(&mut head).await.map_err(|e| e.to_string())?;
    if head[0] != 0x05 { return Err("not SOCKS5".into()); }
    let mut methods = vec![0u8; head[1] as usize];
    sock.read_exact(&mut methods).await.map_err(|e| e.to_string())?;
    // Select "no authentication".
    sock.write_all(&[0x05, 0x00]).await.map_err(|e| e.to_string())?;

    // Request: VER, CMD, RSV, ATYP, ADDR, PORT.
    let mut req = [0u8; 4];
    sock.read_exact(&mut req).await.map_err(|e| e.to_string())?;
    if req[0] != 0x05 { return Err("bad SOCKS request".into()); }
    if req[1] != 0x01 {
        let _ = sock.write_all(&[0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await; // command not supported
        return Err("only CONNECT is supported".into());
    }
    let host = match req[3] {
        0x01 => { let mut a = [0u8; 4]; sock.read_exact(&mut a).await.map_err(|e| e.to_string())?; std::net::Ipv4Addr::from(a).to_string() }
        0x04 => { let mut a = [0u8; 16]; sock.read_exact(&mut a).await.map_err(|e| e.to_string())?; std::net::Ipv6Addr::from(a).to_string() }
        0x03 => {
            let mut len = [0u8; 1];
            sock.read_exact(&mut len).await.map_err(|e| e.to_string())?;
            let mut d = vec![0u8; len[0] as usize];
            sock.read_exact(&mut d).await.map_err(|e| e.to_string())?;
            String::from_utf8(d).map_err(|_| "bad domain".to_string())?
        }
        _ => { let _ = sock.write_all(&[0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await; return Err("bad address type".into()); }
    };
    let mut port_bytes = [0u8; 2];
    sock.read_exact(&mut port_bytes).await.map_err(|e| e.to_string())?;
    let port = u16::from_be_bytes(port_bytes);

    let client = tor_client.lock().await.clone().ok_or_else(|| "Tor is not ready".to_string())?;
    // Keep update traffic on its own circuit, separate from messaging mailboxes.
    let mut prefs = StreamPrefs::new();
    prefs.set_isolation(isolation_token_for("axeno-updater"));
    let mut stream = match client.connect_with_prefs((host.as_str(), port), &prefs).await {
        Ok(s) => s,
        Err(_) => { let _ = sock.write_all(&[0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await; return Err("Tor connect failed".into()); }
    };
    // Success, BND.ADDR 0.0.0.0:0.
    sock.write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await.map_err(|e| e.to_string())?;
    let _ = tokio::io::copy_bidirectional(&mut sock, &mut stream).await;
    Ok(())
}

fn validate_bundle_id(id: &str) -> Result<(), String> {
    if (16..=128).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')) {
        Ok(())
    } else {
        Err("invite bundle id must be 16-128 URL-safe characters".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sender_certificate_reader_skips_queued_envelopes() {
        let envelope = r#"{
            "type":"envelope",
            "envelope":{
                "id":"00000000-0000-0000-0000-000000000001",
                "to":"mbx_receiver_1234567890",
                "envelope_type":"axeno_sealed_signal_v1",
                "ciphertext":"{}"
            }
        }"#;

        match sender_certificate_response_from_frame(envelope, "req-1").unwrap() {
            CertificateReadResult::KeepReading => {}
            CertificateReadResult::Matched(_) => panic!("queued envelope must not satisfy certificate request"),
        }
    }

    #[test]
    fn sender_certificate_reader_accepts_matching_certificate() {
        let certificate = r#"{
            "type":"sender_certificate",
            "request_id":"req-1",
            "certificate_b64":"cert",
            "trust_root_b64":"root",
            "expires_at_ms":123
        }"#;

        match sender_certificate_response_from_frame(certificate, "req-1").unwrap() {
            CertificateReadResult::Matched(response) => {
                assert_eq!(response.certificate_b64, "cert");
                assert_eq!(response.trust_root_b64, "root");
                assert_eq!(response.expires_at_ms, 123);
            }
            CertificateReadResult::KeepReading => panic!("matching certificate should complete request"),
        }
    }

    #[test]
    fn pow_hash_ok_matches_legacy_22_bit_check() {
        // The helper must accept exactly what the old hand-inlined test did at 22
        // bits: hash[0]==0 && hash[1]==0 && (hash[2] >> 2) == 0.
        assert_eq!(POW_LEADING_ZERO_BITS, 22);
        let legacy = |h: &[u8; 3]| h[0] == 0 && h[1] == 0 && (h[2] >> 2) == 0;
        for a in [0u8, 1, 0xff] {
            for b in [0u8, 1, 0xff] {
                for c in 0u8..=255 {
                    let h = [a, b, c, 0xff, 0x00];
                    assert_eq!(pow_hash_ok(&h), legacy(&[a, b, c]), "mismatch at {a:#x},{b:#x},{c:#x}");
                }
            }
        }
    }

    #[test]
    fn sender_certificate_hello_serializes_as_cert_only() {
        let frame = ClientFrame::Hello {
            recipient_id: "mbx_sender_1234567890".to_string(),
            auth_token: "auth_token_123456".to_string(),
            delivery_token: "delivery_token_123456".to_string(),
            protocol_min: PROTOCOL_MIN_SUPPORTED,
            protocol_max: PROTOCOL_VERSION,
            pow: None,
            cert_only: true,
        };

        let value = serde_json::to_value(frame).unwrap();
        assert_eq!(value.get("type").and_then(|v| v.as_str()), Some("hello"));
        assert_eq!(value.get("cert_only").and_then(|v| v.as_bool()), Some(true));
    }
}
