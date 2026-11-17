{-# OPTIONS --safe --without-K --cubical-compatible #-}
-- SPDX-License-Identifier: MPL-2.0
-- Negative control: MUST FAIL.  Uniqueness of identity proofs (axiom K)
-- is not available under --without-K, so the flag is really in force.
module KInForce where
open import KyqPrelude
uip : {A : Set} {x : A} (p q : x ≡ x) → p ≡ q
uip refl refl = refl
