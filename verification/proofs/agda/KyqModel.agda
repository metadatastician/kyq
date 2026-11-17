{-# OPTIONS --safe --without-K --cubical-compatible #-}
-- SPDX-License-Identifier: MPL-2.0
--
-- A concrete instance of the codec layer over V_J, so that the
-- hypotheses of KyqCodec are shown satisfiable (non-vacuity), and
-- countermodels that show why each part of the corrected spine is
-- needed.  This witness is degenerate (total parser, Dom = ⊤); the one
-- with a partial parser and a proper Dom is KyqProfile's toy-gate.
--
-- The model: a "text" is a value tree in the order the producer wrote it
-- (Bytes := Value), p is total, print is the identity, norm is canon,
-- Dom is everything, and check is the decidable normal-form test isNF.
-- It models member order only: no escaping, numbers or bytes.
--
--   model-normidem, model-roundtrip, model-nonmalleable, model-complete
--   model-tv           : the two-argument TV theorem holds in the model
--   loose-not-nonmalleable : a check that accepts every parsable text is
--                        a validity gate and round-trips, yet is malleable (F-2)
--   covered-not-enough : RoundTrip≈ and Covered≈(img) hold for the identity
--                        crossing, while NonMalleable(check) fails (L2(a))
--   one-arg-not-tv     : "check out" alone does not give out ≡ c (p in) (L1)
--   validity-not-tv-sound : tv-sound fails with ValidityGate in place of
--                        NonMalleable (hypothesis ablation)
--   model-separates, coarse-*, coarse-norm-faithful, drop-not-faithful :
--                        a constant norm makes a document-dropping
--                        converter Faithful≈ (L2(c)); NormSeparates _~_
--                        holds for model and fails for coarse
--   wrap-*, covered-vacuous : Covered≈ fails for an embedding at img = ⊤,
--                        holds at the image of fwd, is vacuous at ⊥
module KyqModel (Num : Set) where

open import KyqPrelude
open import KyqOrder
open import KyqValue Num
open import KyqCodec
open import KyqRecursive Num using (_~_; ker-sound)

------------------------------------------------------------------------
-- Decidable normal forms.

sortedB : List Member → Bool
sortedB []           = true
sortedB (m ∷ [])     = true
sortedB (m ∷ n ∷ ns) = leq (fst m) (fst n) ∧ sortedB (n ∷ ns)

isNF  : Value → Bool
isNFL : List Value → Bool
isNFO : List Member → Bool

isNF null     = true
isNF (bool _) = true
isNF (num _)  = true
isNF (str _)  = true
isNF (arr vs) = isNFL vs
isNF (obj ms) = isNFO ms ∧ sortedB ms

isNFL []       = true
isNFL (v ∷ vs) = isNF v ∧ isNFL vs

isNFO []             = true
isNFO ((_ , v) ∷ ms) = isNF v ∧ isNFO ms

sortedB-sound : ∀ ms → sortedB ms ≡ true → Sorted ms
sortedB-sound []           _ = tt
sortedB-sound (m ∷ [])     _ = tt
sortedB-sound (m ∷ n ∷ ns) e =
  ∧-l (leq (fst m) (fst n)) _ e , sortedB-sound (n ∷ ns) (∧-r (leq (fst m) (fst n)) _ e)

sortedB-complete : ∀ ms → Sorted ms → sortedB ms ≡ true
sortedB-complete []           _       = refl
sortedB-complete (m ∷ [])     _       = refl
sortedB-complete (m ∷ n ∷ ns) (e , s) = ∧-i e (sortedB-complete (n ∷ ns) s)

isNF-sound  : ∀ v  → isNF v   ≡ true → NF v
isNFL-sound : ∀ vs → isNFL vs ≡ true → NFL vs
isNFO-sound : ∀ ms → isNFO ms ≡ true → NFO ms

isNF-sound null     _ = tt
isNF-sound (bool _) _ = tt
isNF-sound (num _)  _ = tt
isNF-sound (str _)  _ = tt
isNF-sound (arr vs) e = isNFL-sound vs e
isNF-sound (obj ms) e =
  isNFO-sound ms (∧-l (isNFO ms) _ e) , sortedB-sound ms (∧-r (isNFO ms) _ e)

isNFL-sound []       _ = tt
isNFL-sound (v ∷ vs) e = isNF-sound v (∧-l (isNF v) _ e) , isNFL-sound vs (∧-r (isNF v) _ e)

isNFO-sound []             _ = tt
isNFO-sound ((k , v) ∷ ms) e = isNF-sound v (∧-l (isNF v) _ e) , isNFO-sound ms (∧-r (isNF v) _ e)

isNF-complete  : ∀ v  → NF v   → isNF v   ≡ true
isNFL-complete : ∀ vs → NFL vs → isNFL vs ≡ true
isNFO-complete : ∀ ms → NFO ms → isNFO ms ≡ true

isNF-complete null     _       = refl
isNF-complete (bool _) _       = refl
isNF-complete (num _)  _       = refl
isNF-complete (str _)  _       = refl
isNF-complete (arr vs) n       = isNFL-complete vs n
isNF-complete (obj ms) (n , s) = ∧-i (isNFO-complete ms n) (sortedB-complete ms s)

isNFL-complete []       _        = refl
isNFL-complete (v ∷ vs) (n , ns) = ∧-i (isNF-complete v n) (isNFL-complete vs ns)

isNFO-complete []             _        = refl
isNFO-complete ((k , v) ∷ ms) (n , ns) = ∧-i (isNF-complete v n) (isNFO-complete ms ns)

------------------------------------------------------------------------
-- The model format.

model : Format
model = record
  { Bytes = Value ; V = Value ; p = just ; print = λ v → v
  ; norm = canon ; Dom = λ _ → ⊤ }

open Laws model

checkNF : Value → Bool
checkNF = isNF

model-normidem : NormIdem
model-normidem = canon-idem

model-roundtrip : RoundTrip
model-roundtrip v _ = refl

model-nonmalleable : NonMalleable checkNF
model-nonmalleable b ok = b ,Σ (refl , tt , sym (nf-fixed b (isNF-sound b ok)))

model-complete : Complete checkNF
model-complete v _ = isNF-complete (canon v) (canon-nf v)

model-tv : ∀ i o → TV checkNF i o ⇔ Σ Value (λ vi → (just i ≡ just vi) × ⊤ × (o ≡ c vi))
model-tv = tv-iff checkNF model-normidem model-roundtrip (model-nonmalleable , model-complete)

------------------------------------------------------------------------
-- Countermodels.

unsorted : Value
unsorted = obj ((suc zero ∷ [] , null) ∷ (zero ∷ [] , null) ∷ [])

unsorted-moved : ¬ (unsorted ≡ canon unsorted)
unsorted-moved ()

-- A check that accepts every parsable text.
checkLoose : Value → Bool
checkLoose _ = true

loose-validity : ValidityGate checkLoose
loose-validity b = (λ _ → b ,Σ (refl , tt)) , (λ _ → refl)

loose-not-nonmalleable : ¬ (NonMalleable checkLoose)
loose-not-nonmalleable nm with nm unsorted refl
... | v ,Σ (e , _ , u) = unsorted-moved (trans u (cong canon (sym (just-inj e))))

-- RoundTrip≈ and Covered≈(img) both hold for the identity crossing, yet
-- the check is malleable: Faithful≈ needs NonMalleable as a third part.
idX : Crossing model model
idX = record { fwd = λ v → v ; back = λ v → v }

module IdX = CrossingLaws idX

id-roundtrip : IdX.RoundTrip≈
id-roundtrip s _ = refl

id-covered : IdX.Covered≈ (λ _ → ⊤)
id-covered t _ = t ,Σ (tt , refl)

covered-not-enough : IdX.RoundTrip≈ × IdX.Covered≈ (λ _ → ⊤) × ¬ (NonMalleable checkLoose)
covered-not-enough = id-roundtrip , id-covered , loose-not-nonmalleable

-- The one-argument statement is not translation validation: a canonical
-- output need not be the canonical form of the input (a dropping
-- converter passes it).
one-arg-not-tv : ¬ (∀ i o → checkNF o ≡ true → o ≡ c i)
one-arg-not-tv h with h (obj ((zero ∷ [] , null) ∷ [])) null refl
... | ()

------------------------------------------------------------------------
-- norm must separate: a Format whose norm is constant meets every codec
-- law, and makes a converter that drops the whole document Faithful≈
-- (the verify-logic L2(c) hole, moved from the crossing into the Format).
-- NormSeparates against the independently defined _~_ rules it out.

model-separates : NormSeparates _~_
model-separates v w e = ker-sound v w e

isNull : Value → Bool
isNull null = true
isNull _    = false

isNull-sound : ∀ b → isNull b ≡ true → b ≡ null
isNull-sound null     _ = refl
isNull-sound (bool _) ()
isNull-sound (num _)  ()
isNull-sound (str _)  ()
isNull-sound (arr _)  ()
isNull-sound (obj _)  ()

coarse : Format
coarse = record
  { Bytes = Value ; V = Value ; p = just ; print = λ v → v
  ; norm = λ _ → null ; Dom = λ _ → ⊤ }

module Coarse = Laws coarse

coarse-gate : Coarse.CanonicalGate isNull
coarse-gate = (λ b ok → b ,Σ (refl , tt , isNull-sound b ok)) , (λ v _ → refl)

coarse-rt : Coarse.RoundTrip
coarse-rt v _ = refl

coarse-idem : Coarse.NormIdem
coarse-idem v = refl

-- A converter that throws the whole document away.
dropX : Crossing coarse model
dropX = record { fwd = λ _ → null ; back = λ _ → null }

module DropX = CrossingLaws dropX

coarse-norm-faithful : DropX.Faithful≈ (λ t → t ≡ null) checkNF
coarse-norm-faithful =
  (λ s _ → refl) , (λ { t refl → null ,Σ (tt , refl) }) , model-nonmalleable

coarse-not-separating : ¬ Coarse.NormSeparates _~_
coarse-not-separating ns = true≢false (ns (bool true) (bool false) refl)

-- With the separating norm of `model` as the source, the same converter
-- fails RoundTrip≈.
dropM : Crossing model model
dropM = record { fwd = λ _ → null ; back = λ _ → null }

module DropM = CrossingLaws dropM

drop-not-faithful : ¬ DropM.RoundTrip≈
drop-not-faithful rt with rt (bool true) tt
... | ()

------------------------------------------------------------------------
-- Covered≈ has content: an embedding into a larger target round-trips
-- but is not covered at img = ⊤.  (At img = ⊥ it is vacuous.)

unwrap : Value → Value
unwrap (arr (v ∷ [])) = v
unwrap _              = null

wrapX : Crossing model model
wrapX = record { fwd = λ v → arr (v ∷ []) ; back = unwrap }

module WrapX = CrossingLaws wrapX

wrap-roundtrip : WrapX.RoundTrip≈
wrap-roundtrip s _ = refl

wrap-covered-image : WrapX.Covered≈ (λ t → Σ Value (λ s → t ≡ arr (s ∷ [])))
wrap-covered-image t (s ,Σ e) = s ,Σ (tt , cong canon (sym e))

wrap-not-covered : ¬ WrapX.Covered≈ (λ _ → ⊤)
wrap-not-covered cov with cov null tt
... | s ,Σ (_ , ())

covered-vacuous : WrapX.Covered≈ (λ _ → ⊥)
covered-vacuous t ()

------------------------------------------------------------------------
-- Hypothesis ablation for tv-sound: a validity gate in place of
-- NonMalleable does not give o ≡ c (p i).

validity-not-tv-sound :
  ¬ (∀ (check : Value → Bool) → ValidityGate check →
       ∀ i o vi → just i ≡ just vi → ⊤ → check o ≡ true →
       Σ Value (λ vo → (just o ≡ just vo) × (vo ≈ vi)) → o ≡ c vi)
validity-not-tv-sound h =
  unsorted-moved (h checkLoose loose-validity unsorted unsorted unsorted refl tt refl
                    (unsorted ,Σ (refl , refl)))
