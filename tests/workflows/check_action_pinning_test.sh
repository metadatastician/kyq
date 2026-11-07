#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
mkdir "$tmp/wf"
sha=1111111111111111111111111111111111111111
passed=0
check() {
  local expected=$1 label=$2 rc=0
  bash "$root/scripts/check-action-pinning.sh" "$tmp/wf" > "$tmp/result" 2>&1 || rc=$?
  if { [[ "$expected" == pass ]] && (( rc != 0 )); } ||
     { [[ "$expected" == fail ]] && (( rc == 0 )); }; then
    cat "$tmp/result" >&2; echo "FAIL: $label" >&2; exit 1
  fi
  passed=$((passed + 1)); echo "ok $passed: $label"
}
printf 'jobs: {test: {steps: [{uses: "example/action@%s"}]}}\n' "$sha" > "$tmp/wf/test.yml"
check pass 'inline immutable ref without a lock'
printf 'jobs: {test: {steps: [{"uses": "example/action@v1"}]}}\n' > "$tmp/wf/test.yml"
check fail 'quoted flow key cannot hide unlocked ref'
cat > "$tmp/wf/actions.lock" <<EOF
dependencies:
  'example/action@v1':
    ref: v1
    commit: sha1-$sha
EOF
check pass 'tag resolves to immutable lock identity'
printf 'jobs: {test: {steps: [{uses: "EXAMPLE/action@V1"}]}}\n' > "$tmp/wf/test.yml"
check fail 'tag names remain case-sensitive'
printf 'jobs: {test: {steps: [{uses: "EXAMPLE/action@v1"}]}}\n' > "$tmp/wf/test.yml"
check pass 'repository owner casing is normalized'
cat > "$tmp/wf/actions.lock" <<EOF
dependencies:
  'example/action@$sha':
    ref: '$sha'
    commit: sha1-$sha
    uses: ['actions/checkout@$sha']
EOF
printf 'jobs: {test: {steps: [{uses: "example/action@%s"}]}}\n' "$sha" > "$tmp/wf/test.yml"
check fail 'leaf cannot claim reusable exemption with a uses list'
printf 'jobs: {test: {uses: "example/action/.github/workflows/test.yml@%s"}}\n' "$sha" > "$tmp/wf/test.yml"
check pass 'actual job-level reusable preserves canonical call ref'
yq -i '.dependencies[].uses = []' "$tmp/wf/actions.lock"
check fail 'empty reusable closure cannot claim exemption'
yq -i '.dependencies[].ref = "v1" | .dependencies[].commit = "sha1-2222222222222222222222222222222222222222"' "$tmp/wf/actions.lock"
check fail 'lock digest must match immutable key'
printf 'jobs: []\n' > "$tmp/wf/test.yml"
check fail 'malformed job collection blocks'
echo "PASS: $passed parsed workflow pin controls"
