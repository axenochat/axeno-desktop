#!/usr/bin/env bash
#
# Set the Axeno desktop version everywhere it matters, in one shot:
#
#   ./scripts/set-version.sh 0.2.0
#
# Updates:
#   - package.json + package-lock.json   (npm version)
#   - src-tauri/tauri.conf.json          (the version the bundler and updater use)
#   - src-tauri/Cargo.toml + Cargo.lock
#
# It does NOT create the git tag. Review the diff, commit, then:
#
#   git tag v<version> && git push origin v<version>
#
# The tag must match the version set here: the release workflow builds whatever
# is in the files, and the in-app updater compares versions by semver.
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "usage: $0 <version>   (e.g. $0 0.2.0)" >&2
  exit 1
fi
if ! printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'; then
  echo "error: '$VERSION' is not a valid semver version" >&2
  exit 1
fi
case "$VERSION" in
  *-*)
    echo "WARN: '$VERSION' is a prerelease. Semver orders it BEFORE the bare version" >&2
    echo "WARN: (0.2.0-beta < 0.2.0), which is what the in-app updater compares by." >&2
    ;;
esac

echo "==> package.json + package-lock.json"
npm version "$VERSION" --no-git-tag-version --allow-same-version >/dev/null

echo "==> src-tauri/tauri.conf.json"
node -e '
  const fs = require("fs");
  const path = "src-tauri/tauri.conf.json";
  const conf = JSON.parse(fs.readFileSync(path, "utf8"));
  conf.version = process.argv[1];
  fs.writeFileSync(path, JSON.stringify(conf, null, 2) + "\n");
' "$VERSION"

echo "==> src-tauri/Cargo.toml + Cargo.lock"
# Replace only the [package] version line (the first `version = ` in the file).
sed -i.bak -E "0,/^version = \"[^\"]*\"/s//version = \"$VERSION\"/" src-tauri/Cargo.toml
rm -f src-tauri/Cargo.toml.bak
(cd src-tauri && cargo update --package axeno-client --offline --quiet)

echo
echo "Version set to $VERSION in:"
echo "  package.json, package-lock.json, src-tauri/tauri.conf.json,"
echo "  src-tauri/Cargo.toml, src-tauri/Cargo.lock"
echo
echo "Next: review the diff, commit, then tag the release:"
echo "  git tag v$VERSION && git push origin v$VERSION"
