# Axeno Desktop

Axeno is a private desktop messenger. It uses the Signal Protocol for end-to-end encryption and routes traffic through Tor. There are no accounts, phone numbers, or email addresses; you add contacts by exchanging connection codes.

This repository is the **desktop client**, built with [Tauri](https://tauri.app) (Rust backend, React frontend). It connects to a self-hosted Rust relay. See [**axeno-relay**](https://github.com/axenochat/axeno-relay) to run one.

> **Status:** early development, not independently audited. Do not rely on it where your safety is at stake.

## Quick Demo Video

https://github.com/user-attachments/assets/a48901fd-2cf7-4b42-bda8-3d623e44ae17

## Features

- End-to-end encryption with the Signal Protocol, including double-ratchet forward secrecy and Kyber post-quantum prekeys
- Sealed sender, so the relay can never tie a message to your identity
- A separate mailbox per contact, so the relay cannot reconstruct your contact graph
- Tor transport built in via [Arti](https://gitlab.torproject.org/tpo/core/arti); no separate Tor install needed on the client
- Local message store and identity vault encrypted at rest (ChaCha20-Poly1305, Argon2id)
- Out-of-band safety-number verification
- Automatic, signed in-app updates

## Install

Download the latest build for your platform from the [Releases](https://github.com/axenochat/axeno-desktop/releases) page:

- **macOS**: `.dmg` (Apple Silicon or Intel)
- **Windows**: `-setup.exe` (x64 or ARM64)
- **Linux**: `.AppImage` (x86_64 or aarch64; requires FUSE / `libfuse2`)

### macOS: first launch

The app is not notarized by Apple. After opening the `.dmg` and dragging Axeno to your Applications folder, macOS will block the first launch with a security warning. Just run the command below before opening Axeno:
```
xattr -cr /Applications/Axeno.app
```

You only need to do this once. After the first approved launch the app opens normally.

I may change this in future, but for now it's not feasible, and trivially fixable anyway.


## Updating

The app checks for updates on launch and prompts before installing a new signed release. By default the check and download are routed through Tor, so GitHub does not see your IP. GitHub sometimes blocks Tor, in which case the update fails and you can retry or turn off **Update over Tor** in **Settings → About**; you can also disable update checks there entirely (please don't do this).

## Build from source

Requirements:

- Rust, stable toolchain ([rustup](https://rustup.rs))
- Node.js 18 or newer
- `protoc` (Protocol Buffers compiler): `apt install protobuf-compiler`, `brew install protobuf`, etc.
- The [Tauri v2 system dependencies](https://tauri.app/start/prerequisites/) for your platform

```bash
npm install
npm run tauri build      # production bundle
npm run tauri dev        # development with hot reload
```

## First run

On first launch you create an identity by choosing a display name and a passphrase. The passphrase encrypts your local vault and is required to unlock the app on each start.

A new install comes with the official relay pre-selected as your default, so you can start messaging right away. To add a contact, one person generates a connection code in **Add Contact** and shares it with the other, who enters it in their own **Add Contact**.

## Relays

A relay is the broker that passes encrypted messages between you and your contacts. It never sees plaintext, but its operator can observe transport metadata: which mailbox talks to which, timing, and message sizes.

New installs are pre-configured with the official relay:

```
ws://qm73p7v2lh63lgavogxrvf3wafv7srrcr65jgcqckuphmai4dqv3ydad.onion/ws
```

It is a normal relay entry. You can remove it under **Settings** at any time (if you remove it, it is not added back), and you can add your own or a friend's relay there and set that as your default. Running your own relay is the most private option, since you are not handing transport metadata to someone else; see [axeno-relay](https://github.com/axenochat/axeno-relay) to set one up.

## Security model

Axeno aims to protect message confidentiality and integrity, sender anonymity from the relay (sealed sender), contact-graph privacy (per-contact mailboxes), IP-level unlinkability (Tor), and confidentiality of your identity and history at rest while the app is locked.

It does not protect against a compromised device, global traffic analysis, or loss of relay availability. For the full model and the relay's role, see the [relay repository](https://github.com/axenochat/axeno-relay).

## License

Axeno is licensed under the **GNU General Public License v3.0**. See [LICENSE](./LICENSE).
