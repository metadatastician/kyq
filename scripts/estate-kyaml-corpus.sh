#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
# SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell
# Regenerate the estate KYAML corpus (ULTRAPLAN W8, part 1).
#
# The estate writes KYAML with `yq -p yaml -o kyaml '.'` (standards
# scripts/kyaml-format.sh, YAML-POLICY §3.4). This script takes the real YAML
# files of metadatastician/standards at one pinned commit, renders each as
# KYAML with the pinned yq, and records yq's own reading of the source as the
# expected value. kyq is not run here, so the expectations are independent of it.
#
# Usage: bash scripts/estate-kyaml-corpus.sh
# Needs: curl, yq at YQ_VERSION, sha256sum. Writes tests/corpus/estate-kyaml/.
set -euo pipefail

STANDARDS_REPO="metadatastician/standards"
STANDARDS_COMMIT="745fc744158047a675eeb92464167c9961d66c4b"
YQ_VERSION="v4.53.3"

root=$(cd "$(dirname "$0")/.." && pwd)
dir="$root/tests/corpus/estate-kyaml"
sources="$dir/SOURCES"
[[ -f $sources ]] || { echo "missing $sources" >&2; exit 2; }
command -v yq >/dev/null || { echo "yq is not on PATH" >&2; exit 2; }
have=$(yq --version | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+')
[[ $have == "$YQ_VERSION" ]] ||
  { echo "yq $have found; the corpus is pinned to $YQ_VERSION" >&2; exit 2; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
rm -f "$dir"/cases/*.kyaml "$dir"/cases/*.json
mkdir -p "$dir/cases"
manifest="$work/MANIFEST.tsv"
printf '# standards=%s@%s yq=%s\n# name\tsource\tsource_sha256\n' \
  "$STANDARDS_REPO" "$STANDARDS_COMMIT" "$YQ_VERSION" > "$manifest"

while IFS= read -r path; do
  [[ -z $path || $path == \#* ]] && continue
  name=$(printf '%s' "$path" | tr '/' '_' | sed 's/^\.//')
  src="$work/$name"
  curl -fsSL --proto '=https' --retry 3 -o "$src" \
    "https://raw.githubusercontent.com/$STANDARDS_REPO/$STANDARDS_COMMIT/$path" ||
    { echo "ERROR: cannot fetch $path" >&2; exit 2; }
  # Every document of the stream, as one JSON array, in yq's reading.
  yq -p yaml -o json -I 0 ea '[.]' "$src" > "$dir/cases/$name.json"
  yq -p yaml -o kyaml '.' "$src" > "$dir/cases/$name.kyaml"
  printf '%s\t%s\t%s\n' "$name" "$path" "$(sha256sum "$src" | cut -d' ' -f1)" >> "$manifest"
done < "$sources"

cp "$manifest" "$dir/MANIFEST.tsv"
echo "estate KYAML corpus: $(grep -vc '^#' "$dir/MANIFEST.tsv") cases"
