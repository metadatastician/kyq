{-# OPTIONS --safe --without-K --cubical-compatible #-}
-- SPDX-License-Identifier: MPL-2.0
--
-- Profile-level closure: the large-float hole as a failure of RoundTrip
-- of the I-JSON *profile* parser (verify-logic L7), and its exclusion by
-- owner ruling R3 ("refuse finite floats whose JCS form is an integer
-- outside the safe range").
--
-- The number interface `NumIface` keeps numbers abstract.  Its one
-- hypothesis is show-val (printing a number and reading the numeral back
-- gives the same number: the shortest-round-trip property of ECMAScript
-- Number::toString).  It is a record field, a module parameter, never a
-- postulate.  The int/float classification (`intForm`) and the safe
-- range (`safe`) belong to the PROFILE reader `readP`, not to NumIface's
-- printing hypothesis.
--
--   hole-breaks-rt   : a hole (accepted at input, printed in integer form
--                      outside the safe range) refutes RoundTrip on the
--                      pre-R3 domain
--   r3-rt            : RoundTrip of the profile reader on the R3 domain
--   r3-excludes-hole : R3 refuses every hole
--   r3-maximal       : R3 refuses only what closure forces it to refuse
--   toy-*            : a concrete NumIface in which a hole exists, so the
--                      counterexample shape is not vacuous
--   domR3B           : DomR3 is decidable (domR3B-sound, domR3B-complete)
--   ProfileFormat    : the I-JSON profile as a KyqCodec Format over value
--                      trees (token trees, not bytes); profile-roundtrip
--                      (RoundTrip under R3) and profile-closure (the
--                      accept-set half of JCS-10: c v is in Canonical)
--   Gate.profile-gate-closure : with decidable numeral equality, the
--                      reference check is a canonical gate, so
--                      check (c v) ≡ true under R3 is derived (gate level)
--   toy-gate, toy-tv-* : a second non-vacuity witness with a partial
--                      parser and a proper Dom, where TV refuses a refused
--                      input and an input outside Dom
module KyqProfile where

open import KyqPrelude
open import KyqOrder
import KyqValue
open import KyqCodec

record NumIface : Set₁ where
  field
    Num      : Set
    Tok      : Set                    -- a numeral, as text
    val      : Tok → Maybe Num        -- its binary64 value; nothing if not finite
    intForm  : Tok → Bool             -- integer form: no fraction, no exponent
    safe     : Num → Bool             -- within ±(2^53 − 1)
    show     : Num → Tok              -- RFC 8785 §3.2.2.3 serialisation
    show-val : ∀ n → val (show n) ≡ just n

module Profile (I : NumIface) where
  open NumIface I

  -- The profile reader: an integer-form numeral outside the safe range
  -- is refused (RFC 7493 §2.2), whatever its value.
  gate : Bool → Num → Maybe Num
  gate true  _ = nothing
  gate false n = just n

  readFrom : Tok → Maybe Num → Maybe Num
  readFrom t nothing  = nothing
  readFrom t (just n) = gate (intForm t ∧ not (safe n)) n

  readP : Tok → Maybe Num
  readP t = readFrom t (val t)

  -- Pre-R3 domain: every number some numeral is accepted for.
  DomOld : Num → Set
  DomOld n = Σ Tok (λ t → readP t ≡ just n)

  -- R3 domain: additionally refuse a number whose JCS form is an
  -- integer outside the safe range.
  DomR3 : Num → Set
  DomR3 n = DomOld n × (intForm (show n) ≡ true → safe n ≡ true)

  RT : (Num → Set) → Set
  RT Dom = ∀ n → Dom n → readP (show n) ≡ just n

  Hole : Num → Set
  Hole n = DomOld n × (intForm (show n) ≡ true) × (safe n ≡ false)

  readP-show : ∀ n → readP (show n) ≡ gate (intForm (show n) ∧ not (safe n)) n
  readP-show n = cong (readFrom (show n)) (show-val n)

  hole-refused : ∀ n → Hole n → readP (show n) ≡ nothing
  hole-refused n (_ , i , s) =
    trans (readP-show n)
          (subst (λ b → gate (b ∧ not (safe n)) n ≡ nothing) (sym i)
                 (subst (λ b → gate (not b) n ≡ nothing) (sym s) refl))

  hole-breaks-rt : ∀ n → Hole n → ¬ RT DomOld
  hole-breaks-rt n h rt = nothing≢just (trans (sym (hole-refused n h)) (rt n (fst h)))

  r3-gate : ∀ n → (intForm (show n) ≡ true → safe n ≡ true) →
            gate (intForm (show n) ∧ not (safe n)) n ≡ just n
  r3-gate n r with intForm (show n) | r
  ... | false | _  = refl
  ... | true  | r' = subst (λ b → gate (not b) n ≡ just n) (sym (r' refl)) refl

  r3-rt : RT DomR3
  r3-rt n (_ , r) = trans (readP-show n) (r3-gate n r)

  r3-excludes-hole : ∀ n → Hole n → ¬ DomR3 n
  r3-excludes-hole n (_ , i , s) (_ , r) = true≢false (trans (sym (r i)) s)

  -- R3 is the largest closed sub-domain of DomOld.
  r3-maximal : ∀ n → DomOld n → readP (show n) ≡ just n → DomR3 n
  r3-maximal n d e = d , forced
    where
    forced : intForm (show n) ≡ true → safe n ≡ true
    forced i with safe n in s
    ... | true  = refl
    ... | false = ⊥-elim (nothing≢just (trans (sym (hole-refused n (d , i , s))) e))

  -- DomR3 is decidable: under the R3 condition the printed numeral is
  -- itself a witness of DomOld, so DomR3 n is exactly that condition.
  domR3B : Num → Bool
  domR3B n = if intForm (show n) then safe n else true

  r3-of : ∀ n → domR3B n ≡ true → intForm (show n) ≡ true → safe n ≡ true
  r3-of n ok i = subst (λ b → (if b then safe n else true) ≡ true) i ok

  domR3B-sound : ∀ n → domR3B n ≡ true → DomR3 n
  domR3B-sound n ok = (show n ,Σ trans (readP-show n) (r3-gate n (r3-of n ok))) , r3-of n ok

  domR3B-complete : ∀ n → DomR3 n → domR3B n ≡ true
  domR3B-complete n (_ , r) with intForm (show n) | r
  ... | false | _  = refl
  ... | true  | r' = r' refl

------------------------------------------------------------------------
-- A concrete number interface in which the hole exists.  Numerals are
-- integer-form (intTok) or exponent-form (expTok); the toy safe range is
-- 0..3; the printer writes integer form, as Number::toString does below
-- 1e21.  expTok 4 plays "1e18"; show 4 = intTok 4 plays
-- "1000000000000000000".

data Numeral : Set where
  intTok expTok : ℕ → Numeral

toyVal : Numeral → Maybe ℕ
toyVal (intTok n) = just n
toyVal (expTok n) = just n

toyIntForm : Numeral → Bool
toyIntForm (intTok _) = true
toyIntForm (expTok _) = false

toy : NumIface
toy = record
  { Num = ℕ ; Tok = Numeral ; val = toyVal ; intForm = toyIntForm
  ; safe = λ n → n ≤ᵇ 3 ; show = intTok ; show-val = λ n → refl }

module Toy = Profile toy

toy-hole : Toy.Hole 4
toy-hole = (expTok 4 ,Σ refl) , refl , refl

toy-old-not-closed : ¬ Toy.RT Toy.DomOld
toy-old-not-closed = Toy.hole-breaks-rt 4 toy-hole

toy-r3-closed : Toy.RT Toy.DomR3
toy-r3-closed = Toy.r3-rt

------------------------------------------------------------------------
-- Decidable equality of value trees, given one on the leaves.  Used to
-- compare a text with the canonical text in the reference check.

module ValueEq (A : Set) (eqA : A → A → Bool)
               (eqA-sound : ∀ a b → eqA a b ≡ true → a ≡ b)
               (eqA-refl  : ∀ a → eqA a a ≡ true) where
  open KyqValue A

  eqBool : Bool → Bool → Bool
  eqBool true  true  = true
  eqBool false false = true
  eqBool _     _     = false

  eqBool-sound : ∀ a b → eqBool a b ≡ true → a ≡ b
  eqBool-sound true  true  _ = refl
  eqBool-sound false false _ = refl
  eqBool-sound true  false ()
  eqBool-sound false true  ()

  eqBool-refl : ∀ a → eqBool a a ≡ true
  eqBool-refl true  = refl
  eqBool-refl false = refl

  eqKey : List ℕ → List ℕ → Bool
  eqKey []       []       = true
  eqKey (a ∷ as) (b ∷ bs) = eqN a b ∧ eqKey as bs
  eqKey _        _        = false

  eqKey-sound : ∀ a b → eqKey a b ≡ true → a ≡ b
  eqKey-sound []       []       _ = refl
  eqKey-sound (a ∷ as) (b ∷ bs) e =
    cong₂ _∷_ (eqN-sound a b (∧-l (eqN a b) _ e)) (eqKey-sound as bs (∧-r (eqN a b) _ e))
  eqKey-sound []       (_ ∷ _)  ()
  eqKey-sound (_ ∷ _)  []       ()

  eqKey-refl : ∀ a → eqKey a a ≡ true
  eqKey-refl []       = refl
  eqKey-refl (a ∷ as) = ∧-i (eqN-refl a) (eqKey-refl as)

  eqV : Value → Value → Bool
  eqL : List Value → List Value → Bool
  eqO : List Member → List Member → Bool

  eqV null     null     = true
  eqV (bool a) (bool b) = eqBool a b
  eqV (num a)  (num b)  = eqA a b
  eqV (str s)  (str t)  = eqKey s t
  eqV (arr vs) (arr ws) = eqL vs ws
  eqV (obj ms) (obj ns) = eqO ms ns
  eqV _        _        = false

  eqL []       []       = true
  eqL (v ∷ vs) (w ∷ ws) = eqV v w ∧ eqL vs ws
  eqL _        _        = false

  eqO []             []             = true
  eqO ((k , v) ∷ ms) ((j , w) ∷ ns) = eqKey k j ∧ eqV v w ∧ eqO ms ns
  eqO _              _              = false

  eqV-sound : ∀ v w → eqV v w ≡ true → v ≡ w
  eqL-sound : ∀ vs ws → eqL vs ws ≡ true → vs ≡ ws
  eqO-sound : ∀ ms ns → eqO ms ns ≡ true → ms ≡ ns

  eqV-sound null     null     _ = refl
  eqV-sound (bool a) (bool b) e = cong bool (eqBool-sound a b e)
  eqV-sound (num a)  (num b)  e = cong num (eqA-sound a b e)
  eqV-sound (str s)  (str t)  e = cong str (eqKey-sound s t e)
  eqV-sound (arr vs) (arr ws) e = cong arr (eqL-sound vs ws e)
  eqV-sound (obj ms) (obj ns) e = cong obj (eqO-sound ms ns e)
  eqV-sound null     (bool _) ()
  eqV-sound null     (num _)  ()
  eqV-sound null     (str _)  ()
  eqV-sound null     (arr _)  ()
  eqV-sound null     (obj _)  ()
  eqV-sound (bool _) null     ()
  eqV-sound (bool _) (num _)  ()
  eqV-sound (bool _) (str _)  ()
  eqV-sound (bool _) (arr _)  ()
  eqV-sound (bool _) (obj _)  ()
  eqV-sound (num _)  null     ()
  eqV-sound (num _)  (bool _) ()
  eqV-sound (num _)  (str _)  ()
  eqV-sound (num _)  (arr _)  ()
  eqV-sound (num _)  (obj _)  ()
  eqV-sound (str _)  null     ()
  eqV-sound (str _)  (bool _) ()
  eqV-sound (str _)  (num _)  ()
  eqV-sound (str _)  (arr _)  ()
  eqV-sound (str _)  (obj _)  ()
  eqV-sound (arr _)  null     ()
  eqV-sound (arr _)  (bool _) ()
  eqV-sound (arr _)  (num _)  ()
  eqV-sound (arr _)  (str _)  ()
  eqV-sound (arr _)  (obj _)  ()
  eqV-sound (obj _)  null     ()
  eqV-sound (obj _)  (bool _) ()
  eqV-sound (obj _)  (num _)  ()
  eqV-sound (obj _)  (str _)  ()
  eqV-sound (obj _)  (arr _)  ()

  eqL-sound []       []       _ = refl
  eqL-sound (v ∷ vs) (w ∷ ws) e =
    cong₂ _∷_ (eqV-sound v w (∧-l (eqV v w) _ e)) (eqL-sound vs ws (∧-r (eqV v w) _ e))
  eqL-sound []       (_ ∷ _)  ()
  eqL-sound (_ ∷ _)  []       ()

  eqO-sound []             []             _ = refl
  eqO-sound ((k , v) ∷ ms) ((j , w) ∷ ns) e =
    cong₂ _∷_ (cong₂ _,_ (eqKey-sound k j (∧-l (eqKey k j) _ e))
                         (eqV-sound v w (∧-l (eqV v w) _ (∧-r (eqKey k j) _ e))))
              (eqO-sound ms ns (∧-r (eqV v w) _ (∧-r (eqKey k j) _ e)))
  eqO-sound []             (_ ∷ _)        ()
  eqO-sound ((_ , _) ∷ _)  []             ()

  eqV-refl : ∀ v  → eqV v v   ≡ true
  eqL-refl : ∀ vs → eqL vs vs ≡ true
  eqO-refl : ∀ ms → eqO ms ms ≡ true

  eqV-refl null     = refl
  eqV-refl (bool a) = eqBool-refl a
  eqV-refl (num a)  = eqA-refl a
  eqV-refl (str s)  = eqKey-refl s
  eqV-refl (arr vs) = eqL-refl vs
  eqV-refl (obj ms) = eqO-refl ms

  eqL-refl []       = refl
  eqL-refl (v ∷ vs) = ∧-i (eqV-refl v) (eqL-refl vs)

  eqO-refl []             = refl
  eqO-refl ((k , v) ∷ ms) = ∧-i (eqKey-refl k) (∧-i (eqV-refl v) (eqO-refl ms))

------------------------------------------------------------------------
-- Lifting to value trees: the profile parser reads every numeral leaf
-- with readP; the printer writes every number with show.

module Lift (I : NumIface) where
  open NumIface I
  open Profile I
  module VN = KyqValue Num
  module VT = KyqValue Tok

  _<$>_ : {A B : Set} → (A → B) → Maybe A → Maybe B
  f <$> nothing = nothing
  f <$> just a  = just (f a)

  ap2 : {A B C : Set} → (A → B → C) → Maybe A → Maybe B → Maybe C
  ap2 f (just a) (just b) = just (f a b)
  ap2 f _        _        = nothing

  printV : VN.Value → VT.Value
  printL : List VN.Value → List VT.Value
  printO : List VN.Member → List VT.Member

  printV VN.null     = VT.null
  printV (VN.bool b) = VT.bool b
  printV (VN.num n)  = VT.num (show n)
  printV (VN.str s)  = VT.str s
  printV (VN.arr vs) = VT.arr (printL vs)
  printV (VN.obj ms) = VT.obj (printO ms)

  printL []       = []
  printL (v ∷ vs) = printV v ∷ printL vs

  printO []             = []
  printO ((k , v) ∷ ms) = (k , printV v) ∷ printO ms

  parseV : VT.Value → Maybe VN.Value
  parseL : List VT.Value → Maybe (List VN.Value)
  parseO : List VT.Member → Maybe (List VN.Member)

  parseV VT.null     = just VN.null
  parseV (VT.bool b) = just (VN.bool b)
  parseV (VT.num t)  = VN.num <$> readP t
  parseV (VT.str s)  = just (VN.str s)
  parseV (VT.arr vs) = VN.arr <$> parseL vs
  parseV (VT.obj ms) = VN.obj <$> parseO ms

  parseL []       = just []
  parseL (v ∷ vs) = ap2 _∷_ (parseV v) (parseL vs)

  parseO []             = just []
  parseO ((k , v) ∷ ms) = ap2 (λ w ws → (k , w) ∷ ws) (parseV v) (parseO ms)

  -- Every number leaf satisfies P.
  AllNum  : (Num → Set) → VN.Value → Set
  AllNumL : (Num → Set) → List VN.Value → Set
  AllNumO : (Num → Set) → List VN.Member → Set

  AllNum P VN.null     = ⊤
  AllNum P (VN.bool _) = ⊤
  AllNum P (VN.num n)  = P n
  AllNum P (VN.str _)  = ⊤
  AllNum P (VN.arr vs) = AllNumL P vs
  AllNum P (VN.obj ms) = AllNumO P ms

  AllNumL P []       = ⊤
  AllNumL P (v ∷ vs) = AllNum P v × AllNumL P vs

  AllNumO P []             = ⊤
  AllNumO P ((_ , v) ∷ ms) = AllNum P v × AllNumO P ms

  value-rt  : ∀ v  → AllNum  DomR3 v  → parseV (printV v)  ≡ just v
  valueL-rt : ∀ vs → AllNumL DomR3 vs → parseL (printL vs) ≡ just vs
  valueO-rt : ∀ ms → AllNumO DomR3 ms → parseO (printO ms) ≡ just ms

  value-rt VN.null     _ = refl
  value-rt (VN.bool b) _ = refl
  value-rt (VN.num n)  d = cong (VN.num <$>_) (r3-rt n d)
  value-rt (VN.str s)  _ = refl
  value-rt (VN.arr vs) d = cong (VN.arr <$>_) (valueL-rt vs d)
  value-rt (VN.obj ms) d = cong (VN.obj <$>_) (valueO-rt ms d)

  valueL-rt []       _        = refl
  valueL-rt (v ∷ vs) (d , ds) = cong₂ (ap2 _∷_) (value-rt v d) (valueL-rt vs ds)

  valueO-rt []             _        = refl
  valueO-rt ((k , v) ∷ ms) (d , ds) =
    cong₂ (ap2 (λ w ws → (k , w) ∷ ws)) (value-rt v d) (valueO-rt ms ds)

  -- On the pre-R3 domain the value-level round trip fails at any hole.
  value-rt-old-fails : ∀ n → Hole n →
    ¬ (∀ v → AllNum DomOld v → parseV (printV v) ≡ just v)
  value-rt-old-fails n h rt with readP (show n) | hole-refused n h | rt (VN.num n) (fst h)
  ... | .nothing | refl | ()

  -- canon only permutes members, so it keeps every number leaf.
  allnum-insert : ∀ P m ms → AllNum P (snd m) → AllNumO P ms → AllNumO P (VN.insert m ms)
  allnum-insert P (k , v) []             a _         = a , tt
  allnum-insert P (k , v) ((j , w) ∷ ns) a (aw , an) with leq k j
  ... | true  = a , aw , an
  ... | false = aw , allnum-insert P (k , v) ns a an

  allnum-isort : ∀ P ms → AllNumO P ms → AllNumO P (VN.isort ms)
  allnum-isort P []             _        = tt
  allnum-isort P ((k , v) ∷ ms) (a , as) = allnum-insert P (k , v) (VN.isort ms) a (allnum-isort P ms as)

  allnum-canon  : ∀ P v  → AllNum  P v  → AllNum  P (VN.canon v)
  allnumL-canon : ∀ P vs → AllNumL P vs → AllNumL P (VN.canonL vs)
  allnumO-canon : ∀ P ms → AllNumO P ms → AllNumO P (VN.canonO ms)

  allnum-canon P VN.null     _ = tt
  allnum-canon P (VN.bool _) _ = tt
  allnum-canon P (VN.num _)  a = a
  allnum-canon P (VN.str _)  _ = tt
  allnum-canon P (VN.arr vs) a = allnumL-canon P vs a
  allnum-canon P (VN.obj ms) a = allnum-isort P (VN.canonO ms) (allnumO-canon P ms a)

  allnumL-canon P []       _        = tt
  allnumL-canon P (v ∷ vs) (a , as) = allnum-canon P v a , allnumL-canon P vs as

  allnumO-canon P []             _        = tt
  allnumO-canon P ((k , v) ∷ ms) (a , as) = allnum-canon P v a , allnumO-canon P ms as

  -- AllNum DomR3 is decidable.
  allB  : VN.Value → Bool
  allBL : List VN.Value → Bool
  allBO : List VN.Member → Bool

  allB VN.null     = true
  allB (VN.bool _) = true
  allB (VN.num n)  = domR3B n
  allB (VN.str _)  = true
  allB (VN.arr vs) = allBL vs
  allB (VN.obj ms) = allBO ms

  allBL []       = true
  allBL (v ∷ vs) = allB v ∧ allBL vs

  allBO []             = true
  allBO ((_ , v) ∷ ms) = allB v ∧ allBO ms

  allB-sound  : ∀ v  → allB v   ≡ true → AllNum  DomR3 v
  allBL-sound : ∀ vs → allBL vs ≡ true → AllNumL DomR3 vs
  allBO-sound : ∀ ms → allBO ms ≡ true → AllNumO DomR3 ms

  allB-sound VN.null     _ = tt
  allB-sound (VN.bool _) _ = tt
  allB-sound (VN.num n)  e = domR3B-sound n e
  allB-sound (VN.str _)  _ = tt
  allB-sound (VN.arr vs) e = allBL-sound vs e
  allB-sound (VN.obj ms) e = allBO-sound ms e

  allBL-sound []       _ = tt
  allBL-sound (v ∷ vs) e = allB-sound v (∧-l (allB v) _ e) , allBL-sound vs (∧-r (allB v) _ e)

  allBO-sound []             _ = tt
  allBO-sound ((_ , v) ∷ ms) e = allB-sound v (∧-l (allB v) _ e) , allBO-sound ms (∧-r (allB v) _ e)

  allB-complete  : ∀ v  → AllNum  DomR3 v  → allB v   ≡ true
  allBL-complete : ∀ vs → AllNumL DomR3 vs → allBL vs ≡ true
  allBO-complete : ∀ ms → AllNumO DomR3 ms → allBO ms ≡ true

  allB-complete VN.null     _ = refl
  allB-complete (VN.bool _) _ = refl
  allB-complete (VN.num n)  d = domR3B-complete n d
  allB-complete (VN.str _)  _ = refl
  allB-complete (VN.arr vs) d = allBL-complete vs d
  allB-complete (VN.obj ms) d = allBO-complete ms d

  allBL-complete []       _        = refl
  allBL-complete (v ∷ vs) (d , ds) = ∧-i (allB-complete v d) (allBL-complete vs ds)

  allBO-complete []             _        = refl
  allBO-complete ((_ , v) ∷ ms) (d , ds) = ∧-i (allB-complete v d) (allBO-complete ms ds)

  -- The I-JSON profile as a Format: texts are value trees whose leaves
  -- are numerals (member order as written); Dom is the R3 domain.
  ProfileFormat : Format
  ProfileFormat = record
    { Bytes = VT.Value ; V = VN.Value ; p = parseV ; print = printV
    ; norm = VN.canon ; Dom = AllNum DomR3 }

  open Laws ProfileFormat

  profile-roundtrip : RoundTrip
  profile-roundtrip v d = value-rt (VN.canon v) (allnum-canon DomR3 v d)

  profile-closure : ∀ v → AllNum DomR3 v → Canonical (c v)
  profile-closure = closure VN.canon-idem profile-roundtrip (allnum-canon DomR3)

  -- R3 closure at gate level: given decidable equality of numerals, the
  -- reference check of the profile (parse, decide the R3 domain, compare
  -- with the canonical text) is a canonical gate, so check (c v) ≡ true
  -- is derived for every v in the R3 domain, not assumed.
  module Gate (tokEq : Tok → Tok → Bool)
              (tokEq-sound : ∀ a b → tokEq a b ≡ true → a ≡ b)
              (tokEq-refl  : ∀ a → tokEq a a ≡ true) where
    open ValueEq Tok tokEq tokEq-sound tokEq-refl
    open RefCheck allB allB-sound allB-complete eqV eqV-sound eqV-refl public

    profile-gate-closure : CanonicalGate checkRef
    profile-gate-closure = gate-closure VN.canon-idem profile-roundtrip (allnum-canon DomR3)

  -- The same format with the pre-R3 domain is not closed at a hole.
  old-closure-fails : ∀ n → Hole n → ¬ (Σ VN.Value (λ w → parseV (c (VN.num n)) ≡ just w))
  old-closure-fails n h (w ,Σ e) with readP (show n) | hole-refused n h
  ... | .nothing | refl with e
  ...   | ()

module ToyLift = Lift toy

toy-value-hole : ¬ (Σ (KyqValue.Value ℕ) (λ w → ToyLift.parseV (ToyLift.printV (KyqValue.num 4)) ≡ just w))
toy-value-hole = ToyLift.old-closure-fails 4 toy-hole

------------------------------------------------------------------------
-- A second non-vacuity witness, with a partial parser and a proper
-- domain: the toy profile with its reference check.  Every codec
-- hypothesis holds, and the Dom and refusal parts of TV bite.

tokEq : Numeral → Numeral → Bool
tokEq (intTok a) (intTok b) = eqN a b
tokEq (expTok a) (expTok b) = eqN a b
tokEq _          _          = false

tokEq-sound : ∀ a b → tokEq a b ≡ true → a ≡ b
tokEq-sound (intTok a) (intTok b) e = cong intTok (eqN-sound a b e)
tokEq-sound (expTok a) (expTok b) e = cong expTok (eqN-sound a b e)
tokEq-sound (intTok _) (expTok _) ()
tokEq-sound (expTok _) (intTok _) ()

tokEq-refl : ∀ a → tokEq a a ≡ true
tokEq-refl (intTok a) = eqN-refl a
tokEq-refl (expTok a) = eqN-refl a

module ToyGate = ToyLift.Gate tokEq tokEq-sound tokEq-refl
module TL = Laws ToyLift.ProfileFormat

toy-check : KyqValue.Value Numeral → Bool
toy-check = ToyGate.checkRef

toy-normidem : TL.NormIdem
toy-normidem = ToyLift.VN.canon-idem

toy-roundtrip : TL.RoundTrip
toy-roundtrip = ToyLift.profile-roundtrip

toy-gate : TL.CanonicalGate toy-check
toy-gate = ToyGate.profile-gate-closure

-- In Dom, and the output is the canonical text: TV holds.
toy-tv-in-dom : TL.TV toy-check (KyqValue.num (expTok 2)) (KyqValue.num (intTok 2))
toy-tv-in-dom =
  TL.tv-complete toy-check toy-normidem toy-roundtrip (snd toy-gate)
    (KyqValue.num (expTok 2)) (KyqValue.num 2) refl (Toy.domR3B-sound 2 refl)

-- The parser refuses the input (integer form outside the safe range):
-- no output passes TV.
toy-tv-refused : ∀ o → ¬ TL.TV toy-check (KyqValue.num (intTok 4)) o
toy-tv-refused o ((v ,Σ (() , _)) , _)

-- The input parses, but its value is outside the R3 domain (the hole):
-- no output passes TV.
toy-tv-outside-dom : ∀ o → ¬ TL.TV toy-check (KyqValue.num (expTok 4)) o
toy-tv-outside-dom o ((v ,Σ (e , d)) , _) =
  true≢false (sym (snd (subst (ToyLift.AllNum Toy.DomR3) (sym (just-inj e)) d) refl))

-- The check refuses a text whose value is in Dom but which is not the
-- canonical text, and accepts the canonical one.
toy-check-noncanonical : toy-check (KyqValue.num (expTok 2)) ≡ false
toy-check-noncanonical = refl

toy-check-canonical : toy-check (KyqValue.num (intTok 2)) ≡ true
toy-check-canonical = refl
