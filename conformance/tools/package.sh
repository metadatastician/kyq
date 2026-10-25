#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
# SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell (hyperpolymath) <j.d.a.jewell@open.ac.uk>
#
# package.sh — build the pinned conformance-gate release tarball.
#
# The archive is deterministic for a given tree: entries are sorted, every
# mtime is epoch 0, owners are 0:0, gzip is invoked with -n so it stores no
# timestamp or filename. Re-running on the same commit therefore produces the
# same SHA-256, which is what makes "pin the digest" a meaningful instruction
# for consumer CI (docs/CONFORMANCE_GATE.adoc §Installing and pinning).
#
# Requirements: GNU tar (for --sort/--mtime/--owner), gzip, sha256sum.
# Output: dist/kyq-conformance-<version>.tar.gz and dist/SHA256SUMS.
#
# Usage: bash conformance/tools/package.sh [--out DIR]

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$script_dir/../.." && pwd)"
out="$root/dist"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --out)
      out="$2"
      shift 2
      ;;
    *)
      echo "usage: package.sh [--out DIR]" >&2
      exit 2
      ;;
  esac
done

if ! tar --version 2>/dev/null | grep -q 'GNU tar'; then
  echo "package.sh: GNU tar is required (macOS bsdtar cannot sort entries or set a fixed mtime)" >&2
  exit 2
fi

version="$(tr -d '[:space:]' < "$root/conformance/VERSION")"
if [ -z "$version" ]; then
  echo "package.sh: conformance/VERSION is empty" >&2
  exit 1
fi

name="kyq-conformance-$version"
stage="$(mktemp -d)"
cleanup() { rm -rf "$stage"; }
trap cleanup EXIT

mkdir -p "$stage/$name"
# Ship the executable, the corpus, the tests and the tools: a consumer must be
# able to re-run the whole gate from the tarball alone.
cp -R \
  "$root/conformance/bin" \
  "$root/conformance/src" \
  "$root/conformance/test" \
  "$root/conformance/tools" \
  "$root/conformance/fixtures" \
  "$stage/$name/"
cp "$root/conformance/VERSION" "$root/conformance/package.json" "$stage/$name/"
mkdir -p "$stage/$name/LICENSES"
cp "$root/LICENSE" "$stage/$name/LICENSE"
cp "$root/LICENSES/MPL-2.0.txt" "$stage/$name/LICENSES/MPL-2.0.txt"
cp "$root/docs/CONFORMANCE_GATE.adoc" "$stage/$name/CONFORMANCE_GATE.adoc"
cp "$root/docs/KYAML_SPEC.adoc" "$stage/$name/KYAML_SPEC.adoc"
cp "$root/docs/IJSON_JCS_INTEGRATION.adoc" "$stage/$name/IJSON_JCS_INTEGRATION.adoc"

# Two tests exercise the files kyq ships as examples, so the tarball carries a
# mirror of them: without it those tests can only pass inside the repository,
# and a packaged gate that skips its own checks would be the vacuous pass this
# whole directory exists to prevent.
mkdir -p "$stage/$name/fixtures/repo"
for pair in \
  "examples/deployment.yaml:deployment.yaml" \
  "tests/fixtures/invalid-deployment.yaml:invalid-deployment.yaml"; do
  src="${pair%%:*}"
  dest="${pair#*:}"
  if [ ! -f "$root/$src" ]; then
    echo "package.sh: missing $src, refusing to ship a gate with skipped tests" >&2
    exit 1
  fi
  cp "$root/$src" "$stage/$name/fixtures/repo/$dest"
done

mkdir -p "$out"
archive="$out/kyq-conformance-$version.tar.gz"
rm -f "$archive"

tar \
  --sort=name \
  --mtime='@0' \
  --owner=0 \
  --group=0 \
  --numeric-owner \
  --format=gnu \
  -cf - \
  -C "$stage" \
  "$name" | gzip -9n > "$archive"

(
  cd "$out"
  sha256sum "$(basename "$archive")" > SHA256SUMS
)

echo "packaged $archive"
cat "$out/SHA256SUMS"
