{-# OPTIONS --safe --without-K --cubical-compatible #-}
-- SPDX-License-Identifier: MPL-2.0
--
-- JCS-5(a) at every depth, and the kernel of canon.
--
-- `_~_` is "the same I-JSON value up to object member order, at every
-- depth".  It is defined by recursion on the two values, independently
-- of canon: an object is related to another when each member has a
-- member with the same name and a related value in the other.  `WF` is
-- I-JSON's "no duplicate member name" rule, at every depth.
--
--   canon-resp : WF v → WF w → v ~ w → canon v ≡ canon w      (JCS-5(a), recursive)
--   nf-unique  : WF v → WF w → NF v → NF w → v ~ w → v ≡ w    (uniqueness of the
--                                                             canonical representative)
--   ~-canon    : v ~ canon v                                  (canon stays in the class)
--   ker-sound  : canon v ≡ canon w → v ~ w
--   ker-canon  : WF v → WF w → (canon v ≡ canon w ⇔ v ~ w)     (≈ = ker canon = ~ on WF)
--   canon-wf   : WF v → WF (canon v)
--
-- The proviso WF is necessary: see canon-resp-needs-wf (below) and
-- KyqUnique.no-unique-without-distinct.
module KyqRecursive (Num : Set) where

open import KyqPrelude
open import KyqOrder
open import KyqValue Num
open import KyqUnique Num

------------------------------------------------------------------------
-- Same value up to member order, at every depth.

_~_   : Value → Value → Set
_~L_  : List Value → List Value → Set
AllIn : List Member → List Member → Set
Match : Key → Value → List Member → Set
infix 4 _~_ _~L_

null   ~ null   = ⊤
bool a ~ bool b = a ≡ b
num a  ~ num b  = a ≡ b
str a  ~ str b  = a ≡ b
arr vs ~ arr ws = vs ~L ws
obj ms ~ obj ns = AllIn ms ns × AllIn ns ms
_      ~ _      = ⊥

[]       ~L []       = ⊤
(v ∷ vs) ~L (w ∷ ws) = (v ~ w) × (vs ~L ws)
_        ~L _        = ⊥

AllIn []             ns = ⊤
AllIn ((k , v) ∷ ms) ns = Match k v ns × AllIn ms ns

Match k v []             = ⊥
Match k v ((j , w) ∷ ns) = ((k ≡ j) × (v ~ w)) ⊎ Match k v ns

------------------------------------------------------------------------
-- Well-formed I-JSON: distinct member names at every depth.

WF  : Value → Set
WFL : List Value → Set
WFO : List Member → Set

WF null     = ⊤
WF (bool _) = ⊤
WF (num _)  = ⊤
WF (str _)  = ⊤
WF (arr vs) = WFL vs
WF (obj ms) = DistinctKeys ms × WFO ms

WFL []       = ⊤
WFL (v ∷ vs) = WF v × WFL vs

WFO []             = ⊤
WFO ((_ , v) ∷ ms) = WF v × WFO ms

------------------------------------------------------------------------
-- canonO keeps the member names.

∈-canonO : ∀ ms z → z ∈ canonO ms → Σ Member (λ m → (m ∈ ms) × (fst m ≡ fst z))
∈-canonO []             z ()
∈-canonO ((k , v) ∷ ms) z (inl e) = (k , v) ,Σ (inl refl , sym (cong fst e))
∈-canonO ((k , v) ∷ ms) z (inr i) with ∈-canonO ms z i
... | m ,Σ (mi , e) = m ,Σ (inr mi , e)

dk-canonO : ∀ ms → DistinctKeys ms → DistinctKeys (canonO ms)
dk-canonO []             _       = tt
dk-canonO ((k , v) ∷ ms) (h , d) = fresh , dk-canonO ms d
  where
  fresh : ∀ n → n ∈ canonO ms → fst n ≡ k → ⊥
  fresh n i e with ∈-canonO ms n i
  ... | m ,Σ (mi , e') = h m mi (trans e' e)

------------------------------------------------------------------------
-- canon preserves well-formedness.

wfo-insert : ∀ m ms → WF (snd m) → WFO ms → WFO (insert m ms)
wfo-insert (k , v) []             wv _          = wv , tt
wfo-insert (k , v) ((j , w) ∷ ns) wv (ww , wns) with leq k j
... | true  = wv , ww , wns
... | false = ww , wfo-insert (k , v) ns wv wns

wfo-isort : ∀ ms → WFO ms → WFO (isort ms)
wfo-isort []             _          = tt
wfo-isort ((k , v) ∷ ms) (wv , wms) = wfo-insert (k , v) (isort ms) wv (wfo-isort ms wms)

canon-wf  : ∀ v  → WF v   → WF (canon v)
canonL-wf : ∀ vs → WFL vs → WFL (canonL vs)
canonO-wf : ∀ ms → WFO ms → WFO (canonO ms)

canon-wf null     _ = tt
canon-wf (bool _) _ = tt
canon-wf (num _)  _ = tt
canon-wf (str _)  _ = tt
canon-wf (arr vs) w = canonL-wf vs w
canon-wf (obj ms) (d , w) =
  dk-isort (canonO ms) (dk-canonO ms d) , wfo-isort (canonO ms) (canonO-wf ms w)

canonL-wf []       _        = tt
canonL-wf (v ∷ vs) (w , ws) = canon-wf v w , canonL-wf vs ws

canonO-wf []             _        = tt
canonO-wf ((k , v) ∷ ms) (w , ws) = canon-wf v w , canonO-wf ms ws

------------------------------------------------------------------------
-- JCS-5(a), recursive: related well-formed values canonicalise equally.

canon-resp  : ∀ v w → WF v → WF w → v ~ w → canon v ≡ canon w
canonL-resp : ∀ vs ws → WFL vs → WFL ws → vs ~L ws → canonL vs ≡ canonL ws
sub         : ∀ ms ns → WFO ms → WFO ns → AllIn ms ns →
              ∀ z → z ∈ canonO ms → z ∈ canonO ns
match-in    : ∀ k v ns → WF v → WFO ns → Match k v ns → (k , canon v) ∈ canonO ns

canon-resp null     null     _ _ _ = refl
canon-resp (bool a) (bool b) _ _ e = cong bool e
canon-resp (num a)  (num b)  _ _ e = cong num e
canon-resp (str a)  (str b)  _ _ e = cong str e
canon-resp (arr vs) (arr ws) wv ww r = cong arr (canonL-resp vs ws wv ww r)
canon-resp (obj ms) (obj ns) (dm , wm) (dn , wn) (a , b) =
  cong obj (isort-unique (canonO ms) (canonO ns)
             (sub ms ns wm wn a , sub ns ms wn wm b)
             (dk-canonO ms dm) (dk-canonO ns dn))
canon-resp null (bool _) _ _ ()
canon-resp null (num _) _ _ ()
canon-resp null (str _) _ _ ()
canon-resp null (arr _) _ _ ()
canon-resp null (obj _) _ _ ()
canon-resp (bool _) null _ _ ()
canon-resp (bool _) (num _) _ _ ()
canon-resp (bool _) (str _) _ _ ()
canon-resp (bool _) (arr _) _ _ ()
canon-resp (bool _) (obj _) _ _ ()
canon-resp (num _) null _ _ ()
canon-resp (num _) (bool _) _ _ ()
canon-resp (num _) (str _) _ _ ()
canon-resp (num _) (arr _) _ _ ()
canon-resp (num _) (obj _) _ _ ()
canon-resp (str _) null _ _ ()
canon-resp (str _) (bool _) _ _ ()
canon-resp (str _) (num _) _ _ ()
canon-resp (str _) (arr _) _ _ ()
canon-resp (str _) (obj _) _ _ ()
canon-resp (arr _) null _ _ ()
canon-resp (arr _) (bool _) _ _ ()
canon-resp (arr _) (num _) _ _ ()
canon-resp (arr _) (str _) _ _ ()
canon-resp (arr _) (obj _) _ _ ()
canon-resp (obj _) null _ _ ()
canon-resp (obj _) (bool _) _ _ ()
canon-resp (obj _) (num _) _ _ ()
canon-resp (obj _) (str _) _ _ ()
canon-resp (obj _) (arr _) _ _ ()

canonL-resp []       []       _        _        _        = refl
canonL-resp []       (_ ∷ _)  _        _        ()
canonL-resp (_ ∷ _)  []       _        _        ()
canonL-resp (v ∷ vs) (w ∷ ws) (wv , a) (ww , b) (r , rs) =
  cong₂ _∷_ (canon-resp v w wv ww r) (canonL-resp vs ws a b rs)

sub []             ns _          _   _        z ()
sub ((k , v) ∷ ms) ns (wv , wms) wns (mt , al) z (inl e) =
  subst (λ q → q ∈ canonO ns) (sym e) (match-in k v ns wv wns mt)
sub ((k , v) ∷ ms) ns (wv , wms) wns (mt , al) z (inr i) = sub ms ns wms wns al z i

match-in k v []             _  _          ()
match-in k v ((j , w) ∷ ns) wv (ww , wns) (inl (refl , r)) =
  inl (cong (pair k) (canon-resp v w wv ww r))
match-in k v ((j , w) ∷ ns) wv (ww , wns) (inr m) = inr (match-in k v ns wv wns m)

------------------------------------------------------------------------
-- Uniqueness of canonical representatives: in each ~-class of
-- well-formed values there is exactly one normal form.

nf-unique : ∀ v w → WF v → WF w → NF v → NF w → v ~ w → v ≡ w
nf-unique v w wv ww nv nw r =
  trans (sym (nf-fixed v nv)) (trans (canon-resp v w wv ww r) (nf-fixed w nw))

------------------------------------------------------------------------
-- ~ is symmetric and transitive (no well-formedness needed).

~-sym  : ∀ v w → v ~ w → w ~ v
~L-sym : ∀ vs ws → vs ~L ws → ws ~L vs

~-sym null     null     _ = tt
~-sym (bool a) (bool b) e = sym e
~-sym (num a)  (num b)  e = sym e
~-sym (str a)  (str b)  e = sym e
~-sym (arr vs) (arr ws) r = ~L-sym vs ws r
~-sym (obj ms) (obj ns) (a , b) = b , a
~-sym null (bool _) ()
~-sym null (num _) ()
~-sym null (str _) ()
~-sym null (arr _) ()
~-sym null (obj _) ()
~-sym (bool _) null ()
~-sym (bool _) (num _) ()
~-sym (bool _) (str _) ()
~-sym (bool _) (arr _) ()
~-sym (bool _) (obj _) ()
~-sym (num _) null ()
~-sym (num _) (bool _) ()
~-sym (num _) (str _) ()
~-sym (num _) (arr _) ()
~-sym (num _) (obj _) ()
~-sym (str _) null ()
~-sym (str _) (bool _) ()
~-sym (str _) (num _) ()
~-sym (str _) (arr _) ()
~-sym (str _) (obj _) ()
~-sym (arr _) null ()
~-sym (arr _) (bool _) ()
~-sym (arr _) (num _) ()
~-sym (arr _) (str _) ()
~-sym (arr _) (obj _) ()
~-sym (obj _) null ()
~-sym (obj _) (bool _) ()
~-sym (obj _) (num _) ()
~-sym (obj _) (str _) ()
~-sym (obj _) (arr _) ()

~L-sym []       []       _        = tt
~L-sym []       (_ ∷ _)  ()
~L-sym (_ ∷ _)  []       ()
~L-sym (v ∷ vs) (w ∷ ws) (r , rs) = ~-sym v w r , ~L-sym vs ws rs

~-trans     : ∀ u v w → u ~ v → v ~ w → u ~ w
~L-trans    : ∀ us vs ws → us ~L vs → vs ~L ws → us ~L ws
allin-trans : ∀ ms ns ps → AllIn ms ns → AllIn ns ps → AllIn ms ps
match-trans : ∀ k v ns ps → Match k v ns → AllIn ns ps → Match k v ps
match-pre   : ∀ k v w ps → v ~ w → Match k w ps → Match k v ps

~-trans null     null     null     _ _ = tt
~-trans (bool a) (bool b) (bool c) p q = trans p q
~-trans (num a)  (num b)  (num c)  p q = trans p q
~-trans (str a)  (str b)  (str c)  p q = trans p q
~-trans (arr us) (arr vs) (arr ws) p q = ~L-trans us vs ws p q
~-trans (obj ms) (obj ns) (obj ps) (a1 , b1) (a2 , b2) =
  allin-trans ms ns ps a1 a2 , allin-trans ps ns ms b2 b1
~-trans null (bool _) _ () _
~-trans null (num _) _ () _
~-trans null (str _) _ () _
~-trans null (arr _) _ () _
~-trans null (obj _) _ () _
~-trans (bool _) null _ () _
~-trans (bool _) (num _) _ () _
~-trans (bool _) (str _) _ () _
~-trans (bool _) (arr _) _ () _
~-trans (bool _) (obj _) _ () _
~-trans (num _) null _ () _
~-trans (num _) (bool _) _ () _
~-trans (num _) (str _) _ () _
~-trans (num _) (arr _) _ () _
~-trans (num _) (obj _) _ () _
~-trans (str _) null _ () _
~-trans (str _) (bool _) _ () _
~-trans (str _) (num _) _ () _
~-trans (str _) (arr _) _ () _
~-trans (str _) (obj _) _ () _
~-trans (arr _) null _ () _
~-trans (arr _) (bool _) _ () _
~-trans (arr _) (num _) _ () _
~-trans (arr _) (str _) _ () _
~-trans (arr _) (obj _) _ () _
~-trans (obj _) null _ () _
~-trans (obj _) (bool _) _ () _
~-trans (obj _) (num _) _ () _
~-trans (obj _) (str _) _ () _
~-trans (obj _) (arr _) _ () _
~-trans null null (bool _) _ ()
~-trans null null (num _) _ ()
~-trans null null (str _) _ ()
~-trans null null (arr _) _ ()
~-trans null null (obj _) _ ()
~-trans (bool _) (bool _) null _ ()
~-trans (bool _) (bool _) (num _) _ ()
~-trans (bool _) (bool _) (str _) _ ()
~-trans (bool _) (bool _) (arr _) _ ()
~-trans (bool _) (bool _) (obj _) _ ()
~-trans (num _) (num _) null _ ()
~-trans (num _) (num _) (bool _) _ ()
~-trans (num _) (num _) (str _) _ ()
~-trans (num _) (num _) (arr _) _ ()
~-trans (num _) (num _) (obj _) _ ()
~-trans (str _) (str _) null _ ()
~-trans (str _) (str _) (bool _) _ ()
~-trans (str _) (str _) (num _) _ ()
~-trans (str _) (str _) (arr _) _ ()
~-trans (str _) (str _) (obj _) _ ()
~-trans (arr _) (arr _) null _ ()
~-trans (arr _) (arr _) (bool _) _ ()
~-trans (arr _) (arr _) (num _) _ ()
~-trans (arr _) (arr _) (str _) _ ()
~-trans (arr _) (arr _) (obj _) _ ()
~-trans (obj _) (obj _) null _ ()
~-trans (obj _) (obj _) (bool _) _ ()
~-trans (obj _) (obj _) (num _) _ ()
~-trans (obj _) (obj _) (str _) _ ()
~-trans (obj _) (obj _) (arr _) _ ()

~L-trans []       []       []       _        _        = tt
~L-trans []       []       (_ ∷ _)  _        ()
~L-trans []       (_ ∷ _)  _        ()       _
~L-trans (_ ∷ _)  []       _        ()       _
~L-trans (_ ∷ _)  (_ ∷ _)  []       _        ()
~L-trans (u ∷ us) (v ∷ vs) (w ∷ ws) (p , ps) (q , qs) =
  ~-trans u v w p q , ~L-trans us vs ws ps qs

allin-trans []             ns ps _       _ = tt
allin-trans ((k , v) ∷ ms) ns ps (m , a) b = match-trans k v ns ps m b , allin-trans ms ns ps a b

match-trans k v []             ps ()
match-trans k v ((j , w) ∷ ns) ps (inl (refl , r)) (mw , _) = match-pre k v w ps r mw
match-trans k v ((j , w) ∷ ns) ps (inr m)          (_ , a)  = match-trans k v ns ps m a

match-pre k v w []             _ ()
match-pre k v w ((j , u) ∷ ps) r (inl (e , s)) = inl (e , ~-trans v w u r s)
match-pre k v w ((j , u) ∷ ps) r (inr m)       = inr (match-pre k v w ps r m)

------------------------------------------------------------------------
-- canon stays in the ~-class of its input.

∈-match : ∀ k v z ys → z ∈ ys → k ≡ fst z → v ~ snd z → Match k v ys
∈-match k v z []             ()
∈-match k v z ((j , w) ∷ ys) (inl e) ek r =
  inl (trans ek (cong fst e) , subst (λ q → v ~ snd q) e r)
∈-match k v z ((j , w) ∷ ys) (inr i) ek r = inr (∈-match k v z ys i ek r)

match-sub : ∀ k v xs ys → (∀ z → z ∈ xs → z ∈ ys) → Match k v xs → Match k v ys
match-sub k v []             ys h ()
match-sub k v ((j , w) ∷ xs) ys h (inl (e , r)) = ∈-match k v (j , w) ys (h (j , w) (inl refl)) e r
match-sub k v ((j , w) ∷ xs) ys h (inr m)       = match-sub k v xs ys (λ z i → h z (inr i)) m

allin-sub : ∀ ms xs ys → (∀ z → z ∈ xs → z ∈ ys) → AllIn ms xs → AllIn ms ys
allin-sub []             xs ys h _       = tt
allin-sub ((k , v) ∷ ms) xs ys h (m , a) = match-sub k v xs ys h m , allin-sub ms xs ys h a

allin-weak : ∀ ms y ys → AllIn ms ys → AllIn ms (y ∷ ys)
allin-weak ms y ys a = allin-sub ms ys (y ∷ ys) (λ z i → inr i) a

allin-of : ∀ xs ys → (∀ z → z ∈ xs → Match (fst z) (snd z) ys) → AllIn xs ys
allin-of []             ys h = tt
allin-of ((k , v) ∷ xs) ys h = h (k , v) (inl refl) , allin-of xs ys (λ z i → h z (inr i))

~-canon     : ∀ v  → v ~ canon v
~L-canon    : ∀ vs → vs ~L canonL vs
allin-canon : ∀ ms → AllIn ms (canonO ms)
canon-match : ∀ ms z → z ∈ canonO ms → Match (fst z) (snd z) ms

~-canon null     = tt
~-canon (bool b) = refl
~-canon (num n)  = refl
~-canon (str s)  = refl
~-canon (arr vs) = ~L-canon vs
~-canon (obj ms) =
  allin-sub ms (canonO ms) (isort (canonO ms)) (∈-isort-out (canonO ms)) (allin-canon ms) ,
  allin-of (isort (canonO ms)) ms
    (λ z i → canon-match ms z (∈-isort-in (canonO ms) z i))

~L-canon []       = tt
~L-canon (v ∷ vs) = ~-canon v , ~L-canon vs

allin-canon []             = tt
allin-canon ((k , v) ∷ ms) =
  inl (refl , ~-canon v) , allin-weak ms (k , canon v) (canonO ms) (allin-canon ms)

canon-match []             z ()
canon-match ((k , v) ∷ ms) z (inl e) =
  inl (cong fst e , subst (λ q → snd q ~ v) (sym e) (~-sym v (canon v) (~-canon v)))
canon-match ((k , v) ∷ ms) z (inr i) = inr (canon-match ms z i)

------------------------------------------------------------------------
-- The kernel of canon is exactly ~ on well-formed values.

ker-sound : ∀ v w → canon v ≡ canon w → v ~ w
ker-sound v w e =
  ~-trans v (canon w) w (subst (λ q → v ~ q) e (~-canon v))
                        (~-sym w (canon w) (~-canon w))

ker-canon : ∀ v w → WF v → WF w → (canon v ≡ canon w) ⇔ (v ~ w)
ker-canon v w wv ww = ker-sound v w , canon-resp v w wv ww

------------------------------------------------------------------------
-- WF is necessary for canon-resp: two orders of an object with a
-- duplicated name are ~-related but canonicalise differently.

dup-sim : obj dupA ~ obj dupB
dup-sim = (inr (inl (refl , refl)) , inl (refl , refl) , tt) ,
          (inr (inl (refl , refl)) , inl (refl , refl) , tt)

canon-resp-needs-wf : ¬ (∀ v w → v ~ w → canon v ≡ canon w)
canon-resp-needs-wf h with h (obj dupA) (obj dupB) dup-sim
... | ()
