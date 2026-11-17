(* SPDX-License-Identifier: MPL-2.0 *)
(* Runner control: MUST BE REJECTED BY THE RUNNER.  A .v file in rocq/
   that the Rocq leg does not compile.  run-proofs.sh copies it into a
   scratch copy of rocq/ and requires the source-set check to flag it.
   Its content is false on purpose. *)
Lemma bad : true = false.
Proof. reflexivity. Qed.
