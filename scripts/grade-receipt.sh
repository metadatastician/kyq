#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
# SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell (hyperpolymath)
#
# grade-receipt.sh: kyq's proof receipt (PROOF-POLICY §8.5; ULTRAPLAN §12 P3).
#
# It fetches the four shared standards files at one pinned commit, checks
# their SHA-256, defines kyq's data and hooks, and hands over to the shared
# generator. The grade is never typed here: the generator derives it, and
# the pinned reader derives it again.
#
#   bash scripts/grade-receipt.sh --check    regenerate, compare, git checks,
#                                            reader and its negative control
#   bash scripts/grade-receipt.sh --write    write the receipt from the ledger
#   bash scripts/grade-receipt.sh --digest agda | --inputs agda
#   bash scripts/grade-receipt.sh --run-row agda --run URL --commit SHA \
#        --checker TEXT --reported TEXT --axioms none
#
# Run it from a full (not shallow) clone with origin/main fetched.
# KYQ_RECEIPT_STD may name a directory that already holds the four files in
# the standards layout; they are checked against the pins all the same.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

STANDARDS_REPO="hyperpolymath/standards"
STANDARDS_COMMIT="745fc744158047a675eeb92464167c9961d66c4b"
# path  sha256, at STANDARDS_COMMIT.
STANDARDS_FILES=$'1-formats/deed/tools/deed_lint.js aece22bf20d6e112e633efd288ed5d145012e85822d6b3ebea916c91c513acb9
scripts/proof-receipt.sh e54a8ccc5399d1c81a4f60a01c354ddb6df3cfae31f87d0c6c3d91e3e4623a4d
scripts/check-proof-receipt.sh f2375747238464535d1b4a61f658f07cb2f8504c69bfb1812311c79429a4e23e
scripts/proof-inputs-sha256.sh dfc6dde01a3a79df638eebe4cad0eae584d8f17280077e149174c0667e9508f4'

std="${KYQ_RECEIPT_STD:-target/receipt-std/$STANDARDS_COMMIT}"
while read -r path want; do
  f="$std/$path"
  if [[ ! -f "$f" ]]; then
    mkdir -p "$(dirname "$f")"
    curl -fsSL --proto '=https' --retry 3 -o "$f.part" \
      "https://raw.githubusercontent.com/$STANDARDS_REPO/$STANDARDS_COMMIT/$path" \
      || { rm -f "$f.part"; echo "ERROR: cannot fetch $path at $STANDARDS_COMMIT" >&2; exit 2; }
    mv -f "$f.part" "$f"
  fi
  got="$(sha256sum "$f" | cut -d' ' -f1)"
  [[ "$got" == "$want" ]] || { echo "ERROR: $path is $got, pinned $want" >&2; exit 1; }
done <<< "$STANDARDS_FILES"

RECEIPT_STD="$(cd "$std" && pwd)"
RECEIPT_STANDARDS_COMMIT="$STANDARDS_COMMIT"
RECEIPT_OUT="verification/receipts/kyq-spine_praxis.deed"
RECEIPT_LEDGER="verification/receipts/runs.ledger"
RECEIPT_REPOSITORY="metadatastician/kyq"
RECEIPT_DEFAULT_BRANCH="main"
RECEIPT_CANONICAL_NAME="kyq-spine-proof-receipt"
RECEIPT_SCRIPT="scripts/grade-receipt.sh"

AGDA_DIR="verification/proofs/agda"
STATUS_FILE="docs/status/PROOF-STATUS.adoc"

# The Agda theorems the Rocq leg re-proves (KyqSpine.v). Each is re-proved
# with no axioms (coqchk -o), but its statement is not yet reconciled with
# the Agda one, so it is BRIDGE-PENDING and counts toward no grade.
ROCQ_REPROVED="leq-total leq-antisym leq-trans canon-nf nf-fixed canon-idem
sorted-unique isort-unique no-unique-without-distinct canon-resp nf-unique
tv-sound tv-complete tv-iff one-arg-not-tv"

# One claim per Agda theorem of the census (PROOF-STATUS "Claims"), by module.
THEOREMS="leq-total leq-antisym leq-trans
canon-nf nf-fixed canon-idem nf-covered image-nf isort-perm canon-not-id
sorted-unique isort-unique no-unique-without-distinct
canon-resp canon-resp-needs-wf nf-unique canon-wf ~-canon ker-sound ker-canon
canon-measure canon-depth canon-nodes canon-bytes verdict-canon within-canon
depth-scalar depth-empty depth-leaf-free depth-nested nodes-keys-excluded bytes-keys-included
tv-sound tv-complete tv-iff closure c-resp roundtrip≈ canonical-gate-valid
ref-nonmalleable ref-complete gate-closure
free-≈-trivial roundtrip-upto upto-lossless sem-roundtrip
roundtrip-compose covered-compose faithful-compose
model-normidem model-roundtrip model-nonmalleable model-complete model-tv
loose-validity loose-not-nonmalleable covered-not-enough validity-not-tv-sound
one-arg-not-tv
model-separates coarse-gate coarse-rt coarse-idem coarse-norm-faithful coarse-not-separating drop-not-faithful
wrap-roundtrip wrap-covered-image wrap-not-covered covered-vacuous
hole-breaks-rt r3-rt r3-excludes-hole r3-maximal toy-old-not-closed toy-r3-closed
domR3B-sound domR3B-complete
value-rt value-rt-old-fails allnum-canon profile-roundtrip profile-closure old-closure-fails
allB-sound allB-complete profile-gate-closure
toy-gate toy-tv-in-dom toy-tv-refused toy-tv-outside-dom toy-check-noncanonical toy-check-canonical"

receipt_claims() {
  local id rocq
  for id in $THEOREMS; do
    if [[ " $(tr '\n' ' ' <<< "$ROCQ_REPROVED") " == *" $id "* ]]; then
      rocq='re-proved|BRIDGE-PENDING'
    else
      rocq='unavailable|n/a'
    fi
    printf '%s|proven|theorem|%s|unavailable|n/a|%s|%s\n' "$id" "$rocq" \
      'no Rocq re-proof of this theorem yet' 'no Lean leg yet: the Lean runner reports OPEN'
  done
}
receipt_echoes() { :; }
receipt_header() {
  printf '%s\n' \
    ';; SPDX-License-Identifier: MPL-2.0' \
    ';; SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell (hyperpolymath)' \
    ';; kyq proof receipt (PROOF-POLICY §8.5). Generated by scripts/grade-receipt.sh' \
    ';; from verification/receipts/runs.ledger: do not edit by hand. The grades are' \
    ';; derived, never typed. They cover the Agda theory spine, not the Rust code.'
}
# The prover-supplied module in the cone is Agda.Primitive. Its four
# postulates are the trusted base that verification/proofs/run-proofs.sh
# checks against Agda's own source on every run.
receipt_trusted_base() {
  printf '%s\n' \
    'Agda.Primitive|Level|BUILTIN LEVEL' \
    'Agda.Primitive|lzero|BUILTIN LEVELZERO' \
    'Agda.Primitive|lsuc|BUILTIN LEVELSUC' \
    'Agda.Primitive|_⊔_|BUILTIN LEVELMAX'
}
receipt_invocation() {
  case "$1" in
    agda) printf '%s\n' 'agda --safe --without-K --cubical-compatible --no-libraries All.agda' ;;
    rocq) printf '%s\n' 'coqc KyqSpine.v && coqchk -o' ;;
    lean) printf '%s\n' 'lean (no source yet)' ;;
    *) receipt_die "no invocation for $1" ;;
  esac
}
# What each leg reads: for Agda, All.agda and its import cone under the
# spine directory (run-proofs.sh checks this cone against Agda's own
# --dependency-graph).
receipt_inputs() {
  case "$1" in
    agda) receipt_agda_cone "$AGDA_DIR/All.agda" "$AGDA_DIR" ;;
    rocq) printf '%s\n' verification/proofs/rocq/KyqSpine.v ;;
    lean) receipt_die "the Lean leg has no inputs yet" ;;
    *) receipt_die "no inputs for $1" ;;
  esac
}
# The claim ids the proof-status file lists: the backquoted names in the
# first column of its Claims table.
receipt_status_ids() {
  awk '/^\| Agda result \(module\)/{f=1; next} f && /^\|===/{exit} f && /^\| `/' "$STATUS_FILE" \
    | awk -F' \\| ' '{print $1}' | sed 's/([^)]*)//g' | grep -o '`[^`]*`' | tr -d '`'
}
# No recheck leg is RECONCILED yet.
receipt_recorded_legs() { :; }

# shellcheck source=/dev/null
. "$RECEIPT_STD/scripts/proof-receipt.sh"
receipt_main "$@"
