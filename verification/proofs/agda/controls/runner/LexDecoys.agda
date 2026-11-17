{-# OPTIONS --safe --without-K --cubical-compatible #-}
-- SPDX-License-Identifier: MPL-2.0
-- Runner control: the lexer must find NO escape hatch here.  The word
-- postulate appears only in comments, a nested comment and a string.
module LexDecoys where
{- postulate a : Set
   {- nested: postulate b : Set -}
   still a comment: postulate c : Set -}
decoy = "postulate d : Set"
foo--postulate = decoy
