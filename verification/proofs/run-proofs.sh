#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
#
# Runs the kyq proof spine (P1) and its negative controls, failing loudly.
#
#   run-proofs.sh agda   Agda leg + Agda negative controls
#   run-proofs.sh rocq   Rocq leg + Rocq negative controls
#   run-proofs.sh lean   Lean leg (none exists yet: always exits 3, OPEN)
#   run-proofs.sh all    every leg; exits non-zero while any leg fails or is OPEN
#
# Exit codes: 0 every requested leg passed; 1 a leg or control failed;
# 2 a toolchain is missing or not the asserted version; 3 a leg is OPEN.
#
# Versions are asserted, never assumed (PROOF-POLICY §6).  The Agda default
# is the estate Guix pin (2.7.0.1).  Rocq has no Guix pin for kyq yet
# (deviation DEV-2), so every Rocq run prints that deviation.  A run on
# another Agda version must name it explicitly, which is recorded as a
# deviation in docs/status/PROOF-STATUS.adoc:
#   KYQ_AGDA_VERSION=2.6.3 verification/proofs/run-proofs.sh agda
#
# What the Agda leg checks, beyond "agda accepts All.agda":
#   * coverage: every ./*.agda is imported by All.agda, and the import cone
#     Agda reports (--dependency-graph) is exactly All, the local modules
#     and the prover-supplied modules; a stray module fails the leg
#   * escape hatches: a lexing scan (agda-lex.awk: comments, strings,
#     character literals and pragma bodies as Agda lexes them) finds no
#     postulate, primitive, primTrustMe or primEraseEquality, and no pragma
#     beyond an exact allowlist
#   * prover trusted base (§8.4 rule 7): the postulates of the
#     prover-supplied modules in the cone are exactly Level, lzero, lsuc and
#     _⊔_, bound by BUILTIN LEVEL, LEVELZERO, LEVELSUC and LEVELMAX
#   * every scanner and coverage check is run on a planted control first,
#     with the same function, and must flag it
set -euo pipefail
shopt -s inherit_errexit   # a failure inside $(...) fails the assignment
export LC_ALL=C.UTF-8   # Agda aborts on the sources' UTF-8 without it

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
lexer="$here/agda-lex.awk"
AGDA_FLAGS=(--safe --without-K --cubical-compatible --no-libraries)
want_agda="${KYQ_AGDA_VERSION:-2.7.0.1}"
want_coq="${KYQ_COQ_VERSION:-8.18.0}"
pin_agda="2.7.0.1"

# The Rocq leg's sources, compiled in this order.  Any other .v in rocq/
# fails the leg.
rocq_sources="KyqSpine.v"

# The pragmas the spine may contain, exactly.
agda_pragma_allow=$'OPTIONS --safe --without-K --cubical-compatible
BUILTIN EQUALITY _≡_
BUILTIN NATURAL ℕ'

# The prover's trusted base in the cone: postulated name, then its binding.
# A prover pin bump that changes this list must re-earn the receipt.
prover_postulates=$'Level LEVEL
_⊔_ LEVELMAX
lsuc LEVELSUC
lzero LEVELZERO'

fail() { echo "FAIL: $*" >&2; exit 1; }
tool() { echo "TOOLCHAIN: $*" >&2; exit 2; }

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

lex() {  # lex MODE FILE: FILE:LINE:TEXT (code) or FILE:LINE:BODY (pragma)
  LC_ALL=C awk -v mode="$1" -v fname="$2" -f "$lexer" "$2" \
    || fail "agda-lex.awk could not lex $2"
}

agda_hatches() {  # every escape hatch in code (comments and strings excluded)
  local f t
  for f in "$@"; do
    t="$(lex code "$f")"
    printf '%s\n' "$t" | grep -E \
      ':[0-9]+:(.*[[:space:](){};])?(postulate|primitive|primTrustMe|primEraseEquality)([[:space:](){};]|$)' \
      || true
  done
}

agda_bad_pragmas() {  # every pragma not on the allowlist
  local f t
  for f in "$@"; do
    t="$(lex pragma "$f")"
    [ -n "$t" ] || continue
    printf '%s\n' "$t" | while IFS= read -r l; do
      body="${l#*:}"; body="${body#*:}"
      printf '%s\n' "$agda_pragma_allow" | grep -qxF -- "$body" || printf '%s\n' "$l"
    done
  done
}

agda_static_coverage() {  # $1 dir: modules on disk vs modules All.agda imports
  local dir="$1" files imports
  files="$(cd "$dir" && ls -1 ./*.agda | sed 's|^\./||; s|\.agda$||' | grep -vx All | LC_ALL=C sort)"
  imports="$(lex code "$dir/All.agda" | cut -d: -f3- \
    | sed -n 's/^[[:space:]]*\(open[[:space:]]\{1,\}\)\{0,1\}import[[:space:]]\{1,\}\([^[:space:]]\{1,\}\).*/\2/p' \
    | LC_ALL=C sort -u)"
  diff <(printf '%s\n' "$files") <(printf '%s\n' "$imports") \
    | sed -n 's/^< /not imported by All.agda: /p; s/^> /imported but not on disk: /p' || true
}

cone_modules() { sed -n 's/.*\[label="\([^"]*\)"\].*/\1/p' "$1" | LC_ALL=C sort -u; }

agda_cone_coverage() {  # $1 dependency graph, $2 dir: cone vs local modules
  local graph="$1" dir="$2" local_mods cone m
  local_mods="$(cd "$dir" && ls -1 ./*.agda | sed 's|^\./||; s|\.agda$||' | LC_ALL=C sort)"
  cone="$(cone_modules "$graph")"
  [ -n "$cone" ] || { echo "empty import cone in $graph"; return; }
  for m in $local_mods; do
    grep -qxF -- "$m" <<< "$cone" || echo "on disk but not in Agda's import cone: $m"
  done
}

prover_modules() {  # $1 graph, $2 dir: cone modules with no local source
  local m
  cone_modules "$1" | while IFS= read -r m; do
    [ -f "$2/$m.agda" ] || printf '%s\n' "$m"
  done
}

postulate_bindings() {  # FILE: "name BUILTIN" for each postulated name ('-' if unbound)
  local f="$1" names
  names="$(lex code "$f" | cut -d: -f3- | awk '
    function ind(s) { match(s, /^ */); return RLENGTH }
    function take(s,  k, a) { sub(/:.*/, "", s); k = split(s, a, /[ \t]+/); for (q = 1; q <= k; q++) if (a[q] != "") print a[q] }
    /^[ \t]*$/ { next }
    { i = ind($0) }
    inb && i <= i0 { inb = 0 }
    inb && di < 0 { di = i }
    inb && i == di && index($0, ":") { take($0); next }
    inb { next }
    /^[ \t]*postulate([ \t]|$)/ {
      inb = 1; i0 = i; di = -1
      rest = $0; sub(/^[ \t]*postulate[ \t]*/, "", rest)
      if (rest != "" && index(rest, ":")) { take(rest); inb = 0 }
    }')"
  local n b
  for n in $names; do
    b="$(lex pragma "$f" | cut -d: -f3- | awk -v n="$n" '$1 == "BUILTIN" && $3 == n { print $2 }' | head -n1)"
    printf '%s %s\n' "$n" "${b:--}"
  done | LC_ALL=C sort
}

# file<TAB>expected substring of the checker's refusal
agda_controls=$'PlantedPostulate.agda\tCannot postulate cheat with safe flag
PlantedTerminating.agda\tCannot use TERMINATING pragma with safe flag
KInForce.agda\tbecause K has
UnsortedIsNF.agda\tfalse != true of type Bool
MalleableCheck.agda\tb != canon b of type Value
IsortUniqueNoDistinct.agda\t⊤ !=< (DistinctKeys xs)
CanonRespNoWF.agda\t⊤ !=< (WF v)
TvSoundValidity.agda\t(InDom o → check o ≡ true) should be a
LargeFloatClosed.agda\tnothing != just 4'

rocq_controls=$'UnsortedIsFixed.v\tUnable to unify
OneArgCanonOfInput.v\tUnable to unify "canon nat i" with "VNull nat"'

run_controls() {  # $1 dir, $2 table, $3 command prefix (string), $4 extension
  local dir="$1" table="$2" cmd="$3" ext="$4" n=0 listed on_disk f want out rc
  listed="$(printf '%s\n' "$table" | cut -f1 | LC_ALL=C sort)"
  on_disk="$(cd "$dir" && ls -1 ./*."$ext" | sed 's|^\./||' | LC_ALL=C sort)"
  [ "$listed" = "$on_disk" ] || fail "controls in $dir differ from the table in run-proofs.sh"
  while IFS=$'\t' read -r f want; do
    set +e
    out="$(cd "$dir/.." && $cmd "controls/$f" 2>&1)"; rc=$?
    set -e
    [ "$rc" -ne 0 ] || fail "negative control $f was ACCEPTED (it must be refused)"
    printf '%s' "$out" | grep -qF -- "$want" \
      || fail "negative control $f failed, but not with \"$want\":"$'\n'"$out"
    echo "  refused as expected: controls/$f  ($want)"
    n=$((n + 1))
  done <<< "$table"
  echo "  controls refused: $n/$n"
}

leg_agda() {
  command -v agda >/dev/null || tool "agda not found on PATH"
  local got; got="$(agda --version | sed -n 's/^Agda version \([^ ]*\).*/\1/p')"
  echo "== Agda leg: agda $got (asserted $want_agda; estate Guix pin $pin_agda)"
  [ "$got" = "$want_agda" ] || tool "agda is $got, asserted $want_agda (set KYQ_AGDA_VERSION and record a deviation)"
  [ "$got" = "$pin_agda" ] || echo "  DEVIATION: DEV-1: Agda $got is not the Guix pin $pin_agda (PROOF-STATUS)"
  cd "$here/agda"
  find . -name '*.agdai' -delete; rm -rf _build

  # Scanner self-tests: each scanner must flag its planted control, and the
  # lexer must not be fooled by decoys in comments and strings.
  [ -n "$(agda_hatches controls/PlantedPostulate.agda)" ] || fail "escape-hatch scanner missed controls/PlantedPostulate.agda"
  [ -n "$(agda_hatches controls/runner/LexHidden.agda)" ] || fail "escape-hatch scanner missed controls/runner/LexHidden.agda"
  local decoys; decoys="$(agda_hatches controls/runner/LexDecoys.agda)"
  [ -z "$decoys" ] || fail "escape-hatch scanner flagged a decoy in controls/runner/LexDecoys.agda:"$'\n'"$decoys"
  [ -n "$(agda_bad_pragmas controls/PlantedTerminating.agda)" ] || fail "pragma scanner missed controls/PlantedTerminating.agda"
  [ "$(postulate_bindings controls/PlantedPostulate.agda)" = "cheat -" ] || fail "postulate extraction missed controls/PlantedPostulate.agda"
  local stray="$scratch/stray"
  mkdir -p "$stray"; cp ./*.agda controls/runner/KyqStray.agda "$stray/"
  [ -n "$(agda_static_coverage "$stray")" ] || fail "static coverage check missed controls/runner/KyqStray.agda"
  echo "  scanner self-tests: 5/5 planted controls flagged, 0 decoys flagged"

  # The spine itself.
  local hits
  hits="$(agda_hatches ./*.agda)"
  [ -z "$hits" ] || fail "escape hatch in the Agda spine:"$'\n'"$hits"
  hits="$(agda_bad_pragmas ./*.agda)"
  [ -z "$hits" ] || fail "unexpected pragma in the Agda spine:"$'\n'"$hits"
  for f in ./*.agda; do
    head -n1 "$f" | grep -qxF '{-# OPTIONS --safe --without-K --cubical-compatible #-}' \
      || fail "$f does not start with the canonical OPTIONS pragma"
  done
  hits="$(agda_static_coverage .)"
  [ -z "$hits" ] || fail "All.agda does not cover the spine:"$'\n'"$hits"
  echo "  development postulates: 0; escape-hatch pragmas: 0; every ./*.agda imported by All.agda"

  local out graph="$scratch/cone.dot"
  out="$(agda "${AGDA_FLAGS[@]}" --dependency-graph="$graph" All.agda 2>&1)" || fail "agda rejected the spine:"$'\n'"$out"
  printf '%s\n' "$out" | sed 's/^/  /'
  printf '%s' "$out" | grep -q 'warnings encountered' && fail "agda reported warnings"
  echo "  agda ${AGDA_FLAGS[*]} All.agda: exit 0, no warnings"

  # Coverage against the cone Agda actually checked, self-tested first.
  [ -n "$(agda_cone_coverage "$graph" "$stray")" ] || fail "cone coverage check missed controls/runner/KyqStray.agda"
  hits="$(agda_cone_coverage "$graph" .)"
  [ -z "$hits" ] || fail "modules outside Agda's import cone:"$'\n'"$hits"
  local prov; prov="$(prover_modules "$graph" .)"
  echo "  import cone: $(cone_modules "$graph" | wc -l) modules; prover-supplied: $(printf '%s' "$prov" | tr '\n' ' ')"

  # The prover's trusted base: exact postulate list with bindings.
  local primdir m src got_list
  primdir="$(agda --print-agda-dir)/lib/prim"
  got_list="$(for m in $prov; do
      src="$primdir/$(printf '%s' "$m" | tr . /).agda"
      [ -f "$src" ] || fail "prover-supplied module $m: no source at $src"
      hits="$(agda_bad_pragmas "$src" | grep -v ':BUILTIN \|:OPTIONS ' || true)"
      [ -z "$hits" ] || fail "unexpected pragma in prover module $m:"$'\n'"$hits"
      postulate_bindings "$src"
    done | LC_ALL=C sort)"
  [ "$got_list" = "$prover_postulates" ] \
    || fail "prover-supplied postulates differ from the recorded trusted base:"$'\n'"got:"$'\n'"$got_list"$'\n'"want:"$'\n'"$prover_postulates"
  echo "  prover trusted base: $(printf '%s\n' "$got_list" | wc -l | tr -d ' ') named ($(printf '%s' "$got_list" | tr ' \n' '/,' )); Agda.Primitive sha256 $(sha256sum "$primdir/Agda/Primitive.agda" | cut -c1-16)…"

  run_controls "$here/agda/controls" "$agda_controls" "agda ${AGDA_FLAGS[*]} -i . -i controls" agda
  find . -name '*.agdai' -delete
  echo "PASS: Agda leg"
}

rocq_source_set() {  # $1 dir: .v files that are not the declared sources
  local on_disk
  on_disk="$(cd "$1" && ls -1 ./*.v | sed 's|^\./||' | LC_ALL=C sort)"
  [ "$on_disk" = "$(printf '%s\n' $rocq_sources | LC_ALL=C sort)" ] || echo "rocq sources on disk: $on_disk; declared: $rocq_sources"
}

leg_rocq() {
  command -v coqc >/dev/null || tool "coqc not found on PATH"
  local got; got="$(coqc --version | sed -n 's/.*version \([0-9.]*\).*/\1/p' | head -n1)"
  echo "== Rocq leg: coqc $got (asserted $want_coq)"
  [ "$got" = "$want_coq" ] || tool "coqc is $got, asserted $want_coq (set KYQ_COQ_VERSION and record a deviation)"
  echo "  DEVIATION: DEV-2: coqc $got is not a Guix pin; kyq has no Guix Rocq pin yet (PROOF-STATUS)"
  cd "$here/rocq"
  rm -f ./*.vo ./*.vok ./*.vos ./*.glob ./.*.aux controls/*.vo controls/*.vok controls/*.vos controls/*.glob
  local stray="$scratch/rocq-stray"
  mkdir -p "$stray"; cp ./*.v controls/runner/Stray.v "$stray/"
  [ -n "$(rocq_source_set "$stray")" ] || fail "Rocq source-set check missed controls/runner/Stray.v"
  echo "  source-set self-test: controls/runner/Stray.v flagged"
  local hits
  hits="$(rocq_source_set .)"
  [ -z "$hits" ] || fail "uncompiled .v file in the Rocq leg: $hits"
  hits="$(grep -nwE 'Admitted|admit|Axiom|Axioms|Parameter|Parameters|Conjecture' ./*.v || true)"
  [ -z "$hits" ] || fail "escape hatch in the Rocq leg:"$'\n'"$hits"
  local out="" one s asked closed
  for s in $rocq_sources; do
    one="$(coqc -R . KyqProofs "$s" 2>&1)" || fail "coqc rejected $s:"$'\n'"$one"
    out="$out$one"$'\n'
  done
  asked="$(cat $rocq_sources | grep -c '^Print Assumptions ')"
  closed="$(printf '%s\n' "$out" | grep -c '^Closed under the global context$' || true)"
  [ "$asked" -gt 0 ] && [ "$asked" = "$closed" ] \
    || fail "Print Assumptions: $closed of $asked theorems closed under the global context:"$'\n'"$out"
  echo "  coqc -R . KyqProofs $rocq_sources: exit 0; $closed/$asked theorems closed under the global context"
  run_controls "$here/rocq/controls" "$rocq_controls" "coqc -R . KyqProofs" v
  rm -f ./*.vo ./*.vok ./*.vos ./*.glob ./.*.aux ./.lia.cache controls/*.glob controls/.*.aux
  echo "PASS: Rocq leg (re-proved, BRIDGE-PENDING: not counted towards a grade)"
}

leg_lean() {
  echo "== Lean leg"
  if ls "$here"/lean/*.lean >/dev/null 2>&1; then
    fail "Lean sources exist but this runner has no Lean leg wired yet"
  fi
  echo "OPEN: no Lean leg exists (no Lean toolchain could be installed; see docs/status/PROOF-STATUS.adoc)" >&2
  return 3
}

case "${1:-all}" in
  agda) leg_agda ;;
  rocq) leg_rocq ;;
  lean) leg_lean ;;
  all)
    ( leg_agda )
    ( leg_rocq )
    rc=0; ( leg_lean ) || rc=$?
    if [ "$rc" -ne 0 ]; then
      echo "RESULT: Agda and Rocq legs passed; the Lean leg is OPEN, so the spine is not fully rechecked (exit $rc)" >&2
      exit "$rc"
    fi
    echo "RESULT: every leg passed" ;;
  *) echo "usage: $0 agda|rocq|lean|all" >&2; exit 64 ;;
esac
