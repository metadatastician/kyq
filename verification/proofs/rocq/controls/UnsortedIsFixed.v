(* SPDX-License-Identifier: MPL-2.0 *)
(* Negative control: MUST FAIL.  canon moves an object whose names are out
   of UTF-16 order, so it is not a fixed point of canon. *)
From KyqProofs Require Import KyqSpine.
From Coq Require Import List.
Import ListNotations.

Goal canon nat (VObj nat [([1], VNull nat); ([0], VNull nat)])
     = VObj nat [([1], VNull nat); ([0], VNull nat)].
Proof. reflexivity. Qed.
