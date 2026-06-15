#!/usr/bin/env bash
set -Eeuo pipefail

# Axeno local two-client test harness.
#
# Run it from the desktop client repo (this script lives in axeno-desktop/). It
# spins up two Tauri dev clients side by side so you can pair them and message.
# Both clients use the official relay that a fresh install defaults to, so no
# local relay is started.
#
# It will:
#   1. Copy axeno-desktop -> axeno-desktop2 (client B), preserving its deps/build
#   2. Patch client B to a second bundle identifier, Vite port, and window title
#   3. With --reset, wipe both clients' app data first for a clean identity;
#      by default the existing data (identities, contacts) is kept
#   4. npm install in both clients
#   5. Launch both Tauri dev clients, each in its own terminal
#
# Flags:
#   --reset   wipe both clients' app data before running (default: keep it)

RESET=0
for arg in "$@"; do
  case "$arg" in
    --reset) RESET=1 ;;
    -h|--help) sed -n '4,21p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'unknown option: %s (use --help)\n' "$arg" >&2; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

CLIENT_A="$SCRIPT_DIR"
CLIENT_B="$REPO_ROOT/axeno-desktop2"

PORT_A="1420"
PORT_B="1421"

log()  { printf '\033[1;36m[axeno-test]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[axeno-test warning]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[axeno-test error]\033[0m %s\n' "$*" >&2; exit 1; }

require_dir() { [[ -d "$1" ]] || fail "Missing directory: $1"; }
require_cmd() { command -v "$1" >/dev/null 2>&1 || fail "Missing command: $1"; }

require_dir "$CLIENT_A/src-tauri"
require_cmd npm
require_cmd python3
require_cmd cargo   # tauri dev compiles the Rust backend

# Read the bundle identifier from tauri.conf.json so the app-data paths and the
# client B patch stay correct even if the identifier changes. Client B gets the
# same identifier with a "2" suffix so the two clients use separate app data.
APP_ID_A="$(python3 - "$CLIENT_A/src-tauri/tauri.conf.json" <<'PY'
import json, sys
try:
    print(json.load(open(sys.argv[1]))["identifier"])
except Exception:
    print("chat.axeno.desktop")
PY
)"
APP_ID_B="${APP_ID_A}2"

# Tauri's app_data_dir on Linux is ~/.local/share/<identifier>; config is
# ~/.config/<identifier>. The vault, message store, and unified state all live
# under app_data_dir.
DATA_A="$HOME/.local/share/$APP_ID_A"; CONF_A="$HOME/.config/$APP_ID_A"
DATA_B="$HOME/.local/share/$APP_ID_B"; CONF_B="$HOME/.config/$APP_ID_B"

if [[ "$RESET" -eq 1 ]]; then
  log "Reset: wiping both clients' app data"
  rm -rf "$DATA_A" "$CONF_A" "$DATA_B" "$CONF_B"
else
  log "Keeping existing client app data (use --reset to wipe)"
fi

log "Syncing $CLIENT_A -> $CLIENT_B (preserving its node_modules/target)"
mkdir -p "$CLIENT_B"
if command -v rsync >/dev/null 2>&1; then
  # --delete removes files in B that no longer exist in A. The excludes keep B's
  # compiled output and dependencies so they are reused across runs.
  rsync -a --delete \
    --exclude node_modules \
    --exclude dist \
    --exclude target \
    --exclude .git \
    "$CLIENT_A/" "$CLIENT_B/"
else
  # Fallback without rsync: overwrite tracked files without destroying B's deps.
  warn "rsync not found; falling back to cp (will not delete removed files)"
  cp -a "$CLIENT_A/src" "$CLIENT_A/src-tauri" "$CLIENT_B/" 2>/dev/null || true
  cp -a "$CLIENT_A/"*.* "$CLIENT_B/" 2>/dev/null || true
  rm -rf "$CLIENT_B/node_modules/.vite" 2>/dev/null || true
fi

log "Patching client B (identifier $APP_ID_B, Vite port $PORT_B)"
python3 - "$CLIENT_B" "$APP_ID_B" "$PORT_B" <<'PY'
import json, pathlib, sys

client = pathlib.Path(sys.argv[1])
app_id = sys.argv[2]
port = sys.argv[3]

package_path = client / "package.json"
config_path = client / "src-tauri" / "tauri.conf.json"

pkg = json.loads(package_path.read_text())
pkg.setdefault("scripts", {})["dev"] = f"vite --port {port}"
package_path.write_text(json.dumps(pkg, indent=2) + "\n")

conf = json.loads(config_path.read_text())
conf["productName"] = "Axeno 2"
conf["identifier"] = app_id
conf.setdefault("build", {})["devUrl"] = f"http://localhost:{port}"

windows = conf.setdefault("app", {}).setdefault("windows", [])
if windows:
    windows[0]["title"] = "Axeno 2"

# Keep the CSP connect-src aligned with client B's Vite port.
security = conf.setdefault("app", {}).setdefault("security", {})
csp = security.get("csp")
if isinstance(csp, dict):
    connect_src = csp.get("connect-src", "")
    for item in (f"http://localhost:{port}", f"http://127.0.0.1:{port}"):
        if item not in connect_src:
            connect_src = (connect_src + " " + item).strip()
    csp["connect-src"] = connect_src

config_path.write_text(json.dumps(conf, indent=2) + "\n")
PY

log "Installing npm dependencies (client A)"
(cd "$CLIENT_A" && npm install)
log "Installing npm dependencies (client B)"
(cd "$CLIENT_B" && npm install)

if command -v ss >/dev/null 2>&1; then
  for p in "$PORT_A" "$PORT_B"; do
    if ss -ltn "sport = :$p" 2>/dev/null | grep -q ":$p"; then
      warn "Port $p is already in use. Free it first, e.g.: fuser -k ${p}/tcp"
    fi
  done
fi

run_in_terminal() {
  local title="$1" dir="$2" cmd="$3"
  local full_cmd="cd '$dir' && $cmd; echo; echo '[axeno-test] $title exited. Press Enter to close.'; read -r _"

  if command -v gnome-terminal >/dev/null 2>&1; then
    gnome-terminal --title="$title" -- bash -lc "$full_cmd"
  elif command -v konsole >/dev/null 2>&1; then
    konsole --new-tab -p tabtitle="$title" -e bash -lc "$full_cmd"
  elif command -v xfce4-terminal >/dev/null 2>&1; then
    xfce4-terminal --title="$title" --command="bash -lc $full_cmd"
  elif command -v kgx >/dev/null 2>&1; then
    kgx --title "$title" -- bash -lc "$full_cmd"
  elif command -v alacritty >/dev/null 2>&1; then
    alacritty -T "$title" -e bash -lc "$full_cmd" &
  elif command -v xterm >/dev/null 2>&1; then
    xterm -T "$title" -e bash -lc "$full_cmd" &
  else
    warn "No supported terminal emulator found; running '$title' in the background, logging to $REPO_ROOT/${title// /_}.log"
    (cd "$dir" && bash -lc "$cmd") > "$REPO_ROOT/${title// /_}.log" 2>&1 &
  fi
}

log "Starting client A (Vite port $PORT_A)"
run_in_terminal "Axeno Client A" "$CLIENT_A" "WEBKIT_DISABLE_COMPOSITING_MODE=1 npm run tauri dev"
sleep 2

log "Starting client B (Vite port $PORT_B)"
run_in_terminal "Axeno Client B" "$CLIENT_B" "WEBKIT_DISABLE_COMPOSITING_MODE=1 npm run tauri dev"

cat <<EOF

$(log "Both clients are launching.")
$(log "Client A app data: $DATA_A")
$(log "Client B app data: $DATA_B")

Next, in EACH client:
  1. Create an identity (display name + passphrase).
  2. Wait for Tor to connect (first launch takes a bit). Both clients use the
     official relay that a fresh install already has set as the default.
  3. In one client, open Add Contact and generate a connection code.
  4. Paste that code into the other client's Add Contact, then start messaging.
EOF
