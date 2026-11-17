{-# OPTIONS --safe --without-K --cubical-compatible #-}
-- SPDX-License-Identifier: MPL-2.0
--
-- The abstract codec layer of the spine (verify-logic L1, L2, L3).
--
-- A Format has texts (Bytes), a value algebra V with its value-level
-- canoniser `norm`, a partial parser p : Bytes → Maybe V (refusal is
-- `nothing`: fail-closed), a printer, and a profile domain Dom.  Nothing
-- about p or print is assumed by the record itself: each property is a
-- separate, named hypothesis, and every theorem lists the ones it uses.
--
--   ≈            the kernel of norm (v ≈ w iff norm v ≡ norm w).  A
--                Crossing takes no ≈ parameter, but ≈ is only as good as
--                the Format's `norm`, which is a field of the Format: a
--                Format whose norm is constant makes a converter that drops
--                everything Faithful≈ (KyqModel.coarse-norm-faithful).  So
--                ≈ means something only together with NormSeparates sem,
--                for an equivalence `sem` defined independently of norm
--                (for JSON: KyqRecursive._~_).  `sem` and the Format
--                instance are definitions to audit (trust boundary).
--   c            the canonical printer, c v = print (norm v)
--   RoundTrip    ∀ v ∈ Dom.  p (c v) ≡ just (norm v)
--   NonMalleable check b ≡ true → b ∈ Dom and b ≡ c (p b)
--   Complete     ∀ v ∈ Dom.  check (c v) ≡ true   (check ∘ c = OK; a
--                hypothesis on a given check, derived only for checkRef)
--   CanonicalGate = NonMalleable × Complete            (KYAML, JCS)
--   ValidityGate  = check b ≡ true ⇔ b ∈ Dom           (TOML, Dhall)
--
-- The definition has no header or trivia component: b must be exactly
-- c v.  verify-logic L3 asks for b = h ++ c v with a preserved header h.
-- Without it a KYAML instance must refuse every SPDX-headed file; this is
-- an open definitional gap (PROOF-STATUS, "What is NOT proven").
--
-- Theorems:
--   closure      Canonical (c v), the accept-set half of JCS-10, from
--                NormIdem + RoundTrip + DomClosed.  It does NOT give
--                check (c v) ≡ true: that is Complete check.
--   RefCheck.gate-closure  for the reference check checkRef (parse, decide
--                Dom, compare with c), CanonicalGate checkRef follows from
--                NormIdem + RoundTrip + DomClosed: check (c v) ≡ true is
--                derived there, not assumed
--   tv-sound     the TWO-argument translation-validation theorem: from
--                canonical(out) (check out ≡ true, NonMalleable) and
--                p out ≈ p in, with in ∈ Dom, conclude out ≡ c (p in)
--   tv-complete  conversely, c (p in) passes TV (RoundTrip, Complete, norm idempotent)
--   tv-iff       TV in out ⇔ in ∈ Dom ∧ out ≡ c (p in)
--   canonical-gate-valid  a canonical gate accepts only texts in Dom
--
-- Crossings (converters) between formats:
--   Faithful≈ img check := RoundTrip≈ × Covered≈ img × NonMalleable check
--   FaithfulSem sem img check := NormSeparates sem × Faithful≈ img check;
--     sem-roundtrip: under it, back ∘ fwd is the identity up to sem
--   declared losses are a separate quotient ≋ ⊇ ≈ that sets the grade:
--     upto-lossless : ≋ ⊆ ≈ → RoundTrip≋ → RoundTrip≈
--     roundtrip-upto: RoundTrip≈ → RoundTrip≋
--   free-≈-trivial: were ≈ a free parameter, every crossing would round-trip
--   roundtrip-compose / covered-compose / faithful-compose: FID-1 for
--     Faithful≈, under the congruence and domain-chaining hypotheses it
--     needs (verify-logic L8).  Grade composition (by max) is not proved.
module KyqCodec where

open import KyqPrelude

record Format : Set₁ where
  field
    Bytes : Set
    V     : Set
    p     : Bytes → Maybe V
    print : V → Bytes
    norm  : V → V
    Dom   : V → Set

module Laws (F : Format) where
  open Format F

  -- ≈ is the kernel of norm.  It is fixed by the Format, not by a
  -- crossing; it is meaningful only under NormSeparates (below).
  _≈_ : V → V → Set
  v ≈ w = norm v ≡ norm w
  infix 4 _≈_

  ≈-refl : ∀ v → v ≈ v
  ≈-refl v = refl

  ≈-sym : ∀ v w → v ≈ w → w ≈ v
  ≈-sym v w = sym

  ≈-trans : ∀ u v w → u ≈ v → v ≈ w → u ≈ w
  ≈-trans u v w = trans

  -- ≈ lifted to texts: both parse, and the values are related.
  _≈ᵇ_ : Bytes → Bytes → Set
  b ≈ᵇ b' = Σ V (λ v → Σ V (λ v' → (p b ≡ just v) × (p b' ≡ just v') × (v ≈ v')))

  c : V → Bytes
  c v = print (norm v)

  InDom : Bytes → Set
  InDom b = Σ V (λ v → (p b ≡ just v) × Dom v)

  NormIdem : Set
  NormIdem = ∀ v → norm (norm v) ≡ norm v

  RoundTrip : Set
  RoundTrip = ∀ v → Dom v → p (c v) ≡ just (norm v)

  NonMalleable : (Bytes → Bool) → Set
  NonMalleable check =
    ∀ b → check b ≡ true → Σ V (λ v → (p b ≡ just v) × Dom v × (b ≡ c v))

  Complete : (Bytes → Bool) → Set
  Complete check = ∀ v → Dom v → check (c v) ≡ true

  CanonicalGate : (Bytes → Bool) → Set
  CanonicalGate check = NonMalleable check × Complete check

  ValidityGate : (Bytes → Bool) → Set
  ValidityGate check = ∀ b → (check b ≡ true) ⇔ InDom b

  -- RoundTrip gives the round trip modulo ≈.
  roundtrip≈ : NormIdem → RoundTrip → ∀ v → Dom v →
               Σ V (λ w → (p (c v) ≡ just w) × (w ≈ v))
  roundtrip≈ idem rt v d = norm v ,Σ (rt v d , idem v)

  -- c is ≈-invariant: it factors through norm by definition.
  c-resp : ∀ v w → v ≈ w → c v ≡ c w
  c-resp v w e = cong print e

  -- The accept set a canonical gate specifies: b is in Dom and is the
  -- canonical text of its own value.  NonMalleable check is check ⊆ Canonical.
  Canonical : Bytes → Set
  Canonical b = Σ V (λ v → (p b ≡ just v) × Dom v × (b ≡ c v))

  DomClosed : Set
  DomClosed = ∀ v → Dom v → Dom (norm v)

  -- The accept-set half of JCS-10 (verify-logic L7): from NormIdem,
  -- RoundTrip and DomClosed, every canonical output lies in the Canonical
  -- set.  It is not a separate hypothesis on numbers.  It says nothing
  -- about a given check: check (c v) ≡ true is Complete check, which is
  -- derived below only for the reference check checkRef.
  closure : NormIdem → RoundTrip → DomClosed → ∀ v → Dom v → Canonical (c v)
  closure idem rt dc v d = norm v ,Σ (rt v d , dc v d , cong print (sym (idem v)))

  -- norm is no coarser than an independently defined equivalence sem:
  -- ≈ identifies only values that sem identifies.  Without it ≈ can be
  -- made total by the choice of norm (KyqModel.coarse-norm-faithful).
  NormSeparates : (V → V → Set) → Set
  NormSeparates sem = ∀ v w → norm v ≡ norm w → sem v w

  ----------------------------------------------------------------------
  -- The reference check: parse, decide Dom, compare with the canonical
  -- text.  Given a decision procedure for Dom and for equality of texts,
  -- it is a canonical gate, and check ∘ c = OK is DERIVED from RoundTrip,
  -- NormIdem and DomClosed (gate-level closure, ruling R3), not assumed.

  module RefCheck (domB : V → Bool)
                  (domB-sound    : ∀ v → domB v ≡ true → Dom v)
                  (domB-complete : ∀ v → Dom v → domB v ≡ true)
                  (eqB : Bytes → Bytes → Bool)
                  (eqB-sound : ∀ a b → eqB a b ≡ true → a ≡ b)
                  (eqB-refl  : ∀ a → eqB a a ≡ true) where

    chk : Bytes → Maybe V → Bool
    chk b nothing  = false
    chk b (just v) = domB v ∧ eqB b (c v)

    checkRef : Bytes → Bool
    checkRef b = chk b (p b)

    chk-sound : ∀ b m → chk b m ≡ true → Σ V (λ v → (m ≡ just v) × Dom v × (b ≡ c v))
    chk-sound b nothing  ()
    chk-sound b (just v) ok =
      v ,Σ (refl , domB-sound v (∧-l (domB v) _ ok) , eqB-sound b (c v) (∧-r (domB v) _ ok))

    ref-nonmalleable : NonMalleable checkRef
    ref-nonmalleable b ok = chk-sound b (p b) ok

    ref-complete : NormIdem → RoundTrip → DomClosed → Complete checkRef
    ref-complete idem rt dc v d =
      subst (λ m → chk (c v) m ≡ true) (sym (rt v d))
        (∧-i (domB-complete (norm v) (dc v d))
             (subst (λ x → eqB (c v) (print x) ≡ true) (sym (idem v)) (eqB-refl (c v))))

    gate-closure : NormIdem → RoundTrip → DomClosed → CanonicalGate checkRef
    gate-closure idem rt dc = ref-nonmalleable , ref-complete idem rt dc

  -- Conversely, closure at v forces the parser to accept c v.
  closure-parses : ∀ v → Canonical (c v) → Σ V (λ w → p (c v) ≡ just w)
  closure-parses v (w ,Σ (e , _ , _)) = w ,Σ e

  canonical-gate-valid : (check : Bytes → Bool) → NonMalleable check →
                         ∀ b → check b ≡ true → InDom b
  canonical-gate-valid check nm b ok with nm b ok
  ... | v ,Σ (pb , d , _) = v ,Σ (pb , d)

  ----------------------------------------------------------------------
  -- Translation validation: a relation on (input, output), not a
  -- property of the output alone.

  TV : (Bytes → Bool) → Bytes → Bytes → Set
  TV check i o = InDom i × (check o ≡ true) × (o ≈ᵇ i)

  -- Soundness uses only NonMalleable(check).  Nothing is assumed of p.
  tv-sound : (check : Bytes → Bool) → NonMalleable check →
             ∀ i o vi → p i ≡ just vi → Dom vi →
             check o ≡ true → (Σ V (λ vo → (p o ≡ just vo) × (vo ≈ vi))) →
             o ≡ c vi
  tv-sound check nm i o vi pi d ok (vo ,Σ (po , r)) with nm o ok
  ... | vo' ,Σ (po' , _ , e) =
    trans e (c-resp vo' vi (subst (λ x → x ≈ vi) (just-inj (trans (sym po) po')) r))

  -- Completeness uses RoundTrip, Complete(check) and idempotence of norm.
  tv-complete : (check : Bytes → Bool) → NormIdem → RoundTrip → Complete check →
                ∀ i vi → p i ≡ just vi → Dom vi → TV check i (c vi)
  tv-complete check idem rt cp i vi pi d =
    (vi ,Σ (pi , d)) , cp vi d , (norm vi ,Σ (vi ,Σ (rt vi d , pi , idem vi)))

  tv-iff : (check : Bytes → Bool) → NormIdem → RoundTrip → CanonicalGate check →
           ∀ i o → TV check i o ⇔ Σ V (λ vi → (p i ≡ just vi) × Dom vi × (o ≡ c vi))
  tv-iff check idem rt (nm , cp) i o = to , from
    where
    to : TV check i o → Σ V (λ vi → (p i ≡ just vi) × Dom vi × (o ≡ c vi))
    to ((vi ,Σ (pi , d)) , ok , (vo ,Σ (vi' ,Σ (po , pi' , r)))) =
      vi ,Σ (pi , d ,
        tv-sound check nm i o vi pi d ok
          (vo ,Σ (po , subst (λ x → vo ≈ x) (just-inj (trans (sym pi') pi)) r)))
    from : Σ V (λ vi → (p i ≡ just vi) × Dom vi × (o ≡ c vi)) → TV check i o
    from (vi ,Σ (pi , d , refl)) = tv-complete check idem rt cp i vi pi d

------------------------------------------------------------------------
-- Crossings: converters between two formats, at value level.

record Crossing (S T : Format) : Set where
  field
    fwd  : Format.V S → Format.V T
    back : Format.V T → Format.V S

module CrossingLaws {S T : Format} (X : Crossing S T) where
  open Crossing X
  module S = Format S
  module T = Format T
  module LS = Laws S
  module LT = Laws T

  RoundTrip≈ : Set
  RoundTrip≈ = ∀ s → S.Dom s → LS._≈_ (back (fwd s)) s

  -- No phantom: every target value in the image predicate img (NOT the
  -- set check_T accepts) has a source in Dom, up to ≈_T.
  Covered≈ : (Format.V T → Set) → Set
  Covered≈ img = ∀ t → img t → Σ S.V (λ s → S.Dom s × LT._≈_ (fwd s) t)

  -- `img` is a parameter: it says which target values must have a
  -- source.  Covered≈ is vacuous at img = ⊥ and trivial at img = the image
  -- of fwd; KyqModel.wrap-not-covered shows it failing at img = ⊤ for an
  -- embedding into a larger target.  A crossing fixes img per output as
  -- its "no invented field" predicate, and that predicate is audited with
  -- the Format instances (trust boundary).
  Faithful≈ : (Format.V T → Set) → (T.Bytes → Bool) → Set
  Faithful≈ img check = RoundTrip≈ × Covered≈ img × LT.NonMalleable check

  -- Faithful≈ together with NormSeparates for the source: the round trip
  -- is then the identity up to the independent equivalence sem.
  FaithfulSem : (S.V → S.V → Set) → (Format.V T → Set) → (T.Bytes → Bool) → Set
  FaithfulSem sem img check = LS.NormSeparates sem × Faithful≈ img check

  sem-roundtrip : (sem : S.V → S.V → Set) → LS.NormSeparates sem → RoundTrip≈ →
                  ∀ s → S.Dom s → sem (back (fwd s)) s
  sem-roundtrip sem ns rt s d = ns (back (fwd s)) s (rt s d)

  -- Were ≈ a free parameter of the crossing, choosing the total
  -- relation would make every crossing round-trip (verify-logic L2(c)).
  RoundTripWrt : (S.V → S.V → Set) → Set
  RoundTripWrt R = ∀ s → S.Dom s → R (back (fwd s)) s

  free-≈-trivial : RoundTripWrt (λ _ _ → ⊤)
  free-≈-trivial s _ = tt

-- Declared losses: an explicit quotient of the source, coarser than ≈_S.
-- It never replaces ≈_S; it only decides the grade.
record DeclaredLoss (S : Format) : Set₁ where
  field
    _≋_     : Format.V S → Format.V S → Set
    coarser : ∀ s s' → Laws._≈_ S s s' → s ≋ s'

data Grade : Set where
  lossless declared-loss : Grade

module LossLaws {S T : Format} (X : Crossing S T) (L : DeclaredLoss S) where
  open Crossing X
  open DeclaredLoss L
  open CrossingLaws X

  RoundTrip≋ : Set
  RoundTrip≋ = RoundTripWrt _≋_

  roundtrip-upto : RoundTrip≈ → RoundTrip≋
  roundtrip-upto rt s d = coarser (back (fwd s)) s (rt s d)

  -- The grade is lossless exactly when the declared quotient adds
  -- nothing to ≈_S.
  Collapses : Set
  Collapses = ∀ s s' → s ≋ s' → Laws._≈_ S s s'

  upto-lossless : Collapses → RoundTrip≋ → RoundTrip≈
  upto-lossless col rt s d = col (back (fwd s)) s (rt s d)

  -- The grade is derived from evidence, never asserted.
  GradeEvidence : Grade → Set
  GradeEvidence lossless      = RoundTrip≈
  GradeEvidence declared-loss = RoundTrip≋

  declared-from-lossless : GradeEvidence lossless → GradeEvidence declared-loss
  declared-from-lossless = roundtrip-upto

------------------------------------------------------------------------
-- FID-1 (composition), under its hypotheses.

compose : {S M U : Format} → Crossing S M → Crossing M U → Crossing S U
compose X Y = record
  { fwd  = λ s → Crossing.fwd Y (Crossing.fwd X s)
  ; back = λ u → Crossing.back X (Crossing.back Y u) }

module Compose {S M U : Format} (X : Crossing S M) (Y : Crossing M U) where
  module S = Format S
  module M = Format M
  module U = Format U
  module LS = Laws S
  module LM = Laws M
  module LU = Laws U
  open Crossing X renaming (fwd to f₁; back to b₁)
  open Crossing Y renaming (fwd to f₂; back to b₂)
  module CX = CrossingLaws X
  module CY = CrossingLaws Y
  module CXY = CrossingLaws (compose X Y)

  -- Hypotheses FID-1 needs and the dossier left unstated.
  Chain : Set                      -- domains chain
  Chain = ∀ s → S.Dom s → M.Dom (f₁ s)

  BackCong : Set                   -- back₁ is a setoid morphism
  BackCong = ∀ m m' → LM._≈_ m m' → LS._≈_ (b₁ m) (b₁ m')

  FwdCong : Set                    -- fwd₂ is a setoid morphism
  FwdCong = ∀ m m' → LM._≈_ m m' → LU._≈_ (f₂ m) (f₂ m')

  ImgChain : (M.V → Set) → (U.V → Set) → Set
  ImgChain imgM imgU = ∀ u → imgU u → Σ M.V (λ m → imgM m × LU._≈_ (f₂ m) u)

  roundtrip-compose : Chain → BackCong → CX.RoundTrip≈ → CY.RoundTrip≈ → CXY.RoundTrip≈
  roundtrip-compose ch bc rx ry s d =
    trans (bc (b₂ (f₂ (f₁ s))) (f₁ s) (ry (f₁ s) (ch s d))) (rx s d)

  covered-compose : (imgM : M.V → Set) (imgU : U.V → Set) →
                    FwdCong → ImgChain imgM imgU → CX.Covered≈ imgM → CXY.Covered≈ imgU
  covered-compose imgM imgU fc ic cx u iu with ic u iu
  ... | m ,Σ (im , e) with cx m im
  ...   | s ,Σ (d , e') = s ,Σ (d , trans (fc (f₁ s) m e') e)

  -- Faithful≈ composes: the round trip and coverage by the two lemmas
  -- above, non-malleability from Y's target check.  Y's own Covered≈ is
  -- not needed: ImgChain carries coverage through the middle format.
  faithful-compose : (imgM : M.V → Set) (imgU : U.V → Set)
                     (checkM : M.Bytes → Bool) (checkU : U.Bytes → Bool) →
                     Chain → BackCong → FwdCong → ImgChain imgM imgU →
                     CX.Faithful≈ imgM checkM → CY.Faithful≈ imgU checkU →
                     CXY.Faithful≈ imgU checkU
  faithful-compose imgM imgU checkM checkU ch bc fc ic (rx , cx , _) (ry , _ , nmU) =
    roundtrip-compose ch bc rx ry , covered-compose imgM imgU fc ic cx , nmU
