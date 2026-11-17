// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell (hyperpolymath) <j.d.a.jewell@open.ac.uk>
//
// Ruling R3: value budgets and float closure.
//
//   * every budget is refused with its typed code, at exactly its limit, the
//     same way on every runtime (explicit counters, no stack overflow);
//   * closure: for every input `check` accepts, `check(canon x) = OK` and
//     `canon(canon x) = canon x`; for KYAML also `check(fix x) = OK` and
//     `fix(fix x) = fix x`, headed files included. This runs over the whole corpus, over seeded random
//     values, and over the number-growth cases of verify-logic L6 (3.4x / 4x).
//
// The functions under test are the CLI's own (`checkVerdict`, `canonBytes`,
// `fixText`), so the closure is the CLI's, not a re-implementation's.

import assert from "node:assert/strict";
import { truncateSync } from "node:fs";
import { test } from "node:test";

import {
  BUDGET_CODES,
  MAX_DEPTH,
  MAX_EXPANSION_BYTES,
  MAX_EXPANSION_NODES,
  MAX_INPUT_BYTES,
  MAX_NODES,
  MAX_STRING_BYTES,
  assertValueBudgets,
  outputBound,
} from "../src/budgets.js";
import { assertStreamBudgets } from "../src/bridge.js";
import { canonBytes, checkVerdict, fixText } from "../src/cli.js";
import { parseIJson } from "../src/json.js";
import { parseKyaml } from "../src/kyaml.js";
import { budgetDivergenceRows, budgetRowBytes } from "../tools/budget-divergence-rows.mjs";
import { fixtureInputs, repositoryInputs } from "./corpus-inputs.js";
import { cleanupTemp, makeTempDir, runCli, utf8, writeTemp } from "./helpers.js";

const decode = (bytes) => new TextDecoder().decode(bytes);

/** Tests that work at the full budgets (500 000 nodes, 8 MiB) take seconds. */
const SLOW = { timeout: 120000 };

/**
 * The error a thunk throws (fails the test if it does not throw).
 *
 * @param {() => unknown} thunk
 * @returns {any}
 */
function thrown(thunk) {
  try {
    thunk();
  } catch (error) {
    return error;
  }
  assert.fail("expected a refusal");
}

/** Codes `canon` may raise on an input `check` accepted, and why. */
const CANON_ONLY_REFUSALS = new Set([
  "MULTI_DOC_STREAM", // retried with --array below
  "EMPTY_STREAM", // a stream with no document has no JSON image
  "COMMENTS_WOULD_BE_LOST", // fix only: refuses instead of dropping a comment
]);

/**
 * Check the closure laws for one input. Returns what was exercised.
 *
 * @param {Uint8Array} bytes
 * @param {"yaml"|"json"} format
 * @param {string} name
 * @returns {{accepted: boolean, canon: boolean, fix: boolean, headed: boolean}}
 */
function assertClosure(bytes, format, name) {
  const verdict = checkVerdict(bytes, format);
  const result = { accepted: false, canon: false, fix: false, headed: false };
  if (verdict.status === "invalid") return result;
  result.accepted = true;

  // canon, then check and canon again on its output.
  let canonical = null;
  try {
    canonical = canonBytes(bytes, format);
  } catch (error) {
    assert.ok(CANON_ONLY_REFUSALS.has(error.code), `${name}: canon refused ${error.code} after check accepted`);
    if (error.code === "MULTI_DOC_STREAM") canonical = canonBytes(bytes, format, true);
  }
  if (canonical !== null) {
    result.canon = true;
    const again = checkVerdict(canonical, "json");
    assert.equal(again.status, "ok", `${name}: check(canon x) = ${again.status} ${again.error?.reason ?? ""}`);
    assert.equal(decode(canonBytes(canonical, "json")), decode(canonical), `${name}: canon(canon x) != canon x`);
    const measures = assertValueBudgets(parseIJson(canonical));
    assert.ok(canonical.length <= outputBound(measures.nodes, measures.stringBytes), `${name}: output bound`);
  }

  // fix, for KYAML: its output is checked and fixed again.
  if (format === "yaml") {
    let fixed;
    try {
      fixed = fixText(bytes, "yaml");
    } catch (error) {
      assert.ok(CANON_ONLY_REFUSALS.has(error.code), `${name}: fix refused ${error.code}`);
      return result;
    }
    const body = decode(utf8(fixed));
    const headed = body.length > 0 && /^\s*#/.test(body);
    result.headed = headed;
    assert.equal(fixText(utf8(fixed), "yaml"), fixed, `${name}: fix(fix x) != fix x`);
    // Headed rows included: `check` and `fix` share one definition of the
    // canonical text (header verbatim + formatted body).
    const again = checkVerdict(utf8(fixed), "yaml");
    assert.equal(again.status, "ok", `${name}: check(fix x) = ${again.status} ${again.error?.reason ?? ""}`);
    result.fix = true;
  }
  return result;
}

// ── defaults ──────────────────────────────────────────────────────────────

test("budget defaults are the ruled values and the output bound fits the input guard", () => {
  assert.equal(MAX_DEPTH, 127);
  assert.equal(MAX_NODES, 500000);
  assert.equal(MAX_STRING_BYTES, 8 * 1024 * 1024);
  assert.equal(MAX_EXPANSION_NODES, 100000);
  assert.equal(MAX_EXPANSION_BYTES, 1024 * 1024);
  assert.equal(MAX_INPUT_BYTES, 256 * 1024 * 1024);
  assert.ok(outputBound(MAX_NODES, MAX_STRING_BYTES) <= MAX_INPUT_BYTES);
  // Below V8's string length limit, so the guard decides, not the runtime.
  assert.ok(MAX_INPUT_BYTES < 2 ** 29 - 24);
  assert.deepEqual(Object.values(BUDGET_CODES).sort(), [
    "DEPTH_BUDGET_EXCEEDED",
    "EXPANSION_BUDGET_EXCEEDED",
    "INPUT_BUDGET_EXCEEDED",
    "NODE_BUDGET_EXCEEDED",
    "STRING_BUDGET_EXCEEDED",
  ]);
});

// ── depth ─────────────────────────────────────────────────────────────────

test("depth: 127 containers are accepted, the 128th is refused (JSON, serde_json's message)", () => {
  const nest = (n) => `${"[".repeat(n)}${"]".repeat(n)}`;
  assert.equal(checkVerdict(utf8(nest(127)), "json").status, "ok");
  for (const n of [128, 129, 1000, 5000, 200000]) {
    const { error } = checkVerdict(utf8(nest(n)), "json");
    assert.equal(error.code, "DEPTH_BUDGET_EXCEEDED");
    assert.equal(error.kind, "json");
    // Byte-identical to ijson-jcs 2c880594 (and main 1735d68) on the same text.
    assert.equal(error.reason, "JSON parse error: recursion limit exceeded at line 1 column 128");
  }
  const objects = (n) => `${'{"a":'.repeat(n)}1${"}".repeat(n)}`;
  assert.equal(checkVerdict(utf8(objects(127)), "json").status, "ok");
  assert.equal(
    checkVerdict(utf8(objects(128)), "json").error.reason,
    "JSON parse error: recursion limit exceeded at line 1 column 636",
  );
});

test("depth: KYAML flow, block and alias-expanded nesting share the 127 limit", () => {
  const flow = (n) => `${"[".repeat(n)}${"]".repeat(n)}\n`;
  assert.notEqual(checkVerdict(utf8(flow(127)), "yaml").status, "invalid");
  for (const n of [128, 5000, 200000]) {
    const { error } = checkVerdict(utf8(flow(n)), "yaml");
    assert.equal(error.code, "DEPTH_BUDGET_EXCEEDED");
    assert.equal(error.kind, "kyaml");
    assert.equal(error.line, 1);
    assert.equal(error.column, 128);
  }
  const block = (n) => Array.from({ length: n }, (_, i) => `${"  ".repeat(i)}k:`).join("\n") + " 1\n";
  assert.equal(checkVerdict(utf8(block(127)), "yaml").status, "ok");
  assert.equal(checkVerdict(utf8(block(128)), "yaml").error.code, "DEPTH_BUDGET_EXCEEDED");
  // Source depth 127 everywhere, expanded depth 128 through an alias.
  const deep = `${"[".repeat(126)}1${"]".repeat(126)}`;
  const aliased = `a: &a ${deep}\nb: [*a]\n`;
  const { error } = checkVerdict(utf8(aliased), "yaml");
  assert.equal(error.code, "DEPTH_BUDGET_EXCEEDED");
  assert.equal(error.kind, "bridge");
  assert.notEqual(checkVerdict(utf8(`a: &a ${deep}\nb: *a\n`), "yaml").status, "invalid");
});

test("depth: canon --array adds one level, and is refused rather than emitted past 127", () => {
  const doc = `${"[".repeat(127)}${"]".repeat(127)}`;
  const stream = utf8(`---\n${doc}\n---\n${doc}\n`);
  assert.notEqual(checkVerdict(stream, "yaml").status, "invalid");
  const error = thrown(() => canonBytes(stream, "yaml", true));
  assert.equal(error.code, "DEPTH_BUDGET_EXCEEDED");
  assert.equal(error.kind, "jcs");
});

// ── nodes and string bytes ────────────────────────────────────────────────

test("nodes: exactly MAX_NODES values are accepted, one more is refused (JSON and KYAML)", SLOW, () => {
  const array = (items) => `[${Array(items).fill("0").join(",")}]`;
  assert.equal(checkVerdict(utf8(array(MAX_NODES - 1)), "json").status, "ok");
  const json = checkVerdict(utf8(array(MAX_NODES)), "json").error;
  assert.equal(json.code, "NODE_BUDGET_EXCEEDED");
  assert.equal(json.kind, "json");
  assert.notEqual(checkVerdict(utf8(`${array(MAX_NODES - 1)}\n`), "yaml").status, "invalid");
  assert.equal(checkVerdict(utf8(`${array(MAX_NODES)}\n`), "yaml").error.code, "NODE_BUDGET_EXCEEDED");
});

test("string bytes: decoded bytes count, keys included; one byte over is refused", SLOW, () => {
  // Key "k" (1 byte) + value: exactly MAX_STRING_BYTES decoded bytes. "€" is
  // 3 UTF-8 bytes in one UTF-16 unit, which keeps the test fast.
  const euros = Math.floor((MAX_STRING_BYTES - 1) / 3);
  const value = `${"\u20ac".repeat(euros)}${"x".repeat(MAX_STRING_BYTES - 1 - 3 * euros)}`;
  assert.equal(checkVerdict(utf8(`{"k":"${value}"}`), "json").status, "ok");
  const over = checkVerdict(utf8(`{"k":"${value}x"}`), "json").error;
  assert.equal(over.code, "STRING_BUDGET_EXCEEDED");
  // Escapes are measured decoded: the 6 encoded bytes of \u20ac are 3 bytes.
  const escaped = `"${"\\u20ac".repeat(1000)}${"x".repeat(MAX_STRING_BYTES - 3000)}"`;
  assert.equal(checkVerdict(utf8(escaped), "json").status, "not-canonical");
  assert.equal(checkVerdict(utf8(`${escaped.slice(0, -1)}x"`), "json").error.code, "STRING_BUDGET_EXCEEDED");
  assert.equal(checkVerdict(utf8(`{"k":"${value}x"}\n`), "yaml").error.code, "STRING_BUDGET_EXCEEDED");
});

// ── alias expansion ───────────────────────────────────────────────────────

test("expansion: what aliases add is budgeted in nodes and in decoded bytes", () => {
  // An anchor of 999 items (1000 nodes); each alias adds 1000 nodes.
  const anchor = `[${Array(999).fill("0").join(",")}]`;
  const nodes = (aliases) => `a: &a ${anchor}\nb: [${Array(aliases).fill("*a").join(",")}]\n`;
  assert.equal(assertStreamBudgets(parseKyaml(utf8(nodes(100)))).expansionNodes, 100000);
  assert.equal(checkVerdict(utf8(nodes(100)), "yaml").status !== "invalid", true);
  const error = checkVerdict(utf8(nodes(101)), "yaml").error;
  assert.equal(error.code, "EXPANSION_BUDGET_EXCEEDED");
  assert.equal(error.kind, "bridge");
  // A 1024-byte anchored string; each alias adds 1024 bytes.
  const bytes = (aliases) => `a: &a ${"x".repeat(1024)}\nb: [${Array(aliases).fill("*a").join(",")}]\n`;
  assert.equal(assertStreamBudgets(parseKyaml(utf8(bytes(1024)))).expansionBytes, MAX_EXPANSION_BYTES);
  assert.notEqual(checkVerdict(utf8(bytes(1024)), "yaml").status, "invalid");
  assert.equal(checkVerdict(utf8(bytes(1025)), "yaml").error.code, "EXPANSION_BUDGET_EXCEEDED");
  // No alias, no expansion.
  assert.equal(assertStreamBudgets(parseKyaml(utf8("a: &a [1]\nb: [2]\n"))).expansionNodes, 0);
});

test("amplification probes (optim §4) are refused with typed codes, quickly", () => {
  // 4096-byte anchor x 20 000 aliases: 64 108 bytes in, 81 984 110 bytes out
  // before R3. 65 536 x 20 000: 125 548 bytes in, RangeError on node before R3.
  for (const [size, aliases, inputBytes] of [[4096, 20000, 64108], [65536, 20000, 125548]]) {
    const text = `a: &a ${"x".repeat(size)}\nb: [${Array(aliases).fill("*a").join(",")}]\n`;
    assert.equal(utf8(text).length, inputBytes);
    const started = performance.now();
    assert.equal(checkVerdict(utf8(text), "yaml").error.code, "EXPANSION_BUDGET_EXCEEDED");
    assert.equal(thrown(() => canonBytes(utf8(text), "yaml")).code, "EXPANSION_BUDGET_EXCEEDED");
    assert.ok(performance.now() - started < 5000, "refused in linear time");
  }
  // A stream of documents each under the old per-document budget (optim's
  // stream bomb): the stream-wide expansion budget refuses it.
  let doc = 'a: &a ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]\n';
  for (let level = 1; level <= 4; level += 1) {
    const previous = String.fromCharCode(96 + level);
    const next = String.fromCharCode(97 + level);
    doc += `${next}: &${next} [${Array(9).fill(`*${previous}`).join(",")}]\n`;
  }
  const streamBomb = Array.from({ length: 50 }, () => `---\n${doc}`).join("");
  assert.equal(checkVerdict(utf8(streamBomb), "yaml").error.code, "EXPANSION_BUDGET_EXCEEDED");
});

test("input guard: a file over MAX_INPUT_BYTES is refused from its size (CLI edge)", () => {
  const dir = makeTempDir();
  try {
    const file = writeTemp(dir, "huge.json", "");
    truncateSync(file, MAX_INPUT_BYTES + 1); // sparse: no disk is used
    const result = runCli(["check", "--report", "json", file]);
    assert.equal(result.status, 2);
    const report = JSON.parse(result.stdout);
    assert.equal(report.error.code, "INPUT_BUDGET_EXCEEDED");
    assert.equal(report.error.kind, "json");
  } finally {
    cleanupTemp(dir);
  }
});

// ── closure ───────────────────────────────────────────────────────────────

test("closure: check(canon x)=OK and canon(canon x)=canon x over the whole corpus", SLOW, () => {
  const inputs = fixtureInputs();
  const repository = repositoryInputs();
  // Outside a git checkout (the release tarball) only the fixtures are run;
  // inside it the tracked repository files must be there.
  if (repository !== null) assert.ok(repository.length > 0, "repository files listed");
  const all = [...inputs, ...(repository ?? [])];
  const totals = { inputs: all.length, accepted: 0, canon: 0, fix: 0, headed: 0 };
  for (const input of all) {
    const result = assertClosure(input.bytes, input.format, input.name);
    for (const key of ["accepted", "canon", "fix", "headed"]) if (result[key]) totals[key] += 1;
  }
  // Floors from the fixtures alone (the release tarball): 142 accepted, 139
  // canon rows, 59 fix rows on 2026-11-17. The repository adds to them.
  assert.ok(totals.accepted >= 140, `accepted inputs: ${JSON.stringify(totals)}`);
  assert.ok(totals.canon >= 135, `canon closure rows: ${JSON.stringify(totals)}`);
  assert.ok(totals.fix >= 55, `fix closure rows: ${JSON.stringify(totals)}`);
  console.log(`closure totals: ${JSON.stringify(totals)}`);
});

test("closure: the R3 float rows", () => {
  for (const [input, expected] of [
    ["[1e15]", "[1000000000000000]"],
    ["[9007199254740991.0]", "[9007199254740991]"],
    ["[-0.0]", "[0]"],
    ["[1e21]", "[1e+21]"],
  ]) {
    assertClosure(utf8(input), "json", input);
    assertClosure(utf8(`${input}\n`), "yaml", input);
    assert.equal(decode(canonBytes(utf8(input), "json")), expected);
  }
  for (const input of ["[1e18]", "[9007199254740993.0]", "[1e20]", "[-1e18]"]) {
    assert.equal(checkVerdict(utf8(input), "json").error.code, "UNSAFE_FLOAT_INTEGER");
    assert.equal(checkVerdict(utf8(`${input}\n`), "yaml").error.code, "UNSAFE_FLOAT_INTEGER");
  }
});

test("closure: the number-growth cases of verify-logic L6 at the node budget", SLOW, () => {
  // 1e15 grows 3.4x and 9e15 grows 4x inside an array; at MAX_NODES the
  // canonical text is still accepted, because no budget is on encoded bytes.
  for (const [token, growth] of [["1e15", 3.39], ["9e15", 3.39]]) {
    const text = `[${Array(MAX_NODES - 1).fill(token).join(",")}]`;
    const canonical = canonBytes(utf8(text), "json");
    assert.ok(canonical.length >= growth * text.length - 1, `${token} grows ${canonical.length / text.length}x`);
    assert.equal(checkVerdict(canonical, "json").status, "ok", token);
    assert.equal(decode(canonBytes(canonical, "json")), decode(canonical));
  }
  // 1e20 grew 4.4x and its canonical text failed `check` (UNSAFE_INTEGER);
  // it is now refused at the input instead.
  const error = checkVerdict(utf8(`[${Array(10000).fill("1e20").join(",")}]`), "json").error;
  assert.equal(error.code, "UNSAFE_FLOAT_INTEGER");
});

test("closure: values at every budget at once (depth, nodes, string bytes)", SLOW, () => {
  // One stream value with depth 127, exactly MAX_NODES nodes and exactly
  // MAX_STRING_BYTES string bytes, including controls that escape 6x in
  // `canon`. The bulk of the nodes sits at depth 2 so the test stays fast; the
  // next test covers maximal indentation growth.
  const controls = "\\x01".repeat(1000);
  const euros = Math.floor((MAX_STRING_BYTES - 1000) / 3);
  const big = `${"\u20ac".repeat(euros)}${"x".repeat(MAX_STRING_BYTES - 1000 - 3 * euros)}`;
  // Nodes: root 1 + chain 126 containers + 1 leaf + 2 strings + numbers.
  const chain = `${"[".repeat(126)}0${"]".repeat(126)}`;
  const numbers = Array(MAX_NODES - 130).fill("1e15").join(",");
  // KYAML: the long string is a plain scalar (it re-resolves to a string).
  const text = `[${chain},"${controls}",${big},${numbers}]\n`;
  const measures = assertStreamBudgets(parseKyaml(utf8(text)));
  assert.equal(measures.depth, 127);
  assert.equal(measures.nodes, MAX_NODES);
  assert.equal(measures.stringBytes, MAX_STRING_BYTES);
  const result = assertClosure(utf8(text), "yaml", "at-every-budget");
  assert.ok(result.canon && result.fix);
  // The same value as JSON text.
  const json = `[${chain},"${"\\u0001".repeat(1000)}","${big}",${numbers}]`;
  assert.deepEqual(assertValueBudgets(parseIJson(utf8(json))), { depth: 127, nodes: MAX_NODES, stringBytes: MAX_STRING_BYTES });
  assert.ok(assertClosure(utf8(json), "json", "at-every-budget-json").canon);
});

test("closure: maximal indentation growth (fix) at depth 127", SLOW, () => {
  // 20 000 leaves at depth 127: every `fix` line carries 252-254 bytes of
  // indentation, about 50x the compact flow input. Accepted again, and within
  // outputBound per value.
  const leaves = Array(20000).fill("1e15").join(",");
  const text = `${"[".repeat(126)}[${leaves}]${"]".repeat(126)}\n`;
  const fixed = fixText(utf8(text), "yaml");
  assert.ok(fixed.length > 40 * text.length, `growth ${fixed.length / text.length}`);
  const measures = assertStreamBudgets(parseKyaml(utf8(fixed)));
  assert.ok(utf8(fixed).length <= outputBound(measures.nodes, measures.stringBytes));
  const result = assertClosure(utf8(text), "yaml", "deep-indentation");
  assert.ok(result.canon && result.fix);
});

test("closure: seeded random values, written as JSON and as KYAML flow", () => {
  let seed = 0x5eed;
  const random = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed / 2 ** 32;
  };
  const pick = (list) => list[Math.floor(random() * list.length)];
  const numbers = ["0", "-0", "-0.0", "1.5", "1e15", "9007199254740991", "1e21", "5e-324", "2e-3", "1E30", "123.456e7"];
  const strings = ["", "a", "é", "\\u0001", "\\t", "\\\"q\\\"", "\\ud83d\\ude00", "1", "true", "a b", "k:v"];
  const gen = (depth) => {
    const r = random();
    if (depth < 12 && r < 0.2) {
      return `[ ${Array.from({ length: Math.floor(random() * 4) }, () => gen(depth + 1)).join(" , ")} ]`;
    }
    if (depth < 12 && r < 0.4) {
      const keys = new Set();
      const members = [];
      for (let i = Math.floor(random() * 4); i > 0; i -= 1) {
        const key = `${pick(strings)}${keys.size}`;
        keys.add(key);
        members.push(`"${key}" : ${gen(depth + 1)}`);
      }
      return `{${members.join(",\n ")}}`;
    }
    if (r < 0.6) return pick(numbers);
    if (r < 0.7) return pick(["true", "false", "null"]);
    return `"${pick(strings)}"`;
  };
  let accepted = 0;
  for (let i = 0; i < 1500; i += 1) {
    const text = gen(0);
    for (const format of ["json", "yaml"]) {
      const result = assertClosure(utf8(`${text}\n`), format, `random ${i} ${format}: ${text}`);
      if (result.accepted) accepted += 1;
    }
  }
  assert.ok(accepted >= 2500, `random closure rows accepted: ${accepted}`);
});

// ── near-budget inputs refused by the parser, not by memory exhaustion ─────

test("string bytes: a huge block, quoted or plain scalar is refused while it is read, with a typed code", SLOW, () => {
  const code = (text) => thrown(() => parseKyaml(utf8(text))).code;
  const over = MAX_STRING_BYTES + 1;
  // A block scalar of mostly blank lines (the base code built one object per
  // line and the node heap aborted at 200 MiB). Run-length counted now.
  assert.equal(code(`k: |\n  a\n${"\n".repeat(200 * 1024 * 1024)}  b\n`), "STRING_BUDGET_EXCEEDED");
  assert.equal(code(`k: |\n  a\n${"\n".repeat(over)}  b\n`), "STRING_BUDGET_EXCEEDED");
  assert.equal(code(`k: |+\n  a\n${"\n".repeat(over)}`), "STRING_BUDGET_EXCEEDED", "keep chomping counts the trailing breaks");
  assert.equal(code(`k: >\n  a\n${"\n".repeat(over)}  b\n`), "STRING_BUDGET_EXCEEDED");
  assert.equal(code(`k: |\n${"  ".concat("x".repeat(over), "\n")}`), "STRING_BUDGET_EXCEEDED");
  assert.equal(code(`k: "${"x".repeat(over)}"\n`), "STRING_BUDGET_EXCEEDED");
  assert.equal(code(`k: '${"x".repeat(over)}'\n`), "STRING_BUDGET_EXCEEDED");
  assert.equal(code(`k: ${"x".repeat(over)}\n`), "STRING_BUDGET_EXCEEDED");
  // Blank lines that chomping drops are not content: clip and strip accept them.
  const clipped = parseKyaml(utf8(`k: |\n  a\n${"\n".repeat(over)}`));
  assert.equal(clipped.length, 1);
  assert.equal(parseKyaml(utf8(`k: |-\n  a\n${"\n".repeat(over)}`)).length, 1);
  // The exact boundary of a block scalar: MAX_STRING_BYTES - 1 (key) bytes of body.
  const exact = MAX_STRING_BYTES - 1 - 1; // key `k` is 1 byte; body ends with its one `\n`
  assert.equal(parseKyaml(utf8(`k: |\n  ${"x".repeat(exact)}\n`)).length, 1);
  assert.equal(code(`k: |\n  ${"x".repeat(exact + 1)}\n`), "STRING_BUDGET_EXCEEDED");
  // The total over many scalars is counted as the stream is parsed.
  const chunk = "x".repeat(1024 * 1024);
  const many = Array.from({ length: 9 }, (_, n) => `k${n}: ${chunk}\n`).join("");
  assert.equal(code(many), "STRING_BUDGET_EXCEEDED");
});

test("string bytes through the CLI: a 200 MiB block scalar gets INVALID, exit 2, on this runtime", SLOW, () => {
  const dir = makeTempDir();
  try {
    const file = writeTemp(dir, "block.yaml", Buffer.concat([
      Buffer.from("k: |\n  a\n"),
      Buffer.alloc(200 * 1024 * 1024, "\n"),
      Buffer.from("  b\n"),
    ]));
    const result = runCli(["check", file]);
    assert.equal(result.status, 2);
    assert.match(result.stdout, /STRING_BUDGET_EXCEEDED/);
  } finally {
    cleanupTemp(dir);
  }
});

test("divergences.json budget rows: the gate refuses each, one step over its limit, with the listed code", SLOW, () => {
  const rows = budgetDivergenceRows();
  assert.ok(rows.length >= 2);
  for (const row of rows) {
    const bytes = budgetRowBytes(row);
    assert.equal(thrown(() => canonBytes(bytes, "json")).code, row.code, row.case);
    // One step under the limit is accepted, so the row sits on the boundary.
    const under = budgetRowBytes({ ...row, size: row.size - 1 });
    assert.doesNotThrow(() => canonBytes(under, "json"), row.case);
  }
});
