#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
# SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell
# Download the pinned GNU Guix binary with fail-closed mirror failover.
# Usage: bash scripts/fetch-guix-pinned.sh VERSION SHA256 DESTINATION
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: fetch-guix-pinned.sh VERSION SHA256 DESTINATION" >&2
  exit 2
fi
version=$1
expected=$2
destination=$3
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "invalid Guix version" >&2; exit 2; }
[[ $expected =~ ^[0-9a-f]{64}$ ]] || { echo "invalid pinned SHA-256" >&2; exit 2; }
[[ $destination != "" ]] || { echo "missing destination" >&2; exit 2; }
[[ ! -e $destination && ! -L $destination ]] || { echo "refusing to overwrite existing archive" >&2; exit 2; }
dest_dir=$(dirname -- "$destination")
[[ -d $dest_dir ]] || { echo "destination directory does not exist" >&2; exit 2; }

scratch=$(mktemp -d "$dest_dir/.guix-fetch.XXXXXXXX")
trap 'rm -rf -- "$scratch"' EXIT
archive="guix-binary-$version.x86_64-linux.tar.xz"

for base in "https://ftp.gnu.org/gnu/guix" "https://mirrors.kernel.org/gnu/guix" "https://mirrors.ibiblio.org/gnu/guix"; do
  rm -f -- "$scratch/guix.tar.xz"
  if curl --proto '=https' --proto-redir '=https' --tlsv1.2 \
      --fail --silent --show-error --location \
      --connect-timeout 12 --max-time 300 --retry 1 --retry-delay 2 \
      --output "$scratch/guix.tar.xz" "$base/$archive"; then
    # An integrity failure is fatal; never try another mirror after a bad hash.
    if ! printf '%s  %s\n' "$expected" "$scratch/guix.tar.xz" |
        sha256sum --check --strict; then
      echo "Guix SHA-256 mismatch: refusing archive from $base" >&2
      exit 1
    fi
    mv -- "$scratch/guix.tar.xz" "$destination"
    echo "Guix $version: verified pinned archive from $base"
    exit 0
  fi
  echo "Guix download unavailable from $base; trying next mirror" >&2
done

echo "Guix $version: all pinned HTTPS mirrors unavailable; no archive accepted" >&2
exit 1
