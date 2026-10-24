#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
#
# A1 grammar census for docs/AFFINESCRIPT_STRICT_PORT.adoc.
#
# This is deliberately an evidence probe, not a build/test gate. It runs parse
# and check independently for one-construct files, then checks every tracked
# .affine file. A source failure is data in the census; it is never rewritten
# to a PASS. Toolchain discovery and probe execution failures remain fatal.

set -euo pipefail

compiler="${AFFINESCRIPT:-affinescript}"
if ! command -v "$compiler" >/dev/null 2>&1; then
  printf 'MISSING_TOOLCHAIN: AffineScript compiler not found: %s\n' "$compiler" >&2
  printf 'Set AFFINESCRIPT to a pinned affinescript executable (A1 uses v0.1.1).\n' >&2
  exit 2
fi
compiler="$(command -v "$compiler")"
if [[ "$compiler" != /* ]]; then
  compiler="$(cd "$(dirname "$compiler")" && pwd)/$(basename "$compiler")"
fi

stdlib="${AFFINESCRIPT_STDLIB:-./stdlib}"
if [ ! -f "$stdlib/prelude.affine" ]; then
  printf 'MISSING_TOOLCHAIN: AffineScript standard library not found: %s\n' "$stdlib" >&2
  printf 'Set AFFINESCRIPT_STDLIB to the pinned v0.1.1 stdlib directory.\n' >&2
  exit 2
fi
stdlib="$(cd "$stdlib" && pwd)"
export AFFINESCRIPT_STDLIB="$stdlib"

if ! version_output="$("$compiler" --version 2>&1)"; then
  printf 'TOOLCHAIN_ERROR: %s --version failed:\n%s\n' "$compiler" "$version_output" >&2
  exit 2
fi
printf 'TOOLCHAIN %s\n' "$version_output"
printf 'NOTICE: A1 census only; completion is not a build or test PASS.\n'

emit_notice() {
  [ "${A1_ANNOTATIONS:-0}" = "1" ] || return 0
  local title="$1"
  local message="$2"
  title="${title//'%'/'%25'}"
  message="${message//'%'/'%25'}"
  message="${message//$'\r'/'%0D'}"
  message="${message//$'\n'/'%0A'}"
  printf '::notice title=%s::%s\n' "$title" "$message"
}

emit_notice 'A1 toolchain' "$version_output (census only; not a build/test PASS)"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

one_line() {
  # Keep the TSV-like evidence on one line without losing later diagnostics:
  # failures are also printed verbatim by probe().
  tr '\n\t' '  ' | sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//'
}

probe_evidence=''
probe() {
  local name="$1"
  local source="$2"
  local file="$work/$name.affine"
  local mode output rc diagnostic
  local evidence=''

  printf '%s' "$source" > "$file"
  for mode in parse check; do
    output="$work/$name.$mode.out"
    set +e
    "$compiler" "$mode" "$file" > "$output" 2>&1
    rc=$?
    set -e
    if [ "$mode" = "parse" ] && [ "$rc" -eq 0 ]; then
      diagnostic='accepted'
    else
      diagnostic="$(one_line < "$output")"
    fi
    printf 'PROBE %-30s %-5s rc=%d %s\n' "$name" "$mode" "$rc" "${diagnostic:--}"
    evidence+="$mode rc=$rc ${diagnostic:--}"$'\n'
    if [ "$rc" -ne 0 ]; then
      sed 's/^/  | /' "$output"
    fi
  done
  probe_evidence+="$name"$'\n'"$evidence"
}

# Smallest accepted candidates, then one grammar delta at a time. Parse and
# check are separate because an accepted grammar can still fail resolution,
# typing, borrow checking, or quantity checking.
probe empty ''
probe module_only 'module A1;'
probe minimal_function 'module A1;
pub fn answer() -> Int { 42 }'
probe module_missing_semicolon 'module A1'
probe module_multisegment 'module Kyaml.Ast;'
probe legacy_import 'module A1;
import prelude;'
probe use_list 'module A1;
use prelude::{ Option, Some, None };'
probe option_bracket_type 'module A1;
pub type MaybeInt = Option[Int]'
probe option_constructors 'module A1;
pub fn some() -> Option[Int] { Some(42) }
pub fn none() -> Option[Int] { None }'
probe imported_option_constructors 'module A1;
use prelude::{ Option, Some, None };
pub fn some() -> Option[Int] { Some(42) }
pub fn none() -> Option[Int] { None }'
probe qualified_three_segment_type 'module A1;
pub type Qualified = A.B.C'
probe record_literal 'module A1;
pub struct Point { x: Int }
pub fn origin() -> Point { #{ x: 0 } }'
probe assoc_list_type 'module A1;
pub type Pairs = [(String, Int)]'
probe legacy_map_type 'module A1;
pub type Pairs = {}String -> Int'
probe inline_enum_trailing_comma 'module A1;
pub type E = A | B,'
probe braced_enum_trailing_comma 'module A1;
pub enum E { A, B, }'
probe variant_named_string 'module A1;
pub type E = String | Other'
probe variant_named_int 'module A1;
pub type E = Int | Other'
probe mut_param 'module A1;
fn identity(mut value: Int) -> Int { value }'
probe legacy_ref_mut_param 'module A1;
fn identity(&mut value: Int) -> Int { value }'
probe while_break 'module A1;
fn stop() -> Unit { while true { break; } }'
probe while_continue 'module A1;
fn again() -> Unit { while true { continue; } }'
probe if_let 'module A1;
fn unwrap(value: Int) -> Int { if let Some(x) = value { x } else { 0 } }'
probe match_instead 'module A1;
fn unwrap(value: Int) -> Int { match value { x => x } }'
emit_notice 'A1 grammar census' "$probe_evidence"

printf '\nSOURCE CENSUS (affinescript check; every tracked .affine file)\n'
source_count=0
source_failures=0
source_evidence=''
while IFS= read -r file; do
  [ -n "$file" ] || continue
  source_count=$((source_count + 1))
  output="$work/source.$source_count.out"
  if [[ "$file" == src/* ]]; then
    source_path="${file#src/}"
  else
    source_path="../$file"
  fi
  set +e
  (cd src && "$compiler" check "$source_path") > "$output" 2>&1
  rc=$?
  set -e
  diagnostic="$(one_line < "$output")"
  printf 'SOURCE %-45s rc=%d %s\n' "$file" "$rc" "${diagnostic:--}"
  source_evidence+="$file check rc=$rc ${diagnostic:--}"$'\n'
  if [ "$rc" -ne 0 ]; then
    source_failures=$((source_failures + 1))
    sed 's/^/  | /' "$output"
  fi
done < <(git ls-files '*.affine' | LC_ALL=C sort)

printf 'A1_CENSUS_COMPLETE sources=%d source_failures=%d (not a build or test PASS)\n' \
  "$source_count" "$source_failures"
emit_notice 'A1 source census' \
  "$source_evidence"$'A1_CENSUS_COMPLETE sources='"$source_count"$' source_failures='"$source_failures"$' (not a build or test PASS)'
