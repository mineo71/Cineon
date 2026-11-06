#!/usr/bin/env bash
# Refreshes the filter list snapshot bundled with the app, so blocking works on first launch
# with no network. The app updates its own copies weekly at runtime.
set -euo pipefail
cd "$(dirname "$0")/../Cineon/Resources/Filters"

fetch() {
  local name="$1" url="$2" tmp
  tmp="$(mktemp)"
  curl -fsSL -m 60 "$url" -o "$tmp"
  [ "$(wc -l < "$tmp")" -gt 100 ] || { echo "$name looks wrong, keeping the old copy" >&2; rm -f "$tmp"; return 1; }
  mv "$tmp" "$name.txt"
  chmod 644 "$name.txt"
  printf '%-14s %8s lines\n' "$name" "$(wc -l < "$name.txt" | tr -d ' ')"
}

fetch easylist     "https://easylist.to/easylist/easylist.txt"
fetch easyprivacy  "https://easylist.to/easylist/easyprivacy.txt"
fetch ublock       "https://ublockorigin.github.io/uAssets/filters/filters.txt"
fetch peterlowe    "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&mimetype=plaintext"
