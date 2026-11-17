{-# OPTIONS --safe --without-K --cubical-compatible #-}
-- SPDX-License-Identifier: MPL-2.0
--
-- The I-JSON value algebra V_J and the value-level canoniser.
--
--   Value      : null, bool, number, string, array, object
--   canon      : recursively sorts object members by key (UTF-16 order)
--   canon-nf   : NF (canon v)                  canon lands in normal forms
--   nf-fixed   : NF v → canon v ≡ v            ReCanonize (quotient lenses)
--   canon-idem : canon (canon v) ≡ canon v     idempotence, c ∘ c = c
--   nf-covered : NF v → fibre of canon over v  image canon ⊇ NF
--   image-nf   : fibre of canon over v → NF v  image canon ⊆ NF
--   isort-perm : sorting only permutes members
--
-- Numbers are an abstract module parameter `Num`.  The value algebra
-- says nothing about number text (RFC 8785 §3.2.2.3), bytes, escaping
-- or the I-JSON number profile; the profile is modelled separately, in
-- KyqProfile, as RoundTrip of the profile parser (verify-logic L7).
--
-- Objects are association lists in the order the producer wrote them.
-- The "same object up to member order" relation is defined
-- independently of canon in KyqRecursive.
module KyqValue (Num : Set) where

open import KyqPrelude
open import KyqOrder

data Value : Set where
  null : Value
  bool : Bool → Value
  num  : Num → Value
  str  : List Unit16 → Value
  arr  : List Value → Value
  obj  : List (Key × Value) → Value

Member : Set
Member = Key × Value

pair : Key → Value → Member
pair k v = k , v

-- Insertion sort on members, by key only.
insert : Member → List Member → List Member
insert m []       = m ∷ []
insert m (n ∷ ns) with leq (fst m) (fst n)
... | true  = m ∷ n ∷ ns
... | false = n ∷ insert m ns

isort : List Member → List Member
isort []       = []
isort (m ∷ ms) = insert m (isort ms)

canon  : Value → Value
canonL : List Value → List Value
canonO : List Member → List Member

canon null     = null
canon (bool b) = bool b
canon (num n)  = num n
canon (str s)  = str s
canon (arr vs) = arr (canonL vs)
canon (obj ms) = obj (isort (canonO ms))

canonL []       = []
canonL (v ∷ vs) = canon v ∷ canonL vs

canonO []             = []
canonO ((k , v) ∷ ms) = (k , canon v) ∷ canonO ms

------------------------------------------------------------------------
-- Normal forms: members in key order at every depth (JCS-5(a) shape).

Sorted : List Member → Set
Sorted []           = ⊤
Sorted (m ∷ [])     = ⊤
Sorted (m ∷ n ∷ ns) = (leq (fst m) (fst n) ≡ true) × Sorted (n ∷ ns)

NF  : Value → Set
NFL : List Value → Set
NFO : List Member → Set

NF null     = ⊤
NF (bool _) = ⊤
NF (num _)  = ⊤
NF (str _)  = ⊤
NF (arr vs) = NFL vs
NF (obj ms) = NFO ms × Sorted ms

NFL []       = ⊤
NFL (v ∷ vs) = NF v × NFL vs

NFO []             = ⊤
NFO ((_ , v) ∷ ms) = NF v × NFO ms

------------------------------------------------------------------------
-- Sorting lemmas

insert-sorted : ∀ m ms → Sorted ms → Sorted (insert m ms)
insert-sorted m []       _ = tt
insert-sorted m (n ∷ ns) s with leq (fst m) (fst n) in e
... | true  = e , s
... | false = go ns s (leq-total (fst m) (fst n) e)
  where
  go : ∀ ns → Sorted (n ∷ ns) → leq (fst n) (fst m) ≡ true →
       Sorted (n ∷ insert m ns)
  go []       _         nm = nm , tt
  go (p ∷ ps) (np , sp) nm
    with leq (fst m) (fst p) | insert-sorted m (p ∷ ps) sp
  ... | true  | r = nm , r
  ... | false | r = np , r

isort-sorted : ∀ ms → Sorted (isort ms)
isort-sorted []       = tt
isort-sorted (m ∷ ms) = insert-sorted m (isort ms) (isort-sorted ms)

insert-head : ∀ m ms → Sorted (m ∷ ms) → insert m ms ≡ m ∷ ms
insert-head m []       _        = refl
insert-head m (n ∷ ns) (mn , _) rewrite mn = refl

sorted-tail : ∀ m ms → Sorted (m ∷ ms) → Sorted ms
sorted-tail m []       _       = tt
sorted-tail m (n ∷ ns) (_ , s) = s

isort-fixed : ∀ ms → Sorted ms → isort ms ≡ ms
isort-fixed []       _ = refl
isort-fixed (m ∷ ms) s =
  trans (cong (insert m) (isort-fixed ms (sorted-tail m ms s))) (insert-head m ms s)

insert-nfo : ∀ k v ms → NF v → NFO ms → NFO (insert (k , v) ms)
insert-nfo k v []             nv _         = nv , tt
insert-nfo k v ((j , w) ∷ ns) nv (nw , ok) with leq k j
... | true  = nv , nw , ok
... | false = nw , insert-nfo k v ns nv ok

isort-nfo : ∀ ms → NFO ms → NFO (isort ms)
isort-nfo []             _         = tt
isort-nfo ((k , v) ∷ ms) (nv , ok) = insert-nfo k v (isort ms) nv (isort-nfo ms ok)

------------------------------------------------------------------------
-- canon lands in normal forms.

canon-nf  : ∀ v  → NF  (canon v)
canonL-nf : ∀ vs → NFL (canonL vs)
canonO-nf : ∀ ms → NFO (canonO ms)

canon-nf null     = tt
canon-nf (bool b) = tt
canon-nf (num n)  = tt
canon-nf (str s)  = tt
canon-nf (arr vs) = canonL-nf vs
canon-nf (obj ms) = isort-nfo (canonO ms) (canonO-nf ms) , isort-sorted (canonO ms)

canonL-nf []       = tt
canonL-nf (v ∷ vs) = canon-nf v , canonL-nf vs

canonO-nf []             = tt
canonO-nf ((k , v) ∷ ms) = canon-nf v , canonO-nf ms

------------------------------------------------------------------------
-- ReCanonize: canon fixes every normal form.

nf-fixed  : ∀ v  → NF  v  → canon v   ≡ v
nfl-fixed : ∀ vs → NFL vs → canonL vs ≡ vs
nfo-fixed : ∀ ms → NFO ms → canonO ms ≡ ms

nf-fixed null     _ = refl
nf-fixed (bool b) _ = refl
nf-fixed (num n)  _ = refl
nf-fixed (str s)  _ = refl
nf-fixed (arr vs) p = cong arr (nfl-fixed vs p)
nf-fixed (obj ms) (p , s) =
  cong obj (trans (cong isort (nfo-fixed ms p)) (isort-fixed ms s))

nfl-fixed []       _        = refl
nfl-fixed (v ∷ vs) (p , ps) = cong₂ _∷_ (nf-fixed v p) (nfl-fixed vs ps)

nfo-fixed []             _        = refl
nfo-fixed ((k , v) ∷ ms) (p , ps) =
  cong₂ _∷_ (cong (pair k) (nf-fixed v p)) (nfo-fixed ms ps)

------------------------------------------------------------------------
-- Idempotence: c ∘ c = c  (kyq JCS-6, value level).

canon-idem : ∀ v → canon (canon v) ≡ canon v
canon-idem v = nf-fixed (canon v) (canon-nf v)

-- image canon = NF.
Fibre : Value → Set
Fibre y = Σ Value (λ x → canon x ≡ y)

nf-covered : ∀ v → NF v → Fibre v
nf-covered v p = v ,Σ nf-fixed v p

image-nf : ∀ y → Fibre y → NF y
image-nf y (x ,Σ e) = subst NF e (canon-nf x)

------------------------------------------------------------------------
-- Sorting is a permutation: the object step never adds or drops a member.

data Perm {A : Set} : List A → List A → Set where
  p[]    : Perm [] []
  pskip  : ∀ {x xs ys} → Perm xs ys → Perm (x ∷ xs) (x ∷ ys)
  pswap  : ∀ {x y xs} → Perm (x ∷ y ∷ xs) (y ∷ x ∷ xs)
  ptrans : ∀ {xs ys zs} → Perm xs ys → Perm ys zs → Perm xs zs

perm-refl : {A : Set} (xs : List A) → Perm xs xs
perm-refl []       = p[]
perm-refl (x ∷ xs) = pskip (perm-refl xs)

insert-perm : ∀ m ms → Perm (m ∷ ms) (insert m ms)
insert-perm m []       = perm-refl (m ∷ [])
insert-perm m (n ∷ ns) with leq (fst m) (fst n)
... | true  = perm-refl (m ∷ n ∷ ns)
... | false = ptrans pswap (pskip (insert-perm m ns))

isort-perm : ∀ ms → Perm ms (isort ms)
isort-perm []       = p[]
isort-perm (m ∷ ms) = ptrans (pskip (isort-perm ms)) (insert-perm m (isort ms))

-- canon is not the identity: it is a proper retraction.
canon-not-id : ¬ (∀ v → canon v ≡ v)
canon-not-id h with h (obj ((suc zero ∷ [] , null) ∷ (zero ∷ [] , null) ∷ []))
... | ()
