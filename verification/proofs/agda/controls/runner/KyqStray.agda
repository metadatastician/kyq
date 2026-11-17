{-# OPTIONS --safe --without-K --cubical-compatible #-}
-- SPDX-License-Identifier: MPL-2.0
-- Runner control: MUST BE REJECTED BY THE RUNNER.  A spine module that
-- All.agda does not import is never typechecked.  run-proofs.sh copies
-- this file into a scratch copy of the spine and requires both coverage
-- checks (All.agda's imports, and Agda's --dependency-graph cone) to
-- flag it.  Its content is false on purpose.
module KyqStray where
open import KyqPrelude
bad : true ≡ false
bad = refl
