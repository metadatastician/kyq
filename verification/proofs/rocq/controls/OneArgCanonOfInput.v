(* SPDX-License-Identifier: MPL-2.0 *)
(* Negative control: MUST FAIL.  The one-argument statement, universally
   quantified: "every normal form o is the canonical form of every input
   i".  It is false (KyqSpine.one_arg_not_tv), so the attempted proof is
   refused at the first case, o = VNull (verify-logic L1). *)
From KyqProofs Require Import KyqSpine.

Goal forall i o : value nat, NF nat o -> o = canon nat i.
Proof. intros i o H. destruct o; reflexivity. Qed.
