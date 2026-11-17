{-# OPTIONS --safe --without-K --cubical-compatible #-}
-- SPDX-License-Identifier: MPL-2.0
-- Negative control: MUST FAIL.  Hypothesis ablation for tv-sound: the
-- same statement and proof term as KyqCodec.Laws.tv-sound, with
-- ValidityGate check in place of NonMalleable check.  The statement is
-- false (KyqModel.validity-not-tv-sound); the proof term is refused
-- where it uses non-malleability.
module TvSoundValidity where
open import KyqPrelude
open import KyqCodec

module _ (F : Format) where
  open Format F
  open Laws F

  bad : (check : Bytes → Bool) → ValidityGate check →
        ∀ i o vi → p i ≡ just vi → Dom vi →
        check o ≡ true → (Σ V (λ vo → (p o ≡ just vo) × (vo ≈ vi))) →
        o ≡ c vi
  bad check nm i o vi pi d ok (vo ,Σ (po , r)) with nm o ok
  ... | vo' ,Σ (po' , _ , e) =
    trans e (c-resp vo' vi (subst (λ x → x ≈ vi) (just-inj (trans (sym po) po')) r))
