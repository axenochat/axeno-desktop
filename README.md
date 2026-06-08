# Axeno Desktop

Axeno is a private desktop messenger. It uses the Signal Protocol for end-to-end encryption and routes traffic through Tor. There are no accounts, phone numbers, or email addresses; you add contacts by exchanging one-time connection codes.

This repository is the **desktop client**, built with [Tauri](https://tauri.app) (Rust backend, React frontend). It connects to a self-hosted Rust relay — see [**axeno-relay**](https://github.com/axenochat/axeno-relay) to run one.

> **Status:** early development, not independently audited. Do not rely on it where your safety is at stake.

## Features

- End-to-end encryption with the Signal Protocol, including double-ratchet forward secrecy and Kyber post-quantum prekeys
- Sealed sender, so the relay never learns who sent a message
- A separate mailbox per contact, so the relay cannot reconstruct your contact graph
- Tor transport built in via [Arti](https://gitlab.torproject.org/tpo/core/arti); no separate Tor install needed on the client
- Local message store and identity vault encrypted at rest (ChaCha20-Poly1305, Argon2id)
- Out-of-band safety-number verification
- Automatic, signed in-app updates

## Install

Download the latest build for your platform from the [Releases](https://github.com/axenochat/axeno-desktop/releases) page:

- **macOS** — `.dmg` (Apple Silicon or Intel)
- **Windows** — `-setup.exe` (x64 or ARM64)
- **Linux** — `.AppImage` (x86_64 or aarch64; requires FUSE / `libfuse2`)

The app checks for updates on launch and prompts before installing a new signed release. You can disable the check in **Settings → About → Check for updates** (the check is a direct, non-Tor request to GitHub).

## Build from source

Requirements:

- Rust, stable toolchain ([rustup](https://rustup.rs))
- Node.js 18 or newer
- `protoc` (Protocol Buffers compiler) — `apt install protobuf-compiler`, `brew install protobuf`, etc.
- The [Tauri v2 system dependencies](https://tauri.app/start/prerequisites/) for your platform

```bash
npm install
npm run tauri build      # production bundle
npm run tauri dev        # development with hot reload
```

## First run

On first launch you create an identity by choosing a display name and a passphrase. The passphrase encrypts your local vault and is required to unlock the app on each start.

Then open **Settings**, add a relay's `.onion` address, and select it as your default relay. To add a contact, one person generates a connection code in **Add Contact** and shares it with the other, who enters it in their own **Add Contact**.

## Security model

Axeno aims to protect message confidentiality and integrity, sender anonymity from the relay (sealed sender), contact-graph privacy (per-contact mailboxes), IP-level unlinkability (Tor), and confidentiality of your identity and history at rest while the app is locked.

It does not protect against a compromised device, global traffic analysis, or loss of relay availability. For the full model and the relay's role, see the [relay repository](https://github.com/axenochat/axeno-relay).

## License

Axeno is licensed under the **GNU General Public License v3.0**. See [LICENSE](./LICENSE).
