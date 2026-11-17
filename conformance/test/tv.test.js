// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell (hyperpolymath) <j.d.a.jewell@open.ac.uk>
//
// Test-time translation validation of `canon` (unverified; design for the
// verified Idris2 checker, design §8.3 P4).
//
//   tv(in, out) = OK  <=>  in ∈ Dom  ∧  out = c(p in)
//
// The checker is conformance/tv/tv.js, which imports nothing from
// conformance/src. Three parts:
//
//   1. the whole corpus and the bridge vectors, plus seeded generated JSON and
//      KYAML-flow inputs: every `canon` output is validated, every refusal is
//      checked for agreement where TV can decide. JSON and KYAML-flow rows are
//      semantic; block-style KYAML rows are "cert-only, not semantic".
//   2. producer-side fault injection (CORRECTIONS: output mutants cannot tell a
//      shared checker from an independent one): the oracle runs with a fault in
//      its bridge, emitter or parser, and the independent checker must reject
//      every semantic row the fault changes.
//   3. the control: a checker that reuses the oracle's own parser misses the
//      parser fault.

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { bridgeStream } from "../src/bridge.js";
import { canonBytes } from "../src/cli.js";
import { escapeJsonString, esNumberToString, toJcs } from "../src/jcs.js";
import { JNumber, parseIJson } from "../src/json.js";
import { KyamlParser, parseKyaml } from "../src/kyaml.js";
import { TvError, jcs as tvJcs, readJson, sameValue, tv, tvRefusal } from "../tv/tv.js";
import { fixtureInputs, repositoryInputs } from "./corpus-inputs.js";
import { readCorpus, utf8 } from "./helpers.js";

const enc = (text) => new TextEncoder().encode(text);

/**
 * The oracle's `canon` for one input, retrying a multi-document stream with
 * `--array` as the CLI user would. Returns `{out, array}` or `{error, array}`.
 *
 * @param {(bytes: Uint8Array, format: string, array: boolean) => Uint8Array} producer
 * @param {Uint8Array} bytes
 * @param {"yaml"|"json"} format
 * @param {boolean} [array]
 */
function produce(producer, bytes, format, array = false) {
  try {
    return { out: producer(bytes, format, array), array };
  } catch (error) {
    if (error?.code === "MULTI_DOC_STREAM" && !array) return produce(producer, bytes, format, true);
    return { error, array };
  }
}

// ── seeded generated inputs ───────────────────────────────────────────────

/** Deterministic generator of values written as JSON and as KYAML flow. */
function generated(count, seed0) {
  let seed = seed0;
  const random = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed / 2 ** 32;
  };
  const pick = (list) => list[Math.floor(random() * list.length)];
  const numbers = ["0", "-0", "-0.0", "1.5", "1e15", "-17", "9007199254740991", "1e21", "5e-324", "2e-3", "1E30", "123.456e7", "0.1"];
  const pieces = ["a", "é", "😀", "\t", "\n", '"', "\\", "\u0001", "\u2028", " ", "#", ":", "x y", "true", "1"];
  const keys = ["name", "app_1", "a.b", "Kind", "true", "1", "with space", "", "é", "x:y", "null", "a-b"];
  const str = () => Array.from({ length: Math.floor(random() * 4) }, () => pick(pieces)).join("");
  const value = (depth) => {
    const r = random();
    if (depth < 6 && r < 0.25) return Array.from({ length: Math.floor(random() * 4) }, () => value(depth + 1));
    if (depth < 6 && r < 0.5) {
      const map = new Map();
      for (let n = Math.floor(random() * 4); n > 0; n -= 1) map.set(`${pick(keys)}${map.size || ""}`, value(depth + 1));
      return map;
    }
    if (r < 0.75) return { token: pick(numbers) };
    if (r < 0.85) return pick([true, false, null]);
    return str();
  };
  const json = (v) => {
    if (v instanceof Map) return `{${[...v].map(([k, x]) => `${JSON.stringify(k)} : ${json(x)}`).join(",\n ")}}`;
    if (Array.isArray(v)) return `[ ${v.map(json).join(" ,")} ]`;
    return v !== null && typeof v === "object" ? v.token : JSON.stringify(v);
  };
  const plainKey = (k) => /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(k) && !/^(true|false|null|True|False|Null|TRUE|FALSE|NULL)$/.test(k);
  const yaml = (v) => {
    const comma = random() < 0.5 ? "," : "";
    const note = random() < 0.2 ? " # note\n" : " ";
    if (v instanceof Map) {
      return `{${[...v].map(([k, x]) => `${plainKey(k) && random() < 0.7 ? k : JSON.stringify(k)}: ${yaml(x)}`).join(`,${note}`)}${v.size ? comma : ""}}`;
    }
    if (Array.isArray(v)) return `[${v.map(yaml).join(`,${note}`)}${v.length ? comma : ""}]`;
    return v !== null && typeof v === "object" ? v.token : JSON.stringify(v);
  };
  const inputs = [];
  for (let n = 0; n < count; n += 1) {
    const v = value(0);
    inputs.push({ name: `gen-json-${n}`, bytes: enc(`${json(v)}\n`), format: "json" });
    const docs = random() < 0.25 ? [v, value(0), value(0)] : [v];
    const text = docs.length === 1 ? `${yaml(v)}\n` : docs.map((d) => `---\n${yaml(d)}\n`).join("");
    inputs.push({ name: `gen-kyaml-${n}`, bytes: enc(text), format: "yaml" });
  }
  return inputs;
}

const corpus = [...fixtureInputs(), ...(repositoryInputs() ?? [])];
const gen = generated(600, 0xc0ffee);
const correct = (bytes, format, array) => canonBytes(bytes, format, array);

// ── 1. TV over the corpus and generated inputs ───────────────────────────

/**
 * Run TV on every input; returns counts per (format, level).
 *
 * @param {{name: string, bytes: Uint8Array, format: "yaml"|"json"}[]} inputs
 */
function runTv(inputs) {
  const counts = {};
  const bump = (key) => { counts[key] = (counts[key] ?? 0) + 1; };
  for (const input of inputs) {
    const result = produce(correct, input.bytes, input.format);
    if (result.out) {
      let level;
      try {
        level = tv(input.bytes, result.out, input.format, { array: result.array }).level;
      } catch (error) {
        assert.fail(`${input.name}: TV rejected the oracle's canon output: ${error.message}`);
      }
      bump(`${input.format}:${level}`);
    } else {
      let verdict;
      try {
        verdict = tvRefusal(input.bytes, input.format, { array: result.array });
      } catch (error) {
        assert.fail(`${input.name}: oracle refused ${result.error?.code}, TV says in Dom: ${error.message}`);
      }
      bump(`${input.format}:refused-${verdict === "domain" ? "agreed" : "undecided"}`);
    }
  }
  return counts;
}

test("TV over the corpus (fixtures, bridge vectors, oracle vectors, repository files)", () => {
  const counts = runTv(corpus);
  console.log(`TV corpus counts (n=${corpus.length}): ${JSON.stringify(counts)}`);
  // Floors from the fixtures alone (the release tarball): 68 and 70 rows.
  assert.ok((counts["json:semantic"] ?? 0) >= 65, "JSON semantic rows");
  assert.ok((counts["yaml:cert"] ?? 0) >= 65, "KYAML block rows (cert-only)");
});

test("TV semantic: JSON and KYAML-flow generated inputs (seeded)", () => {
  const counts = runTv(gen);
  console.log(`TV generated counts (n=${gen.length}): ${JSON.stringify(counts)}`);
  assert.equal(counts["json:semantic"], 600);
  assert.equal(counts["yaml:semantic"], 600, "every generated KYAML-flow input is in the semantic profile");
});

test("TV cert-only, not semantic: block-style KYAML is checked for (i)+(ii) only", () => {
  // The canonical KYAML form itself is block style, so TV cannot read it back.
  const input = enc("a: 1\nb:\n  - x\n");
  assert.deepEqual(tv(input, enc('{"a":1,"b":["x"]}'), "yaml"), { semantic: false, level: "cert" });
  // A wrong value on a block input passes (i)+(ii): cert is not semantic, and
  // the result says so (callers must read `semantic`, not just "did not throw").
  assert.deepEqual(tv(input, enc('{"a":2,"b":["x"]}'), "yaml"), { semantic: false, level: "cert" });
  assert.throws(() => tv(input, enc('{"b":["x"],"a":1}'), "yaml"), TvError);
});

test("TV rejects output and domain faults on hand-made rows", () => {
  const cases = [
    ["json", '{"a":1}', '{"a":2}', "semantic"],
    ["json", '{"a":1}', '{ "a":1}', "output"],
    ["json", "[1e18]", "[1000000000000000000]", "output"],
    ["json", '{"a":1,"a":1}', '{"a":1}', "domain"],
    ["json", "[1,2]", "[1]", "semantic"],
    ["yaml", '{a: "\\t"}\n', '{"a":" "}', "semantic"],
    ["yaml", "[1e18]\n", "[1000000000000000000]", "output"],
  ];
  for (const [format, input, output, kind] of cases) {
    assert.throws(() => tv(enc(input), enc(output), format), (error) => error instanceof TvError && error.kind === kind, input);
  }
});

// ── 2. producer-side fault injection ─────────────────────────────────────

/** Oracle parse + bridge, before emission. */
function bridged(bytes, format, array) {
  return format === "json" ? parseIJson(bytes) : bridgeStream(parseKyaml(bytes), { array });
}
/** An emitter assembled from the oracle's own escape and number printers. */
function emit(value, { compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0), number = esNumberToString } = {}) {
  if (value instanceof JNumber) return number(value.value);
  if (value === null || typeof value === "boolean") return String(value);
  if (typeof value === "string") return escapeJsonString(value);
  if (Array.isArray(value)) return `[${value.map((item) => emit(item, { compare, number })).join(",")}]`;
  return `{${[...value.keys()].sort(compare).map((key) => `${escapeJsonString(key)}:${emit(value.get(key), { compare, number })}`).join(",")}}`;
}
/** Change the first number, string or boolean met in document order. */
function perturb(value) {
  let done = false;
  const walk = (v) => {
    if (done) return v;
    if (v instanceof JNumber) { done = true; return new JNumber(v.value + 1, v.isInteger); }
    if (typeof v === "string") { done = true; return `${v}x`; }
    if (typeof v === "boolean") { done = true; return !v; }
    if (Array.isArray(v)) return v.map(walk);
    if (v instanceof Map) return new Map([...v].map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value);
}

const FAULTS = {
  "bridge perturbs one value": (b, f, a) => toJcs(perturb(bridged(b, f, a))),
  "stream drops the last document": (b, f, a) => {
    const value = bridged(b, f, a);
    if (a && Array.isArray(value) && f === "yaml") value.pop();
    return toJcs(value);
  },
  "emitter sorts keys with localeCompare": (b, f, a) => enc(emit(bridged(b, f, a), { compare: (x, y) => x.localeCompare(y) })),
  "emitter prints numbers at 12 digits": (b, f, a) => enc(emit(bridged(b, f, a), { number: (x) => esNumberToString(Number(x.toPrecision(12))) })),
  "parser decodes \\t as a space": (b, f, a) => withParserFault(() => canonBytes(b, f, a)),
};

/** Run `thunk` with the oracle's double-quoted escape decoder faulted. */
function withParserFault(thunk) {
  const original = KyamlParser.prototype.parseDoubleQuotedEscape;
  KyamlParser.prototype.parseDoubleQuotedEscape = function faulty() {
    const decoded = original.call(this);
    return decoded === "\t" ? " " : decoded;
  };
  try {
    return thunk();
  } finally {
    KyamlParser.prototype.parseDoubleQuotedEscape = original;
  }
}

/** The control: (i)+(ii) as TV, but (iii) against the oracle's own parse. */
function sharedTv(input, output, format, array) {
  const out = readJson(output, "output");
  if (tvJcs(out) !== new TextDecoder().decode(output)) throw new TvError("output", "not canonical");
  const norm = (v) => (v instanceof JNumber ? v.value : Array.isArray(v) ? v.map(norm)
    : v instanceof Map ? new Map([...v].map(([k, x]) => [k, norm(x)])) : v);
  sameValue(norm(bridged(input, format, array)), out);
}

test("producer-side fault injection: the independent checker rejects every semantic row each fault changes", () => {
  const inputs = [...corpus, ...gen];
  const table = {};
  for (const [name, faulty] of Object.entries(FAULTS)) {
    const row = { activated: 0, semantic: 0, caught: 0, certOnly: 0, certCaught: 0, sharedMissed: 0 };
    for (const input of inputs) {
      const good = produce(correct, input.bytes, input.format);
      if (!good.out) continue;
      const bad = produce(faulty, input.bytes, input.format, good.array);
      if (!bad.out || Buffer.from(bad.out).equals(Buffer.from(good.out))) continue;
      row.activated += 1;
      // Does TV have a semantic leg for this input?
      const semantic = tv(input.bytes, good.out, input.format, { array: good.array }).semantic;
      let caught = false;
      try {
        tv(input.bytes, bad.out, input.format, { array: good.array });
      } catch (error) {
        assert.ok(error instanceof TvError, error.message);
        caught = true;
      }
      if (semantic) {
        row.semantic += 1;
        assert.ok(caught, `${name}: independent TV accepted a faulty output for ${input.name}`);
        row.caught += 1;
      } else {
        row.certOnly += 1;
        if (caught) row.certCaught += 1;
      }
      // The control, run with the same fault active in the oracle's parser.
      const run = name.startsWith("parser") ? withParserFault : (thunk) => thunk();
      try {
        run(() => sharedTv(input.bytes, bad.out, input.format, good.array));
        row.sharedMissed += 1;
      } catch {
        // caught by the shared checker too
      }
    }
    assert.ok(row.semantic > 0, `${name}: the fault must change at least one semantic row`);
    table[name] = row;
  }
  const discriminates = Object.values(table).filter((row) => row.sharedMissed > 0).length;
  console.log(`TV fault injection (${discriminates} of ${Object.keys(table).length} faults discriminate shared from independent): ${JSON.stringify(table)}`);
  // 3. The control: the shared checker misses the parser fault, which the
  // independent one catches on every semantic row.
  assert.ok(table["parser decodes \\t as a space"].sharedMissed > 0, "the shared control must miss the parser fault");
  for (const [name, row] of Object.entries(table)) {
    if (!name.startsWith("parser")) assert.equal(row.sharedMissed, 0, `${name}: shared checker should catch downstream faults`);
  }
});

test("bridge vectors with --array are validated as streams", () => {
  let validated = 0;
  for (const vector of readCorpus("bridge/vectors.json").vectors.filter((v) => v.array)) {
    const result = produce(correct, utf8(vector.yaml), "yaml", true);
    if (!result.out) continue;
    tv(utf8(vector.yaml), result.out, "yaml", { array: true });
    validated += 1;
  }
  assert.ok(validated >= 1);
});

// ── 4. regressions: TV and the gate agree on Dom (review findings) ────────

/**
 * Compare TV with the oracle on one input: either both accept (and TV agrees on
 * the value, or says it cannot decide), or the oracle refuses and TV does not
 * say the input is in Dom. A disagreement is a bug in one of them.
 *
 * @returns {string} what happened, for the callers' tables
 */
function agree(text, array = false) {
  const bytes = enc(text);
  const { out, error } = produce(correct, bytes, "yaml", array);
  if (out) {
    const result = tv(bytes, out, "yaml", { array });
    return result.semantic ? "semantic" : "cert";
  }
  const verdict = tvRefusal(bytes, "yaml", { array });
  assert.ok(error?.code, text);
  return `refused-${verdict}`;
}

test("TV agrees with the gate on multi-word plain scalars, newline keys and surrogate escapes", () => {
  // A flow plain scalar ends only at , [ ] { } or ': ' / ' #' / end of line, so
  // each of these is ONE string; TV must not judge a prefix of it as a number.
  for (const text of ["[1e18 x]\n", "{~ a: 1}\n", "[null x]\n", "[0.11e400 z]\n", "[-1e400 q, 2]\n", "[1e4001 and more]\n", "1e400 x\n", "-01e18 y\n"]) {
    assert.equal(agree(text), "cert", `${JSON.stringify(text)}: the gate accepts a string; TV must not call it a number`);
  }
  assert.equal(agree("1e400[\"a\", \"b\"]\n"), "cert", "block-context plain scalar runs past [");
  // An implicit key is on one line: the gate refuses MULTILINE_KEY, so TV must not accept.
  assert.equal(agree("{a\n: 1}\n"), "refused-domain");
  assert.equal(agree("{a # c\n: 1}\n"), "refused-domain");
  // Every surrogate escape is outside Dom (a pair included): LONE_SURROGATE.
  assert.equal(agree('["\\uD83D\\uDE00"]\n'), "refused-domain");
  assert.equal(agree('["\\uD800"]\n'), "refused-domain");
  // Neighbours that stay inside Dom.
  assert.equal(agree('["\\U0001F600"]\n'), "semantic");
  assert.equal(agree("{a: 1, b: x y}\n"), "cert");
  assert.equal(agree("[1e18]\n"), "refused-domain");
});

/** Seeded mutation fuzz: TV and the gate must never disagree on Dom. */
function mutationFuzz(seed0, count) {
  let seed = seed0;
  const random = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed / 2 ** 32;
  };
  const pick = (list) => list[Math.floor(random() * list.length)];
  const seedsJson = ['{"a":[1,2.5,"x"],"b":{"c":null,"d":true}}', '[1e15,-0,0.1,"\\u00e9",{"k":[]}]', '{"":"\\t","é":[{}]}', '["\\ud83d\\ude00", 123456789, 1E2]'];
  const seedsYaml = ['{a: [1, 2.5, "x"], b: {c: null, d: true}}\n', '[1e15, -0, 0.1, "\\u00e9", {k: []}]\n', '{"": "\\t", "é": [{}]}\n', "---\n[1]\n---\n{a: 1}\n", "{a: 0o17, b: +1, c: .5, d: 1., e: ~}\n", '["\\x41\\N\\_", "\\U0001F600"]\n'];
  const alphabet = ['"', "\\", "u", "d", "8", "0", "e", "E", "-", "+", ".", "1", "9", ",", ":", "[", "]", "{", "}", " ", "\n", "\t", "#", "~", "a", "n", "x", "\u00a0", "\ufeff", "'", "&", "*", "null", "true", "1e400", "1e18", "\\ud83d", "\\ude00", "\\uFFFF", "\\U0001FFFE", "---\n"];
  const mutate = (text) => {
    let t = text;
    for (let n = 1 + Math.floor(random() * 3); n > 0; n -= 1) {
      const at = Math.floor(random() * (t.length + 1));
      const r = random();
      t = r < 0.4 ? t.slice(0, at) + pick(alphabet) + t.slice(at) : r < 0.7 ? t.slice(0, at) + t.slice(at + 1) : t.slice(0, at) + pick(alphabet) + t.slice(at + 1);
    }
    return t;
  };
  const tally = { rows: 0, semantic: 0, undecided: 0 };
  for (let n = 0; n < count; n += 1) {
    const json = random() < 0.5;
    const text = mutate(pick(json ? seedsJson : seedsYaml));
    const format = json ? "json" : "yaml";
    const bytes = enc(text);
    for (const array of format === "yaml" ? [false, true] : [false]) {
      tally.rows += 1;
      const { out, array: used } = produce(correct, bytes, format, array);
      let level;
      try {
        level = out ? (tv(bytes, out, format, { array: used }).semantic ? "semantic" : "cert") : `refused-${tvRefusal(bytes, format, { array: used })}`;
      } catch (error) {
        assert.fail(`seed ${seed0}: TV and the gate disagree on ${JSON.stringify(text)} (array ${array}): ${error.message}`);
      }
      if (level === "semantic" || level === "refused-domain") tally.semantic += 1;
      else tally.undecided += 1;
    }
  }
  return tally;
}

test("TV never disagrees with the gate on mutated JSON and KYAML (4 seeds x 3000)", { timeout: 120000 }, () => {
  const totals = [11, 22, 33, 44].map((seed) => mutationFuzz(seed, 3000));
  console.log(`TV mutation fuzz: ${JSON.stringify(totals)}`);
  for (const tally of totals) assert.ok(tally.semantic > 1000, "the fuzz must decide a good share of rows");
});

test("RFC 8785 Appendix B: TV's number printer gives the vector text (shared runtime primitive, cross-checked)", () => {
  for (const vector of readCorpus("rfc8785/vectors.json").numbers) {
    const text = tvJcs([Number(vector.token)]);
    assert.equal(text, `[${vector.jcs}]`, vector.token);
  }
});

// ── 5. faults injected into the oracle's own JSON reader and serialiser ────

const srcDirectory = fileURLToPath(new URL("../src/", import.meta.url));

/**
 * Load a copy of conformance/src with textual patches applied (mutation of the
 * oracle's own source: a fault inside src/json.js or src/jcs.js, not in a test
 * re-implementation). Returns the copy's CLI functions and parsers, so the
 * shared-checker control can use the same faulty parse.
 *
 * @param {[string, string, string][]} patches  [file, old, new]
 */
async function faultyOracle(patches) {
  const dir = mkdtempSync(join(tmpdir(), "kyq-fault-"));
  try {
    cpSync(srcDirectory, dir, { recursive: true });
    for (const [file, from, to] of patches) {
      const path = join(dir, file);
      const text = readFileSync(path, "utf8");
      assert.ok(text.includes(from), `fault patch does not apply to ${file}: ${from}`);
      writeFileSync(path, text.replace(from, () => to));
    }
    const base = pathToFileURL(`${dir}/`).href;
    const [cli, json, kyaml, bridge] = await Promise.all(
      ["cli.js", "json.js", "kyaml.js", "bridge.js"].map((name) => import(`${base}${name}`)),
    );
    return { canonBytes: cli.canonBytes, parseIJson: json.parseIJson, parseKyaml: kyaml.parseKyaml, bridgeStream: bridge.bridgeStream };
  } finally {
    // The modules are loaded; the files are no longer needed.
    rmSync(dir, { recursive: true, force: true });
  }
}

const SOURCE_FAULTS = {
  "src/json.js decodes the \\t escape as a space": [["json.js", 'case "t":\n        return "\\t";', 'case "t":\n        return " ";']],
  "src/json.js cuts number tokens at 15 characters": [["json.js", "const token = this.text.slice(startIndex, this.index);", "const token = this.text.slice(startIndex, this.index).slice(0, 15);"]],
  "src/jcs.js sorts keys with localeCompare": [["jcs.js", "return [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));", "return [...keys].sort((a, b) => a.localeCompare(b));"]],
  "src/jcs.js prints numbers at 12 digits": [["jcs.js", "export function esNumberToString(value) {", "export function esNumberToString(value) {\n  value = Number(Number(value).toPrecision(12));"]],
};

/** The shared-checker control, with the faulty oracle's own parse. */
function sharedWith(oracle, input, output, format, array) {
  const out = readJson(output, "output");
  if (tvJcs(out) !== new TextDecoder().decode(output)) throw new TvError("output", "not canonical");
  const norm = (v) => (v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Map) && "isInteger" in v ? v.value
    : Array.isArray(v) ? v.map(norm) : v instanceof Map ? new Map([...v].map(([k, x]) => [k, norm(x)])) : v);
  const parsed = format === "json" ? oracle.parseIJson(input) : oracle.bridgeStream(oracle.parseKyaml(input), { array });
  sameValue(norm(parsed), out);
}

test("source-level faults in src/json.js and src/jcs.js are caught by the independent checker", { timeout: 120000 }, async () => {
  const inputs = [...corpus, ...gen];
  const table = {};
  for (const [name, patches] of Object.entries(SOURCE_FAULTS)) {
    const oracle = await faultyOracle(patches);
    const row = { activated: 0, semantic: 0, caught: 0, certOnly: 0, sharedMissed: 0 };
    for (const input of inputs) {
      const good = produce(correct, input.bytes, input.format);
      if (!good.out) continue;
      const bad = produce((b, f, a) => oracle.canonBytes(b, f, a), input.bytes, input.format, good.array);
      if (!bad.out || Buffer.from(bad.out).equals(Buffer.from(good.out))) continue;
      row.activated += 1;
      const semantic = tv(input.bytes, good.out, input.format, { array: good.array }).semantic;
      let caught = false;
      try {
        tv(input.bytes, bad.out, input.format, { array: good.array });
      } catch (error) {
        assert.ok(error instanceof TvError, error.message);
        caught = true;
      }
      if (semantic) {
        row.semantic += 1;
        assert.ok(caught, `${name}: independent TV accepted a faulty output for ${input.name}`);
        row.caught += 1;
      } else row.certOnly += 1;
      try {
        sharedWith(oracle, input.bytes, bad.out, input.format, good.array);
        row.sharedMissed += 1;
      } catch {
        // caught by the shared checker too
      }
    }
    assert.ok(row.semantic > 0, `${name}: the fault must change at least one semantic row`);
    table[name] = row;
  }
  // A fault after parsing (key order, number printing) is also caught by the
  // shared checker's own (i)+(ii); only a fault in what the oracle reads
  // discriminates between a shared and an independent checker.
  const discriminating = Object.entries(table).filter(([, row]) => row.sharedMissed > 0).map(([name]) => name);
  console.log(`TV source-fault table (${discriminating.length} of ${Object.keys(table).length} faults discriminate): ${JSON.stringify(table)}`);
  assert.ok(discriminating.length >= 2, "at least the two json.js reader faults must discriminate");
});

test("a domain fault in src/json.js (duplicate keys accepted) is caught: TV rejects an input outside Dom", { timeout: 120000 }, async () => {
  const oracle = await faultyOracle([["json.js", "if (object.has(key)) {", "if (false) {"]]);
  let activated = 0;
  for (const input of corpus.filter((row) => row.format === "json")) {
    if (produce(correct, input.bytes, "json").out) continue;
    const bad = produce((b, f, a) => oracle.canonBytes(b, f, a), input.bytes, "json");
    if (!bad.out) continue;
    activated += 1;
    assert.throws(() => tv(input.bytes, bad.out, "json"), (error) => error instanceof TvError && error.kind === "domain", input.name);
  }
  assert.ok(activated > 0, "the corpus must hold a duplicate-key refusal");
});
