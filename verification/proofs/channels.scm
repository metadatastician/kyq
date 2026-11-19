;; SPDX-License-Identifier: MPL-2.0
;; channels.scm — the Guix revision of the proof toolchain (docs/ULTRAPLAN.adoc
;; §12, step P1). Reproduce the provers with:
;;
;;   guix time-machine -C verification/proofs/channels.scm -- \
;;     shell -m verification/proofs/manifest.scm
;;
;; The commit is the one hyperpolymath/mathesis pins in build/channels.scm
;; (its note of 2026-11-10: the Guix build farm evaluated this commit, so Guix
;; has a substitute for itself, and it gives Agda 2.7.0.1, Rocq 8.18.0 and
;; Lean 4.29.0). The proof workflow asserts those versions on every run. The
;; root channels.scm pins the build shell of the Rust tool and is separate.
(list (channel
       (name 'guix)
       (url "https://codeberg.org/guix/guix.git")
       (branch "master")
       (commit "8edb9da7052607f17f09007933275b43978fcf9d")
       (introduction
        (make-channel-introduction
         "9edb3f66fd807b096b48283debdcddccfea34bad"
         (openpgp-fingerprint
          "BBB0 2DDF 2CEA F6A8 0D1D  E643 A2A0 6DF2 A33A 54FA")))))
