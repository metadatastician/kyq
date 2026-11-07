#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
# Check parsed workflow refs and lock identity. A reusable-workflow record is
# distinct from a leaf action: canonical standards closure retains its call ref.
set -euo pipefail
wf=${1:-.github/workflows}
for tool in yq jq; do
  command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 2; }
done
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
shopt -s nullglob
files=("$wf"/*.yml "$wf"/*.yaml)
(( ${#files[@]} > 0 )) || { echo 'No workflow population inspected' >&2; exit 2; }
: > "$tmp/refs"
for file in "${files[@]}"; do
  yq -o=json '.' "$file" | jq -e -s --arg file "$file" '
    if length != 1 then error("expected one workflow document") else .[0] end
    | if (.jobs | type) != "object" then error("jobs must be a mapping") else .jobs end
    | to_entries | map(.value |
        if type != "object" then error("job must be a mapping") else . end |
        (if has("uses") then [{file:$file, kind:"job", ref:.uses}] else [] end) +
        (if (.steps // [] | type) != "array" then error("steps must be a sequence")
         else [(.steps // [])[] |
           if type != "object" then error("step must be a mapping") else . end |
           select(has("uses")) | {file:$file, kind:"step", ref:.uses}] end)) | add // []
    | if all(.[]; (.ref | type) == "string") then . else error("uses must be a string") end
  ' >> "$tmp/refs"
done
if [[ -f "$wf/actions.lock" ]]; then
  yq -o=json '.' "$wf/actions.lock" | jq -e -s '
    if length == 1 and (.[0].dependencies | type) == "object"
    then .[0].dependencies else error("invalid lock dependencies") end
  ' > "$tmp/dependencies"
else
  printf '{}\n' > "$tmp/dependencies"
fi
jq -e -s --slurpfile dependencies "$tmp/dependencies" '
  def key:
    capture("^(?<owner>[^/]+)/(?<repo>[^/@]+)(?:/[^@]+)?@(?<ref>[^@]+)$")
    | (.owner | ascii_downcase) + "/" + (.repo | ascii_downcase) + "@" +
      (.ref | if test("^[0-9a-fA-F]{40}$") then ascii_downcase else . end);
  add as $refs |
  ($dependencies[0] | to_entries | map({key:(.key | key),value:.value}) | from_entries) as $deps |
  ([$refs[] | select(.kind == "job" and (.ref | test("^[^./][^@]*/\\.github/workflows/[^@]+@[^@]+$"))) | .ref | key]) as $callers |
  ([$deps | to_entries[] |
    .key as $key | .value as $record | ($key | split("@") | last) as $pin |
    if ($record.commit | type) != "string" or
       ($record.commit | test("^sha1-[0-9a-f]{40}$") | not) or
       (($pin | test("^[0-9a-f]{40}$")) and $record.commit != ("sha1-" + $pin))
    then "invalid lock identity: " + $key
    elif ($record.ref | type) != "string" or $record.ref == "" then "missing ref: " + $key
    elif ($record.ref | test("^[0-9a-fA-F]{40}$")) then
      if ($record.ref | ascii_downcase) == $pin and ($callers | index($key)) != null and
         ($record.uses | type) == "array" and ($record.uses | length) > 0 and
         all($record.uses[]; type == "string")
      then empty else "own-SHA ref outside a declared reusable edge: " + $key end
    else empty end] +
   [$refs[] | . as $site | .ref as $ref |
    if ($ref | startswith("./") or startswith("$/") or startswith("docker://")) then empty
    elif ($ref | test("^[^/]+/[^@]+@[0-9a-fA-F]{40}$")) then empty
    else ($ref | key) as $key |
      if $deps | has($key) then empty else "unlocked ref in " + $site.file + ": " + $ref end
    end]) as $errors |
  if ($errors | length) == 0 then
    "All parsed action refs are pinned; declared reusable edges retain canonical closure metadata."
  else error($errors | join("\n")) end
' "$tmp/refs"
