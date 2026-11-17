{-# OPTIONS --safe --without-K --cubical-compatible #-}
-- SPDX-License-Identifier: MPL-2.0
--
-- One object level of JCS-5(a):
--
--   sorted-unique : two key-sorted member lists with distinct keys and
--                   the same members are equal
--   isort-unique  : SameEl xs ys → DistinctKeys xs → DistinctKeys ys →
--                   isort xs ≡ isort ys
--
-- and the countermodel showing that the distinct-key proviso (I-JSON,
-- RFC 7493 §2.3; kyq JCS-1) is necessary:
--
--   no-unique-without-distinct : ¬ (∀ xs ys → SameEl xs ys → isort xs ≡ isort ys)
--
-- The recursive lift (every depth) is in KyqRecursive.
module KyqUnique (Num : Set) where

open import KyqPrelude
open import KyqOrder
open import KyqValue Num

_∈_ : Member → List Member → Set
z ∈ []       = ⊥
z ∈ (x ∷ xs) = (z ≡ x) ⊎ (z ∈ xs)

SameEl : List Member → List Member → Set
SameEl xs ys = (∀ z → z ∈ xs → z ∈ ys) × (∀ z → z ∈ ys → z ∈ xs)

-- No member name is written twice (RFC 7493 §2.3).
DistinctKeys : List Member → Set
DistinctKeys []       = ⊤
DistinctKeys (m ∷ ms) = (∀ n → n ∈ ms → fst n ≡ fst m → ⊥) × DistinctKeys ms

∈-insert-in : ∀ m ms z → z ∈ insert m ms → (z ≡ m) ⊎ (z ∈ ms)
∈-insert-in m []       z i = i
∈-insert-in m (n ∷ ns) z i with leq (fst m) (fst n)
... | true  = i
... | false with i
...   | inl e = inr (inl e)
...   | inr j with ∈-insert-in m ns z j
...     | inl e = inl e
...     | inr k = inr (inr k)

∈-insert-out : ∀ m ms z → (z ≡ m) ⊎ (z ∈ ms) → z ∈ insert m ms
∈-insert-out m []       z i = i
∈-insert-out m (n ∷ ns) z i with leq (fst m) (fst n)
... | true  = i
... | false with i
...   | inl e       = inr (∈-insert-out m ns z (inl e))
...   | inr (inl e) = inl e
...   | inr (inr k) = inr (∈-insert-out m ns z (inr k))

∈-isort-in : ∀ ms z → z ∈ isort ms → z ∈ ms
∈-isort-in []       z ()
∈-isort-in (m ∷ ms) z i with ∈-insert-in m (isort ms) z i
... | inl e = inl e
... | inr j = inr (∈-isort-in ms z j)

∈-isort-out : ∀ ms z → z ∈ ms → z ∈ isort ms
∈-isort-out (m ∷ ms) z (inl e) = ∈-insert-out m (isort ms) z (inl e)
∈-isort-out (m ∷ ms) z (inr j) = ∈-insert-out m (isort ms) z (inr (∈-isort-out ms z j))

dk-insert : ∀ m ms → (∀ n → n ∈ ms → fst n ≡ fst m → ⊥) →
            DistinctKeys ms → DistinctKeys (insert m ms)
dk-insert m []       c _ = (λ n i e → i) , tt
dk-insert m (n ∷ ns) c (hn , dn) with leq (fst m) (fst n)
... | true  = c , hn , dn
... | false = head , dk-insert m ns (λ p i e → c p (inr i) e) dn
  where
  head : ∀ p → p ∈ insert m ns → fst p ≡ fst n → ⊥
  head p i e with ∈-insert-in m ns p i
  ... | inl refl = c n (inl refl) (sym e)
  ... | inr j    = hn p j e

dk-isort : ∀ ms → DistinctKeys ms → DistinctKeys (isort ms)
dk-isort []       _       = tt
dk-isort (m ∷ ms) (h , d) =
  dk-insert m (isort ms) (λ n i e → h n (∈-isort-in ms n i) e) (dk-isort ms d)

sorted-min : ∀ h t z → Sorted (h ∷ t) → z ∈ t → leq (fst h) (fst z) ≡ true
sorted-min h (n ∷ ns) z (hn , _) (inl refl) = hn
sorted-min h (n ∷ ns) z (hn , s) (inr i) =
  leq-trans (fst h) (fst n) (fst z) hn (sorted-min n ns z s i)

------------------------------------------------------------------------
-- Uniqueness of the sorted representative at one object level.

sorted-unique : ∀ s1 s2 → Sorted s1 → Sorted s2 →
                DistinctKeys s1 → DistinctKeys s2 → SameEl s1 s2 → s1 ≡ s2
sorted-unique []        []        _  _  _  _  _       = refl
sorted-unique []        (h ∷ t)   _  _  _  _  (_ , b) = ⊥-elim (b h (inl refl))
sorted-unique (h ∷ t)   []        _  _  _  _  (a , _) = ⊥-elim (a h (inl refl))
sorted-unique (h1 ∷ t1) (h2 ∷ t2) s1 s2 (d1 , dk1) (d2 , dk2) (a , b) =
  heads (a h1 (inl refl)) (b h2 (inl refl))
  where
  tails : h1 ≡ h2 → h1 ∷ t1 ≡ h2 ∷ t2
  tails refl = cong (h1 ∷_)
    (sorted-unique t1 t2 (sorted-tail h1 t1 s1) (sorted-tail h1 t2 s2) dk1 dk2
      ((λ z i → from1 z i (a z (inr i))) , (λ z i → from2 z i (b z (inr i)))))
    where
    from1 : ∀ z → z ∈ t1 → z ∈ (h1 ∷ t2) → z ∈ t2
    from1 z i (inl refl) = ⊥-elim (d1 z i refl)
    from1 z i (inr j)    = j
    from2 : ∀ z → z ∈ t2 → z ∈ (h1 ∷ t1) → z ∈ t1
    from2 z i (inl refl) = ⊥-elim (d2 z i refl)
    from2 z i (inr j)    = j
  heads : h1 ∈ (h2 ∷ t2) → h2 ∈ (h1 ∷ t1) → h1 ∷ t1 ≡ h2 ∷ t2
  heads (inl e) _       = tails e
  heads (inr _) (inl e) = tails (sym e)
  heads (inr i) (inr j) =
    ⊥-elim (d1 h2 j (sym (leq-antisym (fst h1) (fst h2)
                     (sorted-min h1 t1 h2 s1 j) (sorted-min h2 t2 h1 s2 i))))

isort-unique : ∀ xs ys → SameEl xs ys → DistinctKeys xs → DistinctKeys ys →
               isort xs ≡ isort ys
isort-unique xs ys (a , b) dx dy =
  sorted-unique (isort xs) (isort ys) (isort-sorted xs) (isort-sorted ys)
    (dk-isort xs dx) (dk-isort ys dy)
    ((λ z i → ∈-isort-out ys z (a z (∈-isort-in xs z i))) ,
     (λ z i → ∈-isort-out xs z (b z (∈-isort-in ys z i))))

------------------------------------------------------------------------
-- Countermodel: the distinct-key proviso is necessary.

k₀ : Key
k₀ = zero ∷ []

dupA dupB : List Member
dupA = (k₀ , bool true)  ∷ (k₀ , bool false) ∷ []
dupB = (k₀ , bool false) ∷ (k₀ , bool true)  ∷ []

dup-same : SameEl dupA dupB
dup-same = (λ z i → swap z i) , (λ z i → swap' z i)
  where
  swap : ∀ z → z ∈ dupA → z ∈ dupB
  swap z (inl e)       = inr (inl e)
  swap z (inr (inl e)) = inl e
  swap z (inr (inr ()))
  swap' : ∀ z → z ∈ dupB → z ∈ dupA
  swap' z (inl e)       = inr (inl e)
  swap' z (inr (inl e)) = inl e
  swap' z (inr (inr ()))

dup-breaks-determinism : ¬ (isort dupA ≡ isort dupB)
dup-breaks-determinism ()

no-unique-without-distinct :
  ¬ (∀ xs ys → SameEl xs ys → isort xs ≡ isort ys)
no-unique-without-distinct h = dup-breaks-determinism (h dupA dupB dup-same)
