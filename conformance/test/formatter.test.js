// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell (hyperpolymath) <j.d.a.jewell@open.ac.uk>
//
// Formatter normal-form tests.
//
// Three properties are asserted for every input, because any one alone is
// satisfiable by a broken formatter:
//
//   * VALUE   — `parse(fmt(x))` has the same JSON image as `parse(x)`;
//   * FIXED   — `fmt(fmt(x))` is byte-equal to `fmt(x)` (idempotence, Thm Q-5);
//   * HYGIENE — the output ends with exactly one newline (or is empty).
//
// plus a table of quoting decisions so `fmt` cannot "simplify" a string into a
// different scalar type.

import assert from "node:assert/strict";
import { test } from "node:test";

import { bridgeDocument } from "../src/bridge.js";
import { formatStream, isPlainSafeString } from "../src/emit.js";
import { toJcsString } from "../src/jcs.js";
import { parseKyaml } from "../src/kyaml.js";
import { readCorpus, readFixture, repoFile, utf8 } from "./helpers.js";

const corpus = readCorpus("kyaml/cases.json");
const validFixtures = corpus.cases
  .filter((entry) => entry.expect === "valid")
  .map((entry) => entry.file);

/**
 * The JSON image of a KYAML text: one JCS string per document.
 *
 * @param {string|Uint8Array} input
 * @returns {string[]}
 */
function jsonImage(input) {
  const bytes = typeof input === "string" ? utf8(input) : input;
  return parseKyaml(bytes).map((document) => toJcsString(bridgeDocument(document)));
}

/**
 * Format a KYAML text.
 *
 * @param {string} input
 * @returns {string}
 */
function format(input) {
  return formatStream(parseKyaml(utf8(input)));
}

/**
 * Assert the three normal-form properties for one input.
 *
 * @param {string} input
 * @param {string} [label]
 * @returns {string} The formatted text.
 */
function assertNormalForm(input, label = "input") {
  const once = format(input);
  const twice = format(once);
  assert.deepEqual(jsonImage(once), jsonImage(input), `VALUE lost for ${label}`);
  assert.equal(twice, once, `FIXED violated for ${label}`);
  assert.ok(
    once === "" || (once.endsWith("\n") && !once.endsWith("\n\n")),
    `HYGIENE violated for ${label}: ${JSON.stringify(once.slice(-4))}`,
  );
  return once;
}

test("every valid fixture is preserved, idempotent and newline-clean", async (t) => {
  for (const file of validFixtures) {
    await t.test(file, () => {
      assertNormalForm(readFixture(`kyaml/${file}`).toString("utf8"), file);
    });
  }
});

test("the canonical fixture is exactly what the formatter produces", () => {
  const bytes = readFixture("kyaml/valid/canonical.yaml");
  assert.equal(format(bytes.toString("utf8")), bytes.toString("utf8"));
});

test("the repository's own example manifest is preserved by fmt", () => {
  const example = repoFile("examples/deployment.yaml").toString("utf8");
  const formatted = assertNormalForm(example, "examples/deployment.yaml");
  assert.notEqual(formatted, example, "the example is deliberately not canonical");
  assert.ok(jsonImage(formatted).length === 2);
});

test("multiline documents keep their document boundaries", () => {
  const stream = "a: 1\n---\n- x\n---\nnull\n";
  const formatted = assertNormalForm(stream);
  assert.equal(formatted, "a: 1\n---\n- x\n---\nnull\n");
  assert.equal(formatStream([]), "");
});

test("quoting preserves scalar types", async (t) => {
  const cases = [
    { input: "- true\n- 3\n- null\n- 1.5\n", expect: "- true\n- 3\n- null\n- 1.5\n" },
    { input: '- "true"\n- "3"\n- "null"\n- "1.5"\n', expect: '- "true"\n- "3"\n- "null"\n- "1.5"\n' },
    { input: "- 3 pods\n- nginx:1.25.3\n- a/b\n", expect: "- 3 pods\n- nginx:1.25.3\n- a/b\n" },
    { input: '- " leading"\n- "trailing "\n- ""\n', expect: '- " leading"\n- "trailing "\n- ""\n' },
    { input: '- "a: b"\n- "a #b"\n- "x:"\n', expect: '- "a: b"\n- "a #b"\n- "x:"\n' },
    // `yes`/`on` are strings in the YAML 1.2 Core Schema, but a YAML 1.1 reader
    // would take them for booleans, so canonical form quotes them.
    { input: "- 'yes'\n- on\n", expect: '- "yes"\n- "on"\n' },
    { input: "- '#hash'\n- '-dash'\n- '!bang'\n", expect: '- "#hash"\n- "-dash"\n- "!bang"\n' },
  ];
  for (const vector of cases) {
    await t.test(JSON.stringify(vector.input), () => {
      assert.equal(assertNormalForm(vector.input), vector.expect);
    });
  }
});

test("isPlainSafeString refuses every non-string resolution", () => {
  for (const unsafe of [
    "",
    " true",
    "true ",
    "true",
    "False",
    "yes",
    "on",
    "OFF",
    "y",
    "N",
    "null",
    "~",
    "0",
    "-1",
    "+7",
    "1.5",
    "1e3",
    ".inf",
    ".nan",
    "0x1f",
    "0o17",
    "a: b",
    "x:",
    "a #b",
    "#a",
    "-a",
    "?a",
    ":a",
    "[a]",
    "{a}",
    "&a",
    "*a",
    "!a",
    "|a",
    ">a",
    "'a'",
    '"a"',
    "%a",
    "@a",
    "`a",
    "tab\there",
    "line\nbreak",
  ]) {
    assert.equal(isPlainSafeString(unsafe), false, JSON.stringify(unsafe));
  }
  for (const safe of [
    "a",
    "a b",
    "3 pods",
    "nginx:1.25.3",
    "kubernetes.io/os",
    "a-b_c.d/e",
    "v1.25",
    "CamelCase",
    "with'quote",
    "café",
  ]) {
    assert.equal(isPlainSafeString(safe), true, JSON.stringify(safe));
  }
});

test("formatter-generated documents round-trip through the bridge", async (t) => {
  const documents = [
    "a:\n  b:\n    c: 1\n  d: []\n  e: {}\n",
    "- - a\n  - b\n- c\n",
    "- name: x\n  args:\n    - --flag\n    - value\n- name: y\n",
    'text: "line1\\nline2\\twith tab"\n',
    'block: "trailing newline\\n"\n',
    "empty: \"\"\n",
    "unicode: café ☃\n",
    'escaped: "\\u0000\\u001f"\n',
    "nested:\n  - {a: 1, b: [true, false]}\n",
    "deep:\n  a:\n    b:\n      - 1\n      - 2\n",
    '"quoted key": 1\n"3": 2\n',
  ];
  for (const document of documents) {
    await t.test(JSON.stringify(document), () => {
      assertNormalForm(document);
    });
  }
});

test("formatting never invents anchors, tags, flow collections or comments", async () => {
  const formatted = assertNormalForm(
    "# comment\nbase: &b\n  x: [1, 2]\ncopy: *b\ntagged: !!str 3\n",
  );
  assert.doesNotMatch(formatted, /[&*]/);
  assert.doesNotMatch(formatted, /![!a-zA-Z]/);
  assert.doesNotMatch(formatted, /[[\]{}]/);
  assert.doesNotMatch(formatted, /#/);
  assert.equal(
    formatted,
    "base:\n  x:\n    - 1\n    - 2\ncopy:\n  x:\n    - 1\n    - 2\ntagged: \"3\"\n",
  );
});

test("alias expansion is visible in the formatter output", () => {
  // Aliases are resolved by the parser, so the canonical form spells the value
  // out. This is a documented loss of the *syntax*, never of the *value*.
  const once = format("base: &b\n  x: 1\ncopy: *b\n");
  assert.equal(once, "base:\n  x: 1\ncopy:\n  x: 1\n");
  assert.deepEqual(jsonImage(once), jsonImage("base: &b\n  x: 1\ncopy: *b\n"));
});
