{-# OPTIONS --safe --without-K --cubical-compatible #-}
-- SPDX-License-Identifier: MPL-2.0
--
-- Local prelude for the kyq proof spine.  No library is imported: the
-- import cone of every module here is this repository's own files plus
-- Agda.Primitive (see ../README.adoc, "Import cone").
module KyqPrelude where

------------------------------------------------------------------------
-- Equality

data _≡_ {A : Set} (x : A) : A → Set where
  refl : x ≡ x
infix 4 _≡_
{-# BUILTIN EQUALITY _≡_ #-}

cong : {A B : Set} (f : A → B) {x y : A} → x ≡ y → f x ≡ f y
cong f refl = refl

cong₂ : {A B C : Set} (f : A → B → C) {x y : A} {u v : B} →
        x ≡ y → u ≡ v → f x u ≡ f y v
cong₂ f refl refl = refl

sym : {A : Set} {x y : A} → x ≡ y → y ≡ x
sym refl = refl

trans : {A : Set} {x y z : A} → x ≡ y → y ≡ z → x ≡ z
trans refl q = q

subst : {A : Set} (P : A → Set) {x y : A} → x ≡ y → P x → P y
subst P refl p = p

------------------------------------------------------------------------
-- Basic types

data ⊤ : Set where
  tt : ⊤

data ⊥ : Set where

⊥-elim : {A : Set} → ⊥ → A
⊥-elim ()

¬_ : Set → Set
¬ A = A → ⊥
infix 3 ¬_

data Bool : Set where
  false true : Bool

not : Bool → Bool
not true  = false
not false = true

_∧_ : Bool → Bool → Bool
true  ∧ b = b
false ∧ _ = false
infixr 6 _∧_

if_then_else_ : {A : Set} → Bool → A → A → A
if true  then x else _ = x
if false then _ else y = y

true≢false : ¬ (true ≡ false)
true≢false ()

data ℕ : Set where
  zero : ℕ
  suc  : ℕ → ℕ
{-# BUILTIN NATURAL ℕ #-}

data List (A : Set) : Set where
  []  : List A
  _∷_ : A → List A → List A
infixr 5 _∷_

data _×_ (A B : Set) : Set where
  _,_ : A → B → A × B
infixr 4 _,_
infixr 2 _×_

fst : {A B : Set} → A × B → A
fst (a , _) = a

snd : {A B : Set} → A × B → B
snd (_ , b) = b

data Σ (A : Set) (B : A → Set) : Set where
  _,Σ_ : (a : A) → B a → Σ A B
infixr 4 _,Σ_

infixr 1 _⊎_
data _⊎_ (A B : Set) : Set where
  inl : A → A ⊎ B
  inr : B → A ⊎ B

data Maybe (A : Set) : Set where
  nothing : Maybe A
  just    : A → Maybe A

fromMaybe : {A : Set} → A → Maybe A → A
fromMaybe d nothing  = d
fromMaybe _ (just a) = a

-- Stated through cong, not by matching on refl, so that it is free of
-- the constructor-injectivity match that --cubical-compatible warns on.
just-inj : {A : Set} {x y : A} → just x ≡ just y → x ≡ y
just-inj {x = x} e = cong (fromMaybe x) e

nothing≢just : {A : Set} {x : A} → ¬ (nothing ≡ just x)
nothing≢just ()

_⇔_ : Set → Set → Set
A ⇔ B = (A → B) × (B → A)
infix 1 _⇔_

------------------------------------------------------------------------
-- Natural-number arithmetic used by the value measures

_+_ : ℕ → ℕ → ℕ
zero  + n = n
suc m + n = suc (m + n)
infixl 6 _+_

+-zero : ∀ n → n + zero ≡ n
+-zero zero    = refl
+-zero (suc n) = cong suc (+-zero n)

+-suc : ∀ m n → m + suc n ≡ suc (m + n)
+-suc zero    n = refl
+-suc (suc m) n = cong suc (+-suc m n)

+-comm : ∀ m n → m + n ≡ n + m
+-comm zero    n = sym (+-zero n)
+-comm (suc m) n = trans (cong suc (+-comm m n)) (sym (+-suc n m))

+-assoc : ∀ a b c → (a + b) + c ≡ a + (b + c)
+-assoc zero    b c = refl
+-assoc (suc a) b c = cong suc (+-assoc a b c)

-- a + (b + c) ≡ b + (a + c): the swap step that insertion sort needs.
+-swap : ∀ a b c → a + (b + c) ≡ b + (a + c)
+-swap a b c =
  trans (sym (+-assoc a b c))
        (trans (cong (λ x → x + c) (+-comm a b)) (+-assoc b a c))

max : ℕ → ℕ → ℕ
max zero    n       = n
max (suc m) zero    = suc m
max (suc m) (suc n) = suc (max m n)

max-zero : ∀ n → max n zero ≡ n
max-zero zero    = refl
max-zero (suc n) = refl

max-comm : ∀ m n → max m n ≡ max n m
max-comm zero    n       = sym (max-zero n)
max-comm (suc m) zero    = refl
max-comm (suc m) (suc n) = cong suc (max-comm m n)

max-assoc : ∀ a b c → max (max a b) c ≡ max a (max b c)
max-assoc zero    b       c       = refl
max-assoc (suc a) zero    c       = refl
max-assoc (suc a) (suc b) zero    = refl
max-assoc (suc a) (suc b) (suc c) = cong suc (max-assoc a b c)

max-swap : ∀ a b c → max a (max b c) ≡ max b (max a c)
max-swap a b c =
  trans (sym (max-assoc a b c))
        (trans (cong (λ x → max x c) (max-comm a b)) (max-assoc b a c))

-- Boolean ≤ on ℕ, used for budgets and the safe range.
_≤ᵇ_ : ℕ → ℕ → Bool
zero  ≤ᵇ _     = true
suc _ ≤ᵇ zero  = false
suc m ≤ᵇ suc n = m ≤ᵇ n

------------------------------------------------------------------------
-- Boolean conjunction, as a proposition

∧-l : ∀ a b → (a ∧ b) ≡ true → a ≡ true
∧-l true  b _ = refl
∧-l false b ()

∧-r : ∀ a b → (a ∧ b) ≡ true → b ≡ true
∧-r true  b e = e
∧-r false b ()

∧-i : ∀ {a b} → a ≡ true → b ≡ true → (a ∧ b) ≡ true
∧-i refl refl = refl
