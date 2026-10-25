// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell (hyperpolymath) <j.d.a.jewell@open.ac.uk>
//
// Fixture coverage and expectation tests.
//
// The first test is the one that keeps the corpus honest: every fixture on disk
// must have exactly one expectation, and every expectation must name a fixture
// that exists. Adding a negative fixture without saying what it must fail with
// is therefore impossible, and a deletion cannot leave a dangling expectation.

import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { bridgeDocument } from "../src/bridge.js";
import { CORPUS_SCHEMA } from "../src/version.js";
import { parseKyaml } from "../src/kyaml.js";
import { conformanceRoot, readCorpus, readFixture } from "./helpers.js";

const corpus = readCorpus("kyaml/cases.json");
const fixturesRoot = join(conformanceRoot, "fixtures", "kyaml");

/** @returns {string[]} Fixture paths relative to `fixtures/kyaml`, sorted. */
function fixtureFiles() {
  const files = [];
  for (const directory of ["valid", "invalid"]) {
    for (const name of readdirSync(join(fixturesRoot, directory))) {
      if (name.endsWith(".yaml") || name.endsWith(".yml")) {
        files.push(`${directory}/${name}`);
      }
    }
  }
  return files.sort();
}

test("corpus declares the schema this test suite implements", () => {
  assert.equal(corpus.schema, CORPUS_SCHEMA);
  assert.equal(corpus.kind, "kyaml-cases");
});

test("every fixture has exactly one expectation and vice versa", () => {
  const onDisk = fixtureFiles();
  const declared = corpus.cases.map((entry) => entry.file);
  assert.deepEqual([...declared].sort(), onDisk);
  assert.equal(new Set(declared).size, declared.length, "duplicate expectation");
});

test("the corpus is not vacuous", () => {
  const valid = corpus.cases.filter((entry) => entry.expect === "valid");
  const invalid = corpus.cases.filter((entry) => entry.expect === "invalid");
  assert.ok(valid.length >= 8, `only ${valid.length} valid fixtures`);
  assert.ok(invalid.length >= 20, `only ${invalid.length} invalid fixtures`);
  const codes = new Set(invalid.map((entry) => entry.code));
  for (const required of [
    "DUPLICATE_KEY",
    "NON_STRING_KEY",
    "UNSAFE_INTEGER",
    "NON_FINITE_NUMBER",
    "UNEXPECTED_INDENT",
    "UNSUPPORTED_TAG",
    "UNSUPPORTED_MERGE_KEY",
    "UNKNOWN_ANCHOR",
    "NONCHARACTER",
    "LONE_SURROGATE",
  ]) {
    assert.ok(codes.has(required), `no negative fixture exercises ${required}`);
  }
});

test("valid fixtures parse, count documents and bridge", async (t) => {
  for (const entry of corpus.cases.filter((item) => item.expect === "valid")) {
    await t.test(entry.file, () => {
      const documents = parseKyaml(readFixture(`kyaml/${entry.file}`));
      assert.equal(documents.length, entry.documents);
      for (const document of documents) {
        assert.doesNotThrow(() => bridgeDocument(document));
      }
    });
  }
});

test("invalid fixtures fail with the pinned code, line, column and path", async (t) => {
  for (const entry of corpus.cases.filter((item) => item.expect === "invalid")) {
    await t.test(entry.file, () => {
      assert.throws(
        () => {
          const documents = parseKyaml(readFixture(`kyaml/${entry.file}`));
          for (const document of documents) bridgeDocument(document);
          return documents;
        },
        (error) => {
          assert.equal(error.code, entry.code, error.reason ?? error.message);
          assert.equal(error.line, entry.line, `line for ${entry.code}`);
          assert.equal(error.column, entry.column, `column for ${entry.code}`);
          assert.equal(error.path ?? "", entry.path, `path for ${entry.code}`);
          return true;
        },
      );
    });
  }
});

test("every diagnostic is source-located", async (t) => {
  for (const entry of corpus.cases.filter((item) => item.expect === "invalid")) {
    await t.test(entry.file, () => {
      try {
        const documents = parseKyaml(readFixture(`kyaml/${entry.file}`));
        for (const document of documents) bridgeDocument(document);
        assert.fail("fixture was accepted");
      } catch (error) {
        assert.ok(
          Number.isInteger(error.line) && error.line >= 1,
          `no line in ${error.code}: ${error.reason}`,
        );
        assert.ok(
          Number.isInteger(error.column) && error.column >= 1,
          `no column in ${error.code}: ${error.reason}`,
        );
        assert.match(error.reason, /\(line \d+, column \d+\)( \(path .*\))?$/);
      }
    });
  }
});

test("duplicate-key diagnostics name the first definition", () => {
  assert.throws(
    () => parseKyaml(readFixture("kyaml/invalid/duplicate-key.yaml")),
    (error) => {
      assert.equal(error.code, "DUPLICATE_KEY");
      assert.match(error.message, /first defined at line 4, column 3/);
      assert.equal(error.path, "metadata/name");
      return true;
    },
  );
});
