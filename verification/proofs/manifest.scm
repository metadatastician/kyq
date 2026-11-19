;; SPDX-License-Identifier: MPL-2.0
;; manifest.scm — the provers and the tools verification/proofs/run-proofs.sh
;; calls. No agda-stdlib: the spine runs with --no-libraries and imports none.
;; lean4 is here for the Lean leg (step P7); no Lean source exists yet.
(specifications->manifest
 (list "bash" "coreutils" "grep" "sed" "gawk" "findutils"
       "agda" "coq" "lean4"))
