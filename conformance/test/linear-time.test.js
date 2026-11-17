// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell (hyperpolymath) <j.d.a.jewell@open.ac.uk>
//
// No regex in the trusted path may backtrack super-linearly (kyq programme,
// Phase 2 M0). The trim helpers replace `/[ \t]+$/`-style regexes, which took
// quadratic time on a long run of blanks that does not end the string; the
// blank look-behind is O(1) instead of a test on a growing string. Adversarial
// 256 KiB inputs must finish in a time a quadratic scan cannot meet (the
// regex versions took over 15 s; the bound here is generous so a slow CI
// machine does not flake), and the helpers must equal the regexes they replace.

import assert from "node:assert/strict";
import { test } from "node:test";

import { trimBlanks, trimBlanksEnd, trimNewlinesEnd } from "../src/kyaml.js";
import { cleanupTemp, makeTempDir, runCli, writeTemp } from "./helpers.js";

const N = 256 * 1024;

test("trim helpers equal the regexes they replace (seeded fuzz)", () => {
  let seed = 0x2545f491;
  const next = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };
  const alphabet = [" ", "\t", "\n", "a", "#", " ", "\u{1F600}", ":"];
  for (let n = 0; n < 20000; n += 1) {
    const length = next() % 12;
    let text = "";
    for (let k = 0; k < length; k += 1) text += alphabet[next() % alphabet.length];
    assert.equal(trimBlanksEnd(text), text.replace(/[ \t]+$/, ""), JSON.stringify(text));
    assert.equal(trimBlanks(text), text.replace(/^[ \t]+|[ \t]+$/g, ""), JSON.stringify(text));
    assert.equal(trimNewlinesEnd(text), text.replace(/\n+$/, ""), JSON.stringify(text));
  }
});

const adversarial = {
  "plain value, inner blanks": `k: a${" ".repeat(N)}b\n`,
  "block key, inner blanks": `a${" ".repeat(N)}b: 1\n`,
  "flow key, inner blanks": `{a${" ".repeat(N)}b: 1}\n`,
  "flow value, inner blanks": `{k: a${" ".repeat(N)}b}\n`,
  "plain value, inner tabs": `k: a${"\t".repeat(N)}b\n`,
  "plain value, many hashes": `k: ${"a#".repeat(N / 2)}\n`,
  "block key, many hashes": `${"a#".repeat(N / 2)}: 1\n`,
  "flow value, many hashes": `[${"a#".repeat(N / 2)}]\n`,
  "flow key, many hashes": `{${"a#".repeat(N / 2)}: 1}\n`,
  "block scalar, interior newlines": `k: |\n  a\n${"\n".repeat(N)}  b\n`,
  "block scalar, keep chomping": `k: |+\n  a\n${"\n".repeat(N)}`,
  "directive, inner blanks": `%YAML${" ".repeat(N)}1.2\n---\na: 1\n`,
};

test("adversarial 256 KiB inputs finish in linear time", async (t) => {
  const dir = makeTempDir();
  try {
    for (const [name, text] of Object.entries(adversarial)) {
      await t.test(name, () => {
        const file = writeTemp(dir, "adv.yaml", text);
        const start = process.hrtime.bigint();
        const result = runCli(["check", file]);
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        assert.ok([0, 1, 2].includes(result.status), `exit ${result.status}`);
        assert.ok(ms < 5000, `${name}: ${ms.toFixed(0)} ms`);
      });
    }
  } finally {
    cleanupTemp(dir);
  }
});

test("H4: a failure on deep nesting reports the input's own kind", () => {
  const dir = makeTempDir();
  try {
    // Nesting deep enough to overflow the recursive reader's stack. Since
    // contract 0.4.0 (ruling R3) the explicit depth budget refuses it first, so
    // the code is DEPTH_BUDGET_EXCEEDED on every runtime instead of a
    // runtime-dependent INTERNAL_ERROR; the kind must still be the input's.
    const deepJson = writeTemp(dir, "deep.json", `${"[".repeat(200000)}${"]".repeat(200000)}`);
    const json = JSON.parse(runCli(["check", "--report", "json", deepJson]).stdout);
    assert.equal(json.format, "json");
    assert.equal(json.error.code, "DEPTH_BUDGET_EXCEEDED");
    assert.equal(json.error.kind, "json", "a JSON input must not report a KYAML failure");
    const deepYaml = writeTemp(dir, "deep.yaml", `${"[".repeat(200000)}${"]".repeat(200000)}\n`);
    const yaml = JSON.parse(runCli(["check", "--report", "json", deepYaml]).stdout);
    assert.equal(yaml.format, "yaml");
    assert.equal(yaml.error.code, "DEPTH_BUDGET_EXCEEDED");
    assert.equal(yaml.error.kind, "kyaml");
  } finally {
    cleanupTemp(dir);
  }
});
