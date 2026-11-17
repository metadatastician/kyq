{-# OPTIONS --safe --without-K --cubical-compatible #-}
-- SPDX-License-Identifier: MPL-2.0
-- Negative control: MUST FAIL.  Hypothesis ablation for canon-resp:
-- recursive JCS-5(a) without well-formedness (distinct names at every
-- depth).  It is false (KyqRecursive.canon-resp-needs-wf); reusing the
-- canon-resp proof with the WF arguments discharged trivially is refused.
module CanonRespNoWF (Num : Set) where
open import KyqPrelude
open import KyqValue Num
open import KyqRecursive Num
bad : ∀ v w → v ~ w → canon v ≡ canon w
bad v w r = canon-resp v w tt tt r
