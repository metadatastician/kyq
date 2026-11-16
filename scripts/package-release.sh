#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
# Package an already-built native executable; this script never downloads tools.
set -euo pipefail
if [[ $# != 2 ]]; then echo 'usage: package-release.sh TARGET VERSION' >&2; exit 2; fi
target=$1
version=$2
case "$target" in
  x86_64-unknown-linux-gnu|aarch64-apple-darwin) binary=kyq ;;
  x86_64-pc-windows-msvc) binary=kyq.exe ;;
  *) echo "unsupported release target: $target" >&2; exit 2 ;;
esac
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][A-Za-z0-9.+-]+)?$ ]] || { echo 'invalid version' >&2; exit 2; }
source="target/$target/release/$binary"
[[ -f $source ]] || { echo "missing executable: $source" >&2; exit 1; }
[[ $("$source" --version) == "kyq $version" ]] || { echo 'binary version differs from release' >&2; exit 1; }
name="kyq-$version-$target"
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
mkdir -p "$work/$name" dist
cp "$source" README.adoc LICENSE "$work/$name/"
cp -R LICENSES "$work/$name/"
tar -czf "dist/$name.tar.gz" -C "$work" "$name"
(cd dist; if command -v sha256sum >/dev/null 2>&1; then sha256sum "$name.tar.gz"; else shasum -a 256 "$name.tar.gz"; fi) > "dist/$name.sha256"
# A broken/empty archive must fail before the workflow uploads it.
tar -tzf "dist/$name.tar.gz" | grep -Fx "$name/$binary"
