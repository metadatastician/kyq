{-# OPTIONS --safe --without-K --cubical-compatible #-}
-- SPDX-License-Identifier: MPL-2.0
-- Negative control: MUST FAIL.  In the toy profile, 4 is accepted at
-- input (as the exponent numeral expTok 4) but its printed form intTok 4
-- is an integer outside the safe range, so the profile reader refuses it:
-- the pre-R3 domain is not closed (the large-float hole).
module LargeFloatClosed where
open import KyqPrelude
open import KyqProfile
bad : Toy.readP (intTok 4) ≡ just 4
bad = refl
