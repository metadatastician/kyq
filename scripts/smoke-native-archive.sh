#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
# SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell
# Independently exercise an already-packaged native release outside the checkout.
# Usage: bash scripts/smoke-native-archive.sh TARGET VERSION
set -euo pipefail

[[ $# -eq 2 ]] || { echo "usage: smoke-native-archive.sh TARGET VERSION" >&2; exit 2; }
target=$1
version=$2
case "$target" in
  x86_64-unknown-linux-gnu|aarch64-apple-darwin) binary=kyq ;;
  x86_64-pc-windows-msvc) binary=kyq.exe ;;
  *) echo "unsupported target: $target" >&2; exit 2 ;;
esac
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][A-Za-z0-9.+-]+)?$ ]] ||
  { echo "invalid release version" >&2; exit 2; }

name="kyq-$version-$target"
archive="dist/$name.tar.gz"
checksum="dist/$name.sha256"
[[ -f $archive && -f $checksum ]] || { echo "missing packaged archive or checksum" >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then
  (cd dist && sha256sum --check --strict "$name.sha256")
elif command -v shasum >/dev/null 2>&1; then
  (cd dist && shasum -a 256 --check "$name.sha256")
else
  echo "no SHA-256 checksum verifier is installed" >&2
  exit 1
fi

scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
tar -xzf "$archive" -C "$scratch"
executable="$scratch/$name/$binary"
[[ -f $executable ]] || { echo "missing packaged executable" >&2; exit 1; }
[[ -f "$scratch/$name/README.adoc" && -f "$scratch/$name/LICENSE" ]] ||
  { echo "missing packaged documentation or licence" >&2; exit 1; }

(
  # No Cargo invocation or relative access to the source tree may be needed.
  cd "$scratch"
  actual=$("$executable" --version)
  [[ $actual == "kyq $version" ]] ||
    { echo "installed executable reports wrong version: $actual" >&2; exit 1; }

  "$executable" --capabilities > "$scratch/capabilities.json"
  jq -e '.schema_version == "0.1.0" and .contract_status == "preview" and (.formats.toml.operations == ["validate"]) and .safety.atomic_fix_implemented == false' \
    "$scratch/capabilities.json" >/dev/null ||
    { echo "installed capabilities do not match the implemented contract" >&2; exit 1; }

  printf 'a: 1\n' | "$executable" validate --from kyaml - > "$scratch/valid.out"
  [[ ! -s "$scratch/valid.out" ]] || { echo "validate wrote data to stdout" >&2; exit 1; }

  printf '{"b":2,"a":1}' | "$executable" canon --from json - > "$scratch/canon.out"
  printf '{"a":1,"b":2}' > "$scratch/canon.expected"
  cmp "$scratch/canon.expected" "$scratch/canon.out" ||
    { echo "canonical bytes differ" >&2; exit 1; }

  status=0
  printf 'a: [\n' |
    "$executable" validate --from kyaml - > "$scratch/invalid.out" 2> "$scratch/invalid.err" ||
    status=$?
  [[ $status -eq 2 ]] || { echo "invalid input was not refused with status 2" >&2; exit 1; }
  [[ ! -s "$scratch/invalid.out" ]] || { echo "invalid input produced stdout" >&2; exit 1; }
  [[ -s "$scratch/invalid.err" ]] || { echo "invalid input produced no diagnostic" >&2; exit 1; }
)
echo "PASS: $name verified and executed from an extracted standalone archive"
