{-# OPTIONS --safe --without-K --cubical-compatible #-}
-- SPDX-License-Identifier: MPL-2.0
-- Negative control: MUST FAIL.  The TERMINATING escape hatch is refused
-- under --safe.
module PlantedTerminating where
open import KyqPrelude
{-# TERMINATING #-}
loop : ℕ → ℕ
loop n = loop n
