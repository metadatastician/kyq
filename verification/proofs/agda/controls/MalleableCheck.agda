{-# OPTIONS --safe --without-K --cubical-compatible #-}
-- SPDX-License-Identifier: MPL-2.0
-- Negative control: MUST FAIL.  F-2: a check that accepts every parsable
-- text (a validity gate) is non-malleable.  It is false
-- (KyqModel.loose-not-nonmalleable); the obvious proof is refused where
-- it must show that an arbitrary text b is its own canonical text.
module MalleableCheck (Num : Set) where
open import KyqPrelude
open import KyqValue Num
open import KyqCodec
open import KyqModel Num
open Laws model
bad : NonMalleable checkLoose
bad b _ = b ,Σ (refl , tt , refl)
