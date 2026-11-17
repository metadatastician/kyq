{-# OPTIONS --safe --without-K --cubical-compatible #-}
-- SPDX-License-Identifier: MPL-2.0
-- Negative control: MUST FAIL.  Hypothesis ablation for isort-unique:
-- "the same members sort to the same list", without the distinct-name
-- hypotheses (JCS-1).  It is false (KyqUnique.no-unique-without-distinct);
-- reusing the isort-unique proof with the DistinctKeys arguments
-- discharged trivially is refused.
module IsortUniqueNoDistinct (Num : Set) where
open import KyqPrelude
open import KyqValue Num
open import KyqUnique Num
bad : ∀ xs ys → SameEl xs ys → isort xs ≡ isort ys
bad xs ys s = isort-unique xs ys s tt tt
