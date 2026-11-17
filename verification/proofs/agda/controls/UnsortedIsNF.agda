{-# OPTIONS --safe --without-K --cubical-compatible #-}
-- SPDX-License-Identifier: MPL-2.0
-- Negative control: MUST FAIL.  An object whose names are out of UTF-16
-- order ("\u0001" before "\u0000") is not a normal form.
module UnsortedIsNF (Num : Set) where
open import KyqPrelude
open import KyqValue Num
bad : NF (obj ((suc zero ∷ [] , null) ∷ (zero ∷ [] , null) ∷ []))
bad = (tt , tt , tt) , refl , tt
