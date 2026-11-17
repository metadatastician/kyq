(* SPDX-License-Identifier: MPL-2.0 *)
(* Rocq recheck leg of the kyq proof spine (P1), re-proved by hand from
   the Agda statements in ../agda.  It restates and proves:

     leq_total / leq_antisym / leq_trans  (KyqOrder)
     canon_nf, nf_fixed, canon_idem       (KyqValue: c o c = c)
     sorted_unique, isort_unique          (KyqUnique: one object level)
     no_unique_without_distinct           (KyqUnique: the proviso is needed)
     canon_resp, nf_unique                (KyqRecursive: every depth)
     tv_sound, tv_complete, tv_iff        (KyqCodec: two-argument TV)
     one_arg_not_tv                       (KyqModel: one-arg-not-tv, over NF)

   Only the Coq standard library that ships with coqc is used (List,
   Permutation, Bool, Arith, Lia); no external library.  Numbers are a
   section variable [Num], so after the section closes every theorem is
   universally quantified over it: a parameter, not an axiom.  The
   statement correspondence with Agda is recorded in ../agda/README.adoc
   ("Statement correspondence, Agda <-> Rocq"). *)

From Coq Require Import List Bool Arith Lia Permutation.
Import ListNotations.

Section Spine.

Variable Num : Type.

Definition key := list nat.

(* RFC 8785 member order: lexicographic on UTF-16 code units (as nat). *)
Fixpoint leq (x y : key) : bool :=
  match x, y with
  | [], _ => true
  | _ :: _, [] => false
  | a :: x', b :: y' =>
      if Nat.ltb a b then true else if Nat.eqb a b then leq x' y' else false
  end.

Lemma leq_total : forall x y, leq x y = false -> leq y x = true.
Proof.
  induction x as [|a x IH]; intros [|b y] H; simpl in *; try discriminate; auto.
  destruct (Nat.ltb a b) eqn:L1; try discriminate.
  destruct (Nat.eqb a b) eqn:E1.
  - apply Nat.eqb_eq in E1; subst.
    rewrite Nat.ltb_irrefl, Nat.eqb_refl. auto.
  - apply Nat.ltb_ge in L1. apply Nat.eqb_neq in E1.
    assert (b < a) by lia. apply Nat.ltb_lt in H0. rewrite H0. reflexivity.
Qed.

Lemma leq_antisym : forall x y, leq x y = true -> leq y x = true -> x = y.
Proof.
  induction x as [|a x IH]; intros [|b y] H1 H2; simpl in *; try discriminate; auto.
  destruct (Nat.ltb a b) eqn:L1; destruct (Nat.ltb b a) eqn:L2.
  - apply Nat.ltb_lt in L1, L2. lia.
  - apply Nat.ltb_lt in L1. apply Nat.ltb_ge in L2.
    destruct (Nat.eqb b a) eqn:E2; try discriminate.
    apply Nat.eqb_eq in E2. lia.
  - apply Nat.ltb_lt in L2. apply Nat.ltb_ge in L1.
    destruct (Nat.eqb a b) eqn:E1; try discriminate.
    apply Nat.eqb_eq in E1. lia.
  - destruct (Nat.eqb a b) eqn:E1; try discriminate.
    apply Nat.eqb_eq in E1; subst. rewrite Nat.eqb_refl in H2.
    f_equal. apply IH; auto.
Qed.

Lemma leq_trans : forall x y z, leq x y = true -> leq y z = true -> leq x z = true.
Proof.
  induction x as [|a x IH]; intros [|b y] [|c z] H1 H2; simpl in *; try discriminate; auto.
  destruct (Nat.ltb a b) eqn:L1; destruct (Nat.ltb b c) eqn:L2.
  - apply Nat.ltb_lt in L1, L2. assert (a < c) by lia. apply Nat.ltb_lt in H. now rewrite H.
  - apply Nat.ltb_lt in L1. destruct (Nat.eqb b c) eqn:E2; try discriminate.
    apply Nat.eqb_eq in E2; subst. apply Nat.ltb_lt in L1. now rewrite L1.
  - destruct (Nat.eqb a b) eqn:E1; try discriminate.
    apply Nat.eqb_eq in E1; subst. now rewrite L2.
  - destruct (Nat.eqb a b) eqn:E1; try discriminate.
    destruct (Nat.eqb b c) eqn:E2; try discriminate.
    apply Nat.eqb_eq in E1, E2; subst.
    rewrite Nat.ltb_irrefl, Nat.eqb_refl. eapply IH; eauto.
Qed.

(* ------------------------------------------------------------------ *)
(* Insertion sort by key, generic in the member payload.               *)

Section Sort.
Variable A : Type.

Fixpoint insert (m : key * A) (l : list (key * A)) : list (key * A) :=
  match l with
  | [] => [m]
  | n :: l' => if leq (fst m) (fst n) then m :: n :: l' else n :: insert m l'
  end.

Fixpoint isort (l : list (key * A)) : list (key * A) :=
  match l with
  | [] => []
  | m :: l' => insert m (isort l')
  end.

Fixpoint sorted (l : list (key * A)) : Prop :=
  match l with
  | [] => True
  | m :: l' =>
      match l' with
      | [] => True
      | n :: _ => leq (fst m) (fst n) = true /\ sorted l'
      end
  end.

Lemma sorted_tail : forall m l, sorted (m :: l) -> sorted l.
Proof. intros m [|n l] H; simpl in *; tauto. Qed.

Lemma insert_sorted : forall m l, sorted l -> sorted (insert m l).
Proof.
  intros m l. induction l as [|n l IH]; intros H; simpl; auto.
  destruct (leq (fst m) (fst n)) eqn:E.
  - simpl. split; auto.
  - apply leq_total in E.
    destruct l as [|q l]; simpl in *.
    + split; auto.
    + destruct H as [Hnq Hs].
      specialize (IH Hs). simpl in IH.
      destruct (leq (fst m) (fst q)) eqn:E2; simpl in *; split; auto.
Qed.

Lemma isort_sorted : forall l, sorted (isort l).
Proof. induction l; simpl; auto using insert_sorted. Qed.

Lemma insert_head : forall m l, sorted (m :: l) -> insert m l = m :: l.
Proof.
  intros m [|n l] H; simpl in *; auto.
  destruct H as [H _]. now rewrite H.
Qed.

Lemma isort_fixed : forall l, sorted l -> isort l = l.
Proof.
  induction l as [|m l IH]; intros H; simpl; auto.
  rewrite IH by (eapply sorted_tail; eauto). now apply insert_head.
Qed.

Lemma insert_perm : forall m l, Permutation (m :: l) (insert m l).
Proof.
  intros m l. induction l as [|n l IH]; simpl; auto.
  destruct (leq (fst m) (fst n)); auto.
  eapply perm_trans. apply perm_swap. apply perm_skip. exact IH.
Qed.

Lemma isort_perm : forall l, Permutation l (isort l).
Proof.
  induction l as [|m l IH]; simpl; auto.
  eapply perm_trans. apply perm_skip. exact IH. apply insert_perm.
Qed.

Lemma sorted_min : forall t h z, sorted (h :: t) -> In z t -> leq (fst h) (fst z) = true.
Proof.
  induction t as [|a t IH]; intros h z Hs Hin; simpl in *; [contradiction|].
  destruct Hs as [Hha Hs]. destruct Hin as [<-|Hin]; auto.
  eapply leq_trans; eauto.
Qed.

(* One object level: two sorted member lists with distinct names and the
   same members are equal (Agda: KyqUnique.sorted-unique). *)
Theorem sorted_unique : forall s1 s2, sorted s1 -> sorted s2 ->
  NoDup (map fst s1) -> NoDup (map fst s2) ->
  (forall z, In z s1 <-> In z s2) -> s1 = s2.
Proof.
  induction s1 as [|h1 t1 IH]; intros [|h2 t2] S1 S2 D1 D2 E.
  - reflexivity.
  - exfalso. apply (proj2 (E h2)). now left.
  - exfalso. apply (proj1 (E h1)). now left.
  - simpl in D1, D2. inversion D1 as [|? ? N1 D1']; subst.
    inversion D2 as [|? ? N2 D2']; subst.
    assert (Hh : h1 = h2).
    { destruct (proj1 (E h1) (or_introl eq_refl)) as [Heq|I1]; auto.
      destruct (proj2 (E h2) (or_introl eq_refl)) as [Heq|I2]; auto.
      assert (K : fst h1 = fst h2).
      { apply leq_antisym; [eapply sorted_min; eauto | eapply sorted_min; eauto]. }
      exfalso. apply N1. rewrite K. now apply in_map. }
    subst h2. f_equal. apply IH.
    + eapply sorted_tail; eauto.
    + eapply sorted_tail; eauto.
    + exact D1'.
    + exact D2'.
    + intros z. split; intros Hz.
      * destruct (proj1 (E z) (or_intror Hz)) as [<-|Hz']; auto.
        exfalso. apply N1. now apply in_map.
      * destruct (proj2 (E z) (or_intror Hz)) as [<-|Hz']; auto.
        exfalso. apply N2. now apply in_map.
Qed.

(* Agda: KyqUnique.isort-unique. *)
Theorem isort_unique : forall xs ys, (forall z, In z xs <-> In z ys) ->
  NoDup (map fst xs) -> NoDup (map fst ys) -> isort xs = isort ys.
Proof.
  intros xs ys E Dx Dy. apply sorted_unique.
  - apply isort_sorted.
  - apply isort_sorted.
  - eapply Permutation_NoDup; [apply Permutation_map, isort_perm | exact Dx].
  - eapply Permutation_NoDup; [apply Permutation_map, isort_perm | exact Dy].
  - intros z. split; intros Hz.
    + apply Permutation_in with (l := ys); [apply isort_perm|].
      apply E. apply Permutation_in with (l := isort xs); auto.
      apply Permutation_sym, isort_perm.
    + apply Permutation_in with (l := xs); [apply isort_perm|].
      apply E. apply Permutation_in with (l := isort ys); auto.
      apply Permutation_sym, isort_perm.
Qed.

(* The distinct-name proviso is necessary (Agda:
   KyqUnique.no-unique-without-distinct), stated for any inhabited payload
   with two distinct elements. *)
Theorem no_unique_without_distinct : forall (a b : A), a <> b ->
  ~ (forall xs ys, (forall z, In z xs <-> In z ys) -> isort xs = isort ys).
Proof.
  intros a b Hab H.
  specialize (H [([0], a); ([0], b)] [([0], b); ([0], a)]).
  assert (E : forall z, In z [([0], a); ([0], b)] <-> In z [([0], b); ([0], a)]).
  { intros z; simpl; tauto. }
  specialize (H E). simpl in H. inversion H. contradiction.
Qed.

End Sort.

Arguments insert {A}.
Arguments isort {A}.
Arguments sorted {A}.

(* ------------------------------------------------------------------ *)
(* The I-JSON value algebra and the canoniser.                         *)

Inductive value : Type :=
| VNull
| VBool (b : bool)
| VNum (n : Num)
| VStr (s : list nat)
| VArr (vs : list value)
| VObj (ms : list (key * value)).

Fixpoint canon (v : value) : value :=
  match v with
  | VArr vs => VArr (map canon vs)
  | VObj ms => VObj (isort (map (fun m => match m with (k, w) => (k, canon w) end) ms))
  | _ => v
  end.

Definition canonM (m : key * value) : key * value :=
  match m with (k, w) => (k, canon w) end.

Inductive NF : value -> Prop :=
| NF_null : NF VNull
| NF_bool b : NF (VBool b)
| NF_num n : NF (VNum n)
| NF_str s : NF (VStr s)
| NF_arr vs : Forall NF vs -> NF (VArr vs)
| NF_obj ms : Forall (fun m => NF (snd m)) ms -> sorted ms -> NF (VObj ms).

Section VInd.
  Variable P : value -> Prop.
  Hypothesis Hnull : P VNull.
  Hypothesis Hbool : forall b, P (VBool b).
  Hypothesis Hnum : forall n, P (VNum n).
  Hypothesis Hstr : forall s, P (VStr s).
  Hypothesis Harr : forall vs, Forall P vs -> P (VArr vs).
  Hypothesis Hobj : forall ms, Forall (fun m => P (snd m)) ms -> P (VObj ms).

  Fixpoint value_ind' (v : value) : P v :=
    match v with
    | VNull => Hnull
    | VBool b => Hbool b
    | VNum n => Hnum n
    | VStr s => Hstr s
    | VArr vs => Harr vs
        ((fix F (l : list value) : Forall P l :=
            match l with
            | [] => Forall_nil P
            | x :: l' => Forall_cons x (value_ind' x) (F l')
            end) vs)
    | VObj ms => Hobj ms
        ((fix F (l : list (key * value)) : Forall (fun m => P (snd m)) l :=
            match l with
            | [] => Forall_nil _
            | x :: l' =>
                match x as x0 return Forall (fun m => P (snd m)) (x0 :: l') with
                | (k, w) => Forall_cons (k, w) (value_ind' w) (F l')
                end
            end) ms)
    end.
End VInd.

Lemma canon_obj : forall ms, canon (VObj ms) = VObj (isort (map canonM ms)).
Proof. reflexivity. Qed.

Lemma Forall_perm : forall (B : Type) (Q : B -> Prop) l l',
  Permutation l l' -> Forall Q l -> Forall Q l'.
Proof.
  intros B Q l l' Hp Hf. rewrite Forall_forall in *. intros x Hx.
  apply Hf. eapply Permutation_in; [apply Permutation_sym; exact Hp | exact Hx].
Qed.

Theorem canon_nf : forall v, NF (canon v).
Proof.
  apply value_ind'; intros; simpl; try constructor.
  - rewrite Forall_map. exact H.
  - eapply Forall_perm; [apply isort_perm|].
    rewrite Forall_map. eapply Forall_impl; [|exact H].
    intros [k w] Hw. exact Hw.
  - apply isort_sorted.
Qed.

Lemma map_canon_fixed : forall vs, Forall (fun v => NF v -> canon v = v) vs ->
  Forall NF vs -> map canon vs = vs.
Proof.
  induction vs as [|x vs IH]; intros H1 H2; simpl; auto.
  inversion H1 as [|? ? Hx Hvs]; inversion H2 as [|? ? Nx Nvs]; subst.
  rewrite (Hx Nx). f_equal. apply IH; auto.
Qed.
Lemma map_canonM_fixed : forall ms, Forall (fun m => NF (snd m) -> canon (snd m) = snd m) ms ->
  Forall (fun m => NF (snd m)) ms -> map canonM ms = ms.
Proof.
  induction ms as [|[k w] ms IH]; intros H1 H2; simpl; auto.
  inversion H1 as [|? ? Hx Hvs]; inversion H2 as [|? ? Nx Nvs]; subst.
  simpl in *. rewrite (Hx Nx). f_equal. apply IH; auto.
Qed.
Theorem nf_fixed : forall v, NF v -> canon v = v.
Proof.
  apply (value_ind' (fun v => NF v -> canon v = v)); intros; simpl; auto.
  - inversion H0 as [| | | |? Hf|]; subst. f_equal. now apply map_canon_fixed.
  - inversion H0 as [| | | | |? Hf Hs]; subst. f_equal.
    change (isort (map canonM ms) = ms). rewrite map_canonM_fixed by auto.
    now apply isort_fixed.
Qed.

(* c o c = c (Agda: KyqValue.canon-idem). *)
Theorem canon_idem : forall v, canon (canon v) = canon v.
Proof. intros v. apply nf_fixed, canon_nf. Qed.


(* ------------------------------------------------------------------ *)
(* JCS-5(a) at every depth and uniqueness of the canonical            *)
(* representative (Agda: KyqRecursive.canon-resp, nf-unique).         *)

(* Same value up to member order, at every depth: each member has a
   member with the same name and a related value on the other side
   (Agda: _~_ through AllIn and Match). *)
Inductive sim : value -> value -> Prop :=
| sim_null : sim VNull VNull
| sim_bool b : sim (VBool b) (VBool b)
| sim_num n : sim (VNum n) (VNum n)
| sim_str s : sim (VStr s) (VStr s)
| sim_arr vs ws : Forall2 sim vs ws -> sim (VArr vs) (VArr ws)
| sim_obj ms ns :
    Forall (fun m => Exists (fun n => fst m = fst n /\ sim (snd m) (snd n)) ns) ms ->
    Forall (fun n => Exists (fun m => fst n = fst m /\ sim (snd n) (snd m)) ms) ns ->
    sim (VObj ms) (VObj ns).

(* Well-formed I-JSON: distinct member names at every depth. *)
Inductive WF : value -> Prop :=
| WF_null : WF VNull
| WF_bool b : WF (VBool b)
| WF_num n : WF (VNum n)
| WF_str s : WF (VStr s)
| WF_arr vs : Forall WF vs -> WF (VArr vs)
| WF_obj ms : NoDup (map fst ms) -> Forall (fun m => WF (snd m)) ms -> WF (VObj ms).

Definition RespP (v : value) : Prop :=
  forall w, WF v -> WF w -> sim v w \/ sim w v -> canon v = canon w.

Lemma fst_canonM : forall l, map fst (map canonM l) = map fst l.
Proof. induction l as [|[k w] l IH]; simpl; f_equal; auto. Qed.

Lemma arr_resp : forall vs ws, Forall RespP vs -> Forall WF vs -> Forall WF ws ->
  Forall2 sim vs ws \/ Forall2 sim ws vs -> map canon vs = map canon ws.
Proof.
  induction vs as [|v vs IH]; intros ws Hr Hv Hw Hs.
  - destruct Hs as [Hs|Hs]; inversion Hs; reflexivity.
  - inversion Hr as [|? ? Rv Rvs]; inversion Hv as [|? ? Wv Wvs]; subst.
    destruct Hs as [Hs|Hs]; inversion Hs as [|? w ? ws' Hvw Hrest]; subst;
      inversion Hw as [|? ? Ww Wws]; subst; simpl; f_equal;
      try (apply Rv; auto); apply IH; auto.
Qed.

Lemma sim_obj_inv : forall ms ns, sim (VObj ms) (VObj ns) ->
  Forall (fun m => Exists (fun n => fst m = fst n /\ sim (snd m) (snd n)) ns) ms /\
  Forall (fun n => Exists (fun m => fst n = fst m /\ sim (snd n) (snd m)) ms) ns.
Proof. intros ms ns H. inversion H; subst. split; assumption. Qed.

Theorem canon_resp_both : forall v, RespP v.
Proof.
  apply value_ind'; unfold RespP.
  - intros w _ _ [H|H]; inversion H; reflexivity.
  - intros b w _ _ [H|H]; inversion H; reflexivity.
  - intros n w _ _ [H|H]; inversion H; reflexivity.
  - intros s w _ _ [H|H]; inversion H; reflexivity.
  - intros vs Hr w Wv Ww Hs.
    destruct Hs as [Hs|Hs]; inversion Hs; subst;
      inversion Wv; inversion Ww; subst; simpl; f_equal;
      apply arr_resp; auto.
  - intros ms Hr w Wv Ww Hs.
    destruct w as [| | | | |ns]; try (destruct Hs as [Hs|Hs]; inversion Hs; fail).
    assert (Hobj :
      Forall (fun m => Exists (fun n => fst m = fst n /\ (sim (snd m) (snd n) \/ sim (snd n) (snd m))) ns) ms /\
      Forall (fun n => Exists (fun m => fst n = fst m /\ (sim (snd n) (snd m) \/ sim (snd m) (snd n))) ms) ns).
    { destruct Hs as [Hs|Hs].
      - destruct (sim_obj_inv _ _ Hs) as [A1 A2]. split.
        + eapply Forall_impl; [|exact A1]. intros m Hm.
          eapply Exists_impl; [|exact Hm]. intros n [E S]. auto.
        + eapply Forall_impl; [|exact A2]. intros n Hn.
          eapply Exists_impl; [|exact Hn]. intros m [E S]. auto.
      - destruct (sim_obj_inv _ _ Hs) as [A1 A2]. split.
        + eapply Forall_impl; [|exact A2]. intros m Hm.
          eapply Exists_impl; [|exact Hm]. intros n [E S]. auto.
        + eapply Forall_impl; [|exact A1]. intros n Hn.
          eapply Exists_impl; [|exact Hn]. intros m [E S]. auto. }
    destruct Hobj as [A1 A2].
    inversion Wv as [| | | | |? Dm Fm]; inversion Ww as [| | | | |? Dn Fn]; subst.
    simpl. f_equal. apply isort_unique.
    + intros z. rewrite !in_map_iff. split.
      * intros [m [<- Hm]].
        rewrite Forall_forall in A1. specialize (A1 m Hm).
        apply Exists_exists in A1. destruct A1 as [n [Hn [E S]]].
        exists n. split; auto.
        rewrite Forall_forall in Hr, Fm, Fn.
        destruct m as [k v], n as [j u]; simpl in *; subst.
        f_equal. symmetry. apply (Hr (j, v) Hm u (Fm _ Hm) (Fn _ Hn) S).
      * intros [n [<- Hn]].
        rewrite Forall_forall in A2. specialize (A2 n Hn).
        apply Exists_exists in A2. destruct A2 as [m [Hm [E S]]].
        exists m. split; auto.
        rewrite Forall_forall in Hr, Fm, Fn.
        destruct m as [k v], n as [j u]; simpl in *; subst.
        f_equal. apply (Hr (k, v) Hm u (Fm _ Hm) (Fn _ Hn)).
        destruct S; auto.
    + rewrite fst_canonM. exact Dm.
    + rewrite fst_canonM. exact Dn.
Qed.

Theorem canon_resp : forall v w, WF v -> WF w -> sim v w -> canon v = canon w.
Proof. intros v w Wv Ww S. apply (canon_resp_both v w Wv Ww). now left. Qed.

(* Uniqueness of canonical representatives. *)
Theorem nf_unique : forall v w, WF v -> WF w -> NF v -> NF w -> sim v w -> v = w.
Proof.
  intros v w Wv Ww Nv Nw S.
  rewrite <- (nf_fixed v Nv), <- (nf_fixed w Nw). now apply canon_resp.
Qed.

(* ------------------------------------------------------------------ *)
(* Translation validation, two arguments (Agda: KyqCodec.Laws).       *)

Section TV.
  Variables (Bytes V : Type).
  Variable p : Bytes -> option V.
  Variable print : V -> Bytes.
  Variable norm : V -> V.
  Variable Dom : V -> Prop.
  Variable check : Bytes -> bool.

  Definition c (v : V) : Bytes := print (norm v).
  Definition equiv (v w : V) : Prop := norm v = norm w.

  Definition NonMalleable : Prop :=
    forall b, check b = true -> exists v, p b = Some v /\ Dom v /\ b = c v.
  Definition RoundTrip : Prop := forall v, Dom v -> p (c v) = Some (norm v).
  Definition Complete : Prop := forall v, Dom v -> check (c v) = true.
  Definition NormIdem : Prop := forall v, norm (norm v) = norm v.

  Definition TV (i o : Bytes) : Prop :=
    (exists vi, p i = Some vi /\ Dom vi) /\ check o = true /\
    exists vo vi, p o = Some vo /\ p i = Some vi /\ equiv vo vi.

  Theorem tv_sound : NonMalleable ->
    forall i o vi, p i = Some vi -> Dom vi -> check o = true ->
    (exists vo, p o = Some vo /\ equiv vo vi) -> o = c vi.
  Proof.
    intros NM i o vi Hi Hd Hok [vo [Ho Heq]].
    destruct (NM o Hok) as [vo' [Ho' [_ Ho'c]]].
    rewrite Ho in Ho'. injection Ho' as <-.
    rewrite Ho'c. unfold c. unfold equiv in Heq. now rewrite Heq.
  Qed.

  Theorem tv_complete : NormIdem -> RoundTrip -> Complete ->
    forall i vi, p i = Some vi -> Dom vi -> TV i (c vi).
  Proof.
    intros Id RT Cp i vi Hi Hd. split; [eauto|]. split; [now apply Cp|].
    exists (norm vi), vi. repeat split; auto. apply Id.
  Qed.

  Theorem tv_iff : NormIdem -> RoundTrip -> NonMalleable -> Complete ->
    forall i o, TV i o <-> exists vi, p i = Some vi /\ Dom vi /\ o = c vi.
  Proof.
    intros Id RT NM Cp i o. split.
    - intros [[vi [Hi Hd]] [Hok [vo [vi' [Ho [Hi' Heq]]]]]].
      rewrite Hi in Hi'. injection Hi' as <-.
      exists vi. repeat split; auto. eapply tv_sound; eauto.
    - intros [vi [Hi [Hd ->]]]. eapply tv_complete; eauto.
  Qed.
End TV.

(* The one-argument statement is not translation validation: a normal
   form need not be the canonical form of the input (Agda: KyqModel's
   one-arg-not-tv, stated there with the decidable check isNF). *)
Theorem one_arg_not_tv : ~ (forall i o, NF o -> o = canon i).
Proof.
  intro H. specialize (H (VObj [([0], VNull)]) VNull NF_null).
  simpl in H. discriminate H.
Qed.

End Spine.

Print Assumptions leq_total.
Print Assumptions leq_antisym.
Print Assumptions leq_trans.
Print Assumptions sorted_unique.
Print Assumptions isort_unique.
Print Assumptions no_unique_without_distinct.
Print Assumptions canon_nf.
Print Assumptions nf_fixed.
Print Assumptions canon_idem.
Print Assumptions canon_resp.
Print Assumptions nf_unique.
Print Assumptions tv_sound.
Print Assumptions tv_complete.
Print Assumptions tv_iff.
Print Assumptions one_arg_not_tv.
