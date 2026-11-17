{-# OPTIONS --safe --without-K --cubical-compatible #-}
-- SPDX-License-Identifier: MPL-2.0
--
-- Object member names as sequences of UTF-16 code units, and the
-- RFC 8785 §3.2.3 member order: lexicographic order on code units.
--
--   leq-total   : the order is total
--   leq-antisym : the order is antisymmetric
--   leq-trans   : the order is transitive
--
-- A code unit is modelled as a ℕ.  Nothing here says how UTF-8 input
-- becomes code units (that is a parser obligation, JCS-3/JCS-4 bytes).
module KyqOrder where

open import KyqPrelude

Unit16 : Set
Unit16 = ℕ

Key : Set
Key = List Unit16

data Ord : Set where
  lt eq gt : Ord

cmpN : ℕ → ℕ → Ord
cmpN zero    zero    = eq
cmpN zero    (suc _) = lt
cmpN (suc _) zero    = gt
cmpN (suc a) (suc b) = cmpN a b

flipO : Ord → Ord
flipO lt = gt
flipO eq = eq
flipO gt = lt

cmpN-flip : ∀ a b → cmpN b a ≡ flipO (cmpN a b)
cmpN-flip zero    zero    = refl
cmpN-flip zero    (suc _) = refl
cmpN-flip (suc _) zero    = refl
cmpN-flip (suc a) (suc b) = cmpN-flip a b

cmpN-refl : ∀ a → cmpN a a ≡ eq
cmpN-refl zero    = refl
cmpN-refl (suc a) = cmpN-refl a

cmpN-eq : ∀ a b → cmpN a b ≡ eq → a ≡ b
cmpN-eq zero    zero    _ = refl
cmpN-eq zero    (suc b) ()
cmpN-eq (suc a) zero    ()
cmpN-eq (suc a) (suc b) e = cong suc (cmpN-eq a b e)

cmpN-lt-trans : ∀ a b c → cmpN a b ≡ lt → cmpN b c ≡ lt → cmpN a c ≡ lt
cmpN-lt-trans zero    zero    _       () _
cmpN-lt-trans zero    (suc b) zero    _ ()
cmpN-lt-trans zero    (suc b) (suc c) _ _ = refl
cmpN-lt-trans (suc a) zero    _       () _
cmpN-lt-trans (suc a) (suc b) zero    _ ()
cmpN-lt-trans (suc a) (suc b) (suc c) p q = cmpN-lt-trans a b c p q

leq     : Key → Key → Bool
leqStep : Ord → Key → Key → Bool

leq []       _        = true
leq (_ ∷ _)  []       = false
leq (a ∷ as) (b ∷ bs) = leqStep (cmpN a b) as bs

leqStep lt _  _  = true
leqStep gt _  _  = false
leqStep eq as bs = leq as bs

------------------------------------------------------------------------
-- Totality

leq-total  : ∀ x y → leq x y ≡ false → leq y x ≡ true
total-step : ∀ o as bs → leqStep o as bs ≡ false → leqStep (flipO o) bs as ≡ true

leq-total []       y        ()
leq-total (a ∷ as) []       _ = refl
leq-total (a ∷ as) (b ∷ bs) e =
  subst (λ o → leqStep o bs as ≡ true) (sym (cmpN-flip a b))
        (total-step (cmpN a b) as bs e)

total-step lt _  _  ()
total-step gt _  _  _ = refl
total-step eq as bs e = leq-total as bs e

------------------------------------------------------------------------
-- Decomposing leqStep without `with` on a computed Ord.

data Step (o : Ord) : Set where
  is-lt : o ≡ lt → Step o
  is-eq : o ≡ eq → Step o
  is-gt : o ≡ gt → Step o

step : ∀ o → Step o
step lt = is-lt refl
step eq = is-eq refl
step gt = is-gt refl

leq-antisym : ∀ x y → leq x y ≡ true → leq y x ≡ true → x ≡ y
leq-antisym []       []       _ _ = refl
leq-antisym []       (b ∷ bs) _ ()
leq-antisym (a ∷ as) []       () _
leq-antisym (a ∷ as) (b ∷ bs) p q = go (step (cmpN a b)) p
           (subst (λ o → leqStep o bs as ≡ true) (cmpN-flip a b) q)
  where
  go : Step (cmpN a b) → leqStep (cmpN a b) as bs ≡ true →
       leqStep (flipO (cmpN a b)) bs as ≡ true → (a ∷ as) ≡ (b ∷ bs)
  go (is-lt e) _ q' = ⊥-elim (absurd-gt (subst (λ o → leqStep (flipO o) bs as ≡ true) e q'))
    where
    absurd-gt : leqStep gt bs as ≡ true → ⊥
    absurd-gt ()
  go (is-gt e) p' _ = ⊥-elim (absurd-gt (subst (λ o → leqStep o as bs ≡ true) e p'))
    where
    absurd-gt : leqStep gt as bs ≡ true → ⊥
    absurd-gt ()
  go (is-eq e) p' q' =
    cong₂ _∷_ (cmpN-eq a b e)
      (leq-antisym as bs (subst (λ o → leqStep o as bs ≡ true) e p')
                         (subst (λ o → leqStep (flipO o) bs as ≡ true) e q'))

leq-trans : ∀ x y z → leq x y ≡ true → leq y z ≡ true → leq x z ≡ true
leq-trans []       _        _        _  _  = refl
leq-trans (a ∷ as) []       _        () _
leq-trans (a ∷ as) (b ∷ bs) []       _  ()
leq-trans (a ∷ as) (b ∷ bs) (c ∷ cs) p  q  =
  go (step (cmpN a b)) (step (cmpN b c)) p q
  where
  go : Step (cmpN a b) → Step (cmpN b c) →
       leqStep (cmpN a b) as bs ≡ true → leqStep (cmpN b c) bs cs ≡ true →
       leqStep (cmpN a c) as cs ≡ true
  go (is-gt e) _ p' _ = ⊥-elim (no-gt (subst (λ o → leqStep o as bs ≡ true) e p'))
    where
    no-gt : leqStep gt as bs ≡ true → ⊥
    no-gt ()
  go _ (is-gt e) _ q' = ⊥-elim (no-gt (subst (λ o → leqStep o bs cs ≡ true) e q'))
    where
    no-gt : leqStep gt bs cs ≡ true → ⊥
    no-gt ()
  go (is-lt e1) (is-lt e2) _ _ =
    subst (λ o → leqStep o as cs ≡ true) (sym (cmpN-lt-trans a b c e1 e2)) refl
  go (is-lt e1) (is-eq e2) _ _ =
    subst (λ o → leqStep o as cs ≡ true)
          (sym (subst (λ c' → cmpN a c' ≡ lt) (cmpN-eq b c e2) e1)) refl
  go (is-eq e1) (is-lt e2) _ _ =
    subst (λ o → leqStep o as cs ≡ true)
          (sym (subst (λ a' → cmpN a' c ≡ lt) (sym (cmpN-eq a b e1)) e2)) refl
  go (is-eq e1) (is-eq e2) p' q' =
    subst (λ o → leqStep o as cs ≡ true)
          (sym (trans (cong (λ a' → cmpN a' c) (cmpN-eq a b e1))
                      (trans (cong (cmpN b) (sym (cmpN-eq b c e2))) (cmpN-refl b))))
          (leq-trans as bs cs (subst (λ o → leqStep o as bs ≡ true) e1 p')
                              (subst (λ o → leqStep o bs cs ≡ true) e2 q'))

------------------------------------------------------------------------
-- Decidable key equality (used to decide distinct member names).

eqN : ℕ → ℕ → Bool
eqN zero    zero    = true
eqN zero    (suc _) = false
eqN (suc _) zero    = false
eqN (suc a) (suc b) = eqN a b

eqN-sound : ∀ a b → eqN a b ≡ true → a ≡ b
eqN-sound zero    zero    _ = refl
eqN-sound zero    (suc b) ()
eqN-sound (suc a) zero    ()
eqN-sound (suc a) (suc b) e = cong suc (eqN-sound a b e)

eqN-refl : ∀ a → eqN a a ≡ true
eqN-refl zero    = refl
eqN-refl (suc a) = eqN-refl a
