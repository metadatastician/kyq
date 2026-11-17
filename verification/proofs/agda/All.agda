{-# OPTIONS --safe --without-K --cubical-compatible #-}
-- SPDX-License-Identifier: MPL-2.0
--
-- Entry point of the kyq proof spine (P1).  Checking this module checks
-- every module of the spine.  Invocation (PROOF-POLICY §2.1):
--   agda --safe --without-K --cubical-compatible All.agda
module All where

import KyqPrelude
import KyqOrder
import KyqValue
import KyqUnique
import KyqRecursive
import KyqMeasure
import KyqCodec
import KyqModel
import KyqProfile
