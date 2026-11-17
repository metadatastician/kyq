{-# OPTIONS --safe --without-K --cubical-compatible #-}
-- SPDX-License-Identifier: MPL-2.0
-- Runner control: the lexer must find the escape hatch here.  The
-- postulate follows a nested block comment on the same line, which a
-- line-based comment strip mistakes for comment text.
module LexHidden where
data ⊥ : Set where
{- outer {- inner -} still comment -} postulate
  hidden : ⊥
