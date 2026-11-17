{-# OPTIONS --safe --without-K --cubical-compatible #-}
-- SPDX-License-Identifier: MPL-2.0
--
-- Value budgets (owner ruling R3): budgets are measured on the value,
-- not on encoded bytes, so that canon cannot push an accepted value
-- over a budget, and the typed verdict is the same before and after.
--
-- A Measure is any fold over a value whose member combination is
-- left-commutative, so it cannot see member order.  canon-measure
-- proves every such measure invariant under canon, once.  The three
-- R3 measures are instances, defined as conformance/src/budgets.js
-- defines them (the oracle; MAX_* values are not part of the model):
--
--   depth   containers on the longest root-to-leaf path; a scalar adds
--           nothing, [] has depth 1, [[1]] has depth 2      (MAX_DEPTH 127)
--   nodes   values: every container and every scalar, keys excluded
--   bytes   UTF-8 bytes of every string and every member name, from
--           UTF-16 code units (utf8Length: a valid surrogate pair is 4,
--           a lone surrogate 3)
--
--   canon-measure          : m (canon v) ≡ m v, for every Measure m
--   canon-depth/-nodes/-bytes : the three instances
--   within-canon           : every R3 budget is closed under canon
--   verdict-canon          : the typed budget verdict (which budget is
--                            exceeded first, or none) is unchanged by canon
--
-- Not modelled: alias expansion (V_J has no aliases; for KYAML the
-- measures are taken on the expanded image, and the two expansion
-- budgets MAX_EXPANSION_NODES/BYTES are open), and the encoded-bytes
-- limit MAX_INPUT_BYTES at the CLI edge.  Encoded bytes grow under canon
-- (up to 4.4x MEASURED, verify-logic L6), which is why byte budgets
-- would break closure.
module KyqMeasure (Num : Set) where

open import KyqPrelude
open import KyqOrder
open import KyqValue Num

------------------------------------------------------------------------
-- A fold over members with a left-commutative operator is invariant
-- under insertion sort.

module Fold (f : Member → ℕ) (_⊕_ : ℕ → ℕ → ℕ) (e : ℕ)
            (swap : ∀ a b c → a ⊕ (b ⊕ c) ≡ b ⊕ (a ⊕ c)) where

  foldO : List Member → ℕ
  foldO []       = e
  foldO (m ∷ ms) = f m ⊕ foldO ms

  fold-insert : ∀ m ms → foldO (insert m ms) ≡ f m ⊕ foldO ms
  fold-insert m []       = refl
  fold-insert m (n ∷ ns) with leq (fst m) (fst n)
  ... | true  = refl
  ... | false = trans (cong (λ x → f n ⊕ x) (fold-insert m ns)) (swap (f n) (f m) (foldO ns))

  fold-isort : ∀ ms → foldO (isort ms) ≡ foldO ms
  fold-isort []       = refl
  fold-isort (m ∷ ms) = trans (fold-insert m (isort ms)) (cong (λ x → f m ⊕ x) (fold-isort ms))

------------------------------------------------------------------------
-- Measures.

record Measure : Set where
  field
    _⊕_    : ℕ → ℕ → ℕ                 -- combines the children of a container
    e      : ℕ                         -- the empty container's children
    ⊕-swap : ∀ a b c → a ⊕ (b ⊕ c) ≡ b ⊕ (a ⊕ c)
    mnull  : ℕ
    mbool  : Bool → ℕ
    mnum   : Num → ℕ
    mstr   : List Unit16 → ℕ
    mkey   : Key → ℕ                   -- a member name, combined with its value by ⊕
    box    : ℕ → ℕ                     -- what a container adds around its children

module Measured (M : Measure) where
  open Measure M

  m  : Value → ℕ
  mL : List Value → ℕ
  mO : List Member → ℕ

  m null     = mnull
  m (bool b) = mbool b
  m (num n)  = mnum n
  m (str s)  = mstr s
  m (arr vs) = box (mL vs)
  m (obj ms) = box (mO ms)

  mL []       = e
  mL (v ∷ vs) = m v ⊕ mL vs

  mO []             = e
  mO ((k , v) ∷ ms) = (mkey k ⊕ m v) ⊕ mO ms

  mm : Member → ℕ
  mm (k , v) = mkey k ⊕ m v

  module F = Fold mm _⊕_ e ⊕-swap

  mO-fold : ∀ ms → mO ms ≡ F.foldO ms
  mO-fold []             = refl
  mO-fold ((k , v) ∷ ms) = cong (λ x → (mkey k ⊕ m v) ⊕ x) (mO-fold ms)

  mO-isort : ∀ ms → mO (isort ms) ≡ mO ms
  mO-isort ms = trans (mO-fold (isort ms)) (trans (F.fold-isort ms) (sym (mO-fold ms)))

  canon-measure  : ∀ v  → m  (canon v)   ≡ m v
  canonL-measure : ∀ vs → mL (canonL vs) ≡ mL vs
  canonO-measure : ∀ ms → mO (canonO ms) ≡ mO ms

  canon-measure null     = refl
  canon-measure (bool _) = refl
  canon-measure (num _)  = refl
  canon-measure (str _)  = refl
  canon-measure (arr vs) = cong box (canonL-measure vs)
  canon-measure (obj ms) = cong box (trans (mO-isort (canonO ms)) (canonO-measure ms))

  canonL-measure []       = refl
  canonL-measure (v ∷ vs) = cong₂ _⊕_ (canon-measure v) (canonL-measure vs)

  canonO-measure []             = refl
  canonO-measure ((k , v) ∷ ms) =
    cong₂ _⊕_ (cong (λ x → mkey k ⊕ x) (canon-measure v)) (canonO-measure ms)

------------------------------------------------------------------------
-- The three R3 measures.

-- UTF-8 length of a string given as UTF-16 code units, as utf8Length in
-- conformance/src/budgets.js computes it.
isHigh isLow : Unit16 → Bool
isHigh u = (55296 ≤ᵇ u) ∧ (u ≤ᵇ 56319)     -- 0xD800..0xDBFF
isLow  u = (56320 ≤ᵇ u) ∧ (u ≤ᵇ 57343)     -- 0xDC00..0xDFFF

utf8 : List Unit16 → ℕ
utf8 []           = zero
utf8 (u ∷ [])     = if u ≤ᵇ 127 then 1 else (if u ≤ᵇ 2047 then 2 else 3)
utf8 (u ∷ w ∷ us) =
  if u ≤ᵇ 127 then 1 + utf8 (w ∷ us)
  else (if u ≤ᵇ 2047 then 2 + utf8 (w ∷ us)
  else (if isHigh u ∧ isLow w then 4 + utf8 us
  else 3 + utf8 (w ∷ us)))

depthM : Measure
depthM = record
  { _⊕_ = max ; e = zero ; ⊕-swap = max-swap
  ; mnull = zero ; mbool = λ _ → zero ; mnum = λ _ → zero ; mstr = λ _ → zero
  ; mkey = λ _ → zero ; box = suc }

nodesM : Measure
nodesM = record
  { _⊕_ = _+_ ; e = zero ; ⊕-swap = +-swap
  ; mnull = 1 ; mbool = λ _ → 1 ; mnum = λ _ → 1 ; mstr = λ _ → 1
  ; mkey = λ _ → zero ; box = suc }

bytesM : Measure
bytesM = record
  { _⊕_ = _+_ ; e = zero ; ⊕-swap = +-swap
  ; mnull = zero ; mbool = λ _ → zero ; mnum = λ _ → zero ; mstr = utf8
  ; mkey = utf8 ; box = λ n → n }

module D = Measured depthM
module N = Measured nodesM
module B = Measured bytesM

depth nodes bytes : Value → ℕ
depth = D.m
nodes = N.m
bytes = B.m

canon-depth : ∀ v → depth (canon v) ≡ depth v
canon-depth = D.canon-measure

canon-nodes : ∀ v → nodes (canon v) ≡ nodes v
canon-nodes = N.canon-measure

canon-bytes : ∀ v → bytes (canon v) ≡ bytes v
canon-bytes = B.canon-measure

-- The measures are the oracle's, checked on small values.
depth-scalar : depth null ≡ 0
depth-scalar = refl

depth-empty : depth (arr []) ≡ 1
depth-empty = refl

depth-leaf-free : depth (arr (null ∷ [])) ≡ 1
depth-leaf-free = refl

depth-nested : depth (arr (arr (null ∷ []) ∷ [])) ≡ 2
depth-nested = refl

nodes-keys-excluded : nodes (obj ((1 ∷ 2 ∷ [] , str (3 ∷ 4 ∷ [])) ∷ [])) ≡ 2
nodes-keys-excluded = refl

bytes-keys-included : bytes (obj ((65 ∷ [] , str (66 ∷ 67 ∷ [])) ∷ [])) ≡ 3
bytes-keys-included = refl

------------------------------------------------------------------------
-- Budgets on value measures are closed under canon, with the same
-- typed verdict.

record Budget : Set where
  field
    maxDepth maxNodes maxBytes : ℕ    -- the oracle: 127, 500 000, 8 MiB
open Budget public

data BudgetCode : Set where
  depth-exceeded nodes-exceeded bytes-exceeded : BudgetCode

verdictOf : Budget → ℕ → ℕ → ℕ → Maybe BudgetCode
verdictOf b d n s =
  if d ≤ᵇ maxDepth b
  then (if n ≤ᵇ maxNodes b
        then (if s ≤ᵇ maxBytes b then nothing else just bytes-exceeded)
        else just nodes-exceeded)
  else just depth-exceeded

verdict : Budget → Value → Maybe BudgetCode
verdict b v = verdictOf b (depth v) (nodes v) (bytes v)

Within : Budget → Value → Set
Within b v = verdict b v ≡ nothing

verdict-canon : ∀ b v → verdict b (canon v) ≡ verdict b v
verdict-canon b v =
  trans (cong (λ x → verdictOf b x (nodes (canon v)) (bytes (canon v))) (canon-depth v))
  (trans (cong (λ x → verdictOf b (depth v) x (bytes (canon v))) (canon-nodes v))
         (cong (λ x → verdictOf b (depth v) (nodes v) x) (canon-bytes v)))

within-canon : ∀ b v → Within b v → Within b (canon v)
within-canon b v w = trans (verdict-canon b v) w
