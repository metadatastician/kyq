#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
# SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell
# Offline negative controls for the checksum-pinned Guix mirror downloader.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
mkdir -p "$work/bin"
printf 'test-only Guix archive bytes\n' > "$work/fixture"
digest=$(sha256sum "$work/fixture" | cut -d ' ' -f 1)
export FIXTURE="$work/fixture" CURL_LOG="$work/curl.log"

cat > "$work/bin/curl" <<'FAKE_CURL'
#!/usr/bin/env bash
set -euo pipefail
out=
url=
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) out=$2; shift 2 ;;
    https://*) url=$1; shift ;;
    *) shift ;;
  esac
done
[[ -n $out && -n $url ]] || exit 7
printf '%s\n' "$url" >> "$CURL_LOG"
case "$FAKE_CURL_MODE" in
  fallback)
    [[ $url != *ftp.gnu.org* ]] || exit 7
    cp "$FIXTURE" "$out"
    ;;
  corrupt)
    printf 'wrong bytes\n' > "$out"
    ;;
  unavailable)
    exit 7
    ;;
  *)
    exit 7
    ;;
esac
FAKE_CURL
chmod +x "$work/bin/curl"
export PATH="$work/bin:$PATH"

: > "$CURL_LOG"
FAKE_CURL_MODE=fallback bash "$root/scripts/fetch-guix-pinned.sh" \
  1.5.0 "$digest" "$work/verified.tar.xz" > "$work/fallback.log"
cmp "$work/fixture" "$work/verified.tar.xz"
[[ $(wc -l < "$CURL_LOG") -eq 2 ]] || { echo "fallback did not try two sources" >&2; exit 1; }

: > "$CURL_LOG"
if FAKE_CURL_MODE=corrupt bash "$root/scripts/fetch-guix-pinned.sh" \
    1.5.0 "$digest" "$work/corrupt.tar.xz" > "$work/corrupt.log" 2>&1; then
  echo "checksum mismatch unexpectedly passed" >&2
  exit 1
fi
[[ ! -e $work/corrupt.tar.xz ]] || { echo "corrupt archive published" >&2; exit 1; }
[[ $(wc -l < "$CURL_LOG") -eq 1 ]] || { echo "mirror fallback after a bad checksum" >&2; exit 1; }

: > "$CURL_LOG"
if FAKE_CURL_MODE=unavailable bash "$root/scripts/fetch-guix-pinned.sh" \
    1.5.0 "$digest" "$work/unavailable.tar.xz" > "$work/unavailable.log" 2>&1; then
  echo "all mirrors unavailable unexpectedly passed" >&2
  exit 1
fi
[[ ! -e $work/unavailable.tar.xz ]] || { echo "unavailable archive published" >&2; exit 1; }
[[ $(wc -l < "$CURL_LOG") -eq 3 ]] || { echo "not all mirrors attempted" >&2; exit 1; }

: > "$CURL_LOG"
if FAKE_CURL_MODE=fallback bash "$root/scripts/fetch-guix-pinned.sh" \
    1.5.0 not-a-sha256 "$work/invalid.tar.xz" > "$work/invalid.log" 2>&1; then
  echo "invalid checksum accepted" >&2
  exit 1
fi
[[ ! -s $CURL_LOG ]] || { echo "invalid arguments triggered network" >&2; exit 1; }

echo "PASS: Guix mirror fallback, checksum refusal, unavailable mirrors and bad-pin controls"
