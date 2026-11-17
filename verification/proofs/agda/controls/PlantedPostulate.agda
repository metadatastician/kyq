{-# OPTIONS --safe --without-K --cubical-compatible #-}
-- SPDX-License-Identifier: MPL-2.0
-- Negative control: MUST FAIL.  A postulate is refused under --safe, so
-- the spine cannot silently gain an axiom.
module PlantedPostulate where
open import KyqPrelude
postulate cheat : true ≡ false
