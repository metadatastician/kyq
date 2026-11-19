#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell (hyperpolymath) <j.d.a.jewell@open.ac.uk>
//
// Differential harness (docs/ULTRAPLAN.adoc §12, step W4): run an
// implementation's `canon` on every input of the gate's fixture corpus and
// compare it with the gate, verdict for verdict and byte for byte. Each output
// the implementation accepts is also given to the independent translation
// validator (conformance/tv/tv.js).
//
// Usage:
//   node conformance/tools/native-diff.mjs --impl target/debug/kyq
//   node conformance/tools/native-diff.mjs --impl PATH --divergences FILE
//
// The implementation is called as `IMPL canon --from kyaml|json -` with the
// input on stdin. Exit 0 is an acceptance with the JCS bytes on stdout; any
// other exit is a refusal.
//
// Known divergences are listed in fixtures/oracle/native-divergences.json. The
// observed set must equal the listed set exactly: an unlisted divergence
// fails, and a listed row that no longer diverges fails too, so the list can
// only shrink by an edit that someone reviews.
//
// Exit codes: 0 = observed divergences equal the listed ones; 2 = they differ,
// the corpus is empty, or the implementation could not be run. A missing
// binary is a failure, never a pass.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { canonBytes } from "../src/cli.js";
import { fixtureInputs } from "../test/corpus-inputs.js";
import { tv, TvError } from "../tv/tv.js";

const gateRoot = fileURLToPath(new URL("..", import.meta.url));

function option(name, fallback) {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : process.argv[at + 1];
}

const impl = option("--impl");
const listed = option("--divergences", join(gateRoot, "fixtures", "oracle", "native-divergences.json"));
if (!impl || !existsSync(impl)) {
  console.error(`native-diff: implementation not found: ${impl ?? "(no --impl)"}`);
  process.exit(2);
}

/** One line that says how the two sides differ, or null when they agree. */
function compare(input) {
  let gate;
  try {
    gate = { ok: true, bytes: Buffer.from(canonBytes(input.bytes, input.format)) };
  } catch (error) {
    gate = { ok: false, code: error.code ?? error.name };
  }
  const run = spawnSync(impl, ["canon", "--from", input.format === "json" ? "json" : "kyaml", "-"], { input: input.bytes });
  if (run.error) {
    console.error(`native-diff: cannot run ${impl}: ${run.error.message}`);
    process.exit(2);
  }
  let difference = null;
  if (gate.ok && run.status === 0) difference = gate.bytes.equals(run.stdout) ? null : "bytes-differ";
  else if (gate.ok) difference = "gate-accepts impl-refuses";
  else if (run.status === 0) difference = `gate-refuses (${gate.code}) impl-accepts`;
  if (run.status === 0) {
    try {
      tv(input.bytes, run.stdout, input.format);
    } catch (error) {
      if (!(error instanceof TvError)) throw error;
      difference = `${difference ?? "verdicts-agree"}; tv-rejects-impl-output (${error.kind})`;
    }
  }
  return difference;
}

const inputs = fixtureInputs();
if (inputs.length === 0) {
  console.error("native-diff: the corpus is empty; refusing a vacuous pass");
  process.exit(2);
}

const observed = new Map();
for (const input of inputs) {
  const difference = compare(input);
  if (difference !== null) observed.set(input.name, difference);
}

const expected = new Map(
  JSON.parse(readFileSync(listed, "utf8")).divergences.map((row) => [row.case, row.difference]),
);

const problems = [];
for (const [name, difference] of observed) {
  if (!expected.has(name)) problems.push(`UNLISTED  ${name}: ${difference}`);
  else if (expected.get(name) !== difference) problems.push(`CHANGED   ${name}: listed "${expected.get(name)}", observed "${difference}"`);
}
for (const name of expected.keys()) {
  if (!observed.has(name)) problems.push(`STALE     ${name}: listed, but the two sides now agree`);
}

console.log(`native-diff: ${inputs.length} inputs, ${inputs.length - observed.size} agree, ${observed.size} diverge (${expected.size} listed)`);
if (problems.length > 0) {
  for (const line of problems) console.error(line);
  process.exit(2);
}
