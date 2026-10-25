#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
#
# A2 compiler controls for docs/AFFINESCRIPT_STRICT_PORT.adoc.
# These are check-only controls, not build, test, runtime, or CLI evidence.

set -euo pipefail

compiler="${AFFINESCRIPT:-affinescript}"
if ! command -v "$compiler" >/dev/null 2>&1; then
  printf 'MISSING_TOOLCHAIN: AffineScript compiler not found: %s\n' "$compiler" >&2
  printf 'Set AFFINESCRIPT to the pinned v0.1.1 executable.\n' >&2
  exit 2
fi
compiler="$(command -v "$compiler")"
if [[ "$compiler" != /* ]]; then
  compiler="$(cd "$(dirname "$compiler")" && pwd)/$(basename "$compiler")"
fi

stdlib="${AFFINESCRIPT_STDLIB:-./stdlib}"
if [ ! -f "$stdlib/prelude.affine" ] || [ ! -f "$stdlib/dict.affine" ]; then
  printf 'MISSING_TOOLCHAIN: pinned AffineScript stdlib/dict not found: %s\n' "$stdlib" >&2
  exit 2
fi
stdlib="$(cd "$stdlib" && pwd)"
export AFFINESCRIPT_STDLIB="$stdlib"

if ! version_output="$("$compiler" --version 2>&1)"; then
  printf 'TOOLCHAIN_ERROR: %s --version failed:\n%s\n' "$compiler" "$version_output" >&2
  exit 2
fi
printf 'TOOLCHAIN %s\n' "$version_output"
printf 'NOTICE: A2 controls use check only; they are not build/test/runtime PASS.\n'

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

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/src"

# Positive and negative twins use the same module layout. The only semantic
# difference is the planted String result in an Int-typed imported function.
cat > "$work/src/A2GoodDependency.affine" <<'EOF'
module A2GoodDependency;
pub fn good() -> Int { 42 }
EOF
cat > "$work/src/A2GoodConsumer.affine" <<'EOF'
module A2GoodConsumer;
use A2GoodDependency::{good};
pub fn value() -> Int { good() }
EOF
cat > "$work/src/A2Dependency.affine" <<'EOF'
module A2Dependency;
pub fn bad() -> Int { "planted type error" }
EOF
cat > "$work/src/A2Consumer.affine" <<'EOF'
module A2Consumer;
use A2Dependency::{bad};
pub fn value() -> Int { bad() }
EOF

# The released stdlib already models a String-keyed dict as [(String, V)].
# Checking this consumer demonstrates the existing representation and typed
# empty/set/contains/get API; it does not execute the operations.
cat > "$work/src/A2Dict.affine" <<'EOF'
module A2Dict;
use dict::{empty, get, set, contains};
use prelude::{Option, Some, None};
pub fn lookup() -> Option[Int] {
  let d0: [(String, Int)] = empty();
  let d1 = set(d0, "answer", 42);
  if contains(d1, "answer") { get(d1, "answer") } else { None }
}
EOF

one_line() {
  tr '\n\t' '  ' | sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//'
}

control_evidence=''
control_count=0
control() {
  local name="$1"
  local expectation="$2"
  local file="$3"
  shift 3
  local output="$work/$name.out"
  local rc diagnostic required
  set +e
  (cd "$work/src" && "$compiler" check "$file") > "$output" 2>&1
  rc=$?
  set -e
  diagnostic="$(one_line < "$output")"
  printf 'CONTROL %-24s expect=%-4s rc=%d %s\n' \
    "$name" "$expectation" "$rc" "${diagnostic:--}"
  control_evidence+="$name expect=$expectation rc=$rc ${diagnostic:--}"$'\n'
  control_count=$((control_count + 1))
  # Emit before the fail-closed assertions so a failing control remains
  # visible even when the GitHub job-log blob cannot be retrieved.
  emit_notice "A2 control: $name" \
    "expect=$expectation rc=$rc ${diagnostic:--} (check-only; not build/test/runtime PASS)"

  if { [ "$expectation" = pass ] && [ "$rc" -ne 0 ]; } ||
     { [ "$expectation" = fail ] && [ "$rc" -eq 0 ]; }; then
    printf 'CONTROL_FAILED: unexpected exit status for %s\n' "$name" >&2
    sed 's/^/  | /' "$output" >&2
    exit 1
  fi
  for required in "$@"; do
    if [[ "$diagnostic" != *"$required"* ]]; then
      printf 'CONTROL_FAILED: %s diagnostic lacks %s\n' "$name" "$required" >&2
      sed 's/^/  | /' "$output" >&2
      exit 1
    fi
  done
}

# The bad consumer must fail inside the imported dependency, not merely at its
# own callsite. This proves check follows imports and rejects the planted type.
control imported_positive pass A2GoodConsumer.affine 'Type checking passed'
control imported_type_error fail A2Consumer.affine 'A2Dependency.affine' 'TypeMismatch'
control dict_association_list pass A2Dict.affine 'Type checking passed'

printf 'A2_CONTROLS_COMPLETE controls=%d (check-only; not build/test/runtime PASS)\n' \
  "$control_count"
emit_notice 'A2 compiler controls' \
  "$control_evidence"$'A2_CONTROLS_COMPLETE controls='"$control_count"$' (check-only; not build/test/runtime PASS)'
