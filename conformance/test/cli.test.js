// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell (hyperpolymath) <j.d.a.jewell@open.ac.uk>
//
// CLI contract tests: the `check` / `fix` / `canon` / `validate` surface, its
// exit codes, its one-line-per-file output, the single-trailing-newline rule,
// and the JSON report a consumer CI can assert against.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { toJcs } from "../src/jcs.js";
import { parseIJson } from "../src/json.js";
import { VERSION } from "../src/version.js";
import {
  cleanupTemp,
  makeTempDir,
  readCorpus,
  readFixture,
  repoFile,
  runCli,
  utf8,
  writeTemp,
} from "./helpers.js";

const checkVectors = readCorpus("ijson/check.json");
const oracle = readCorpus("oracle/ijson-jcs.json");

/** Canonical JCS bytes of a JSON text. */
const jcsBytes = (text) => new TextDecoder().decode(toJcs(parseIJson(utf8(text))));

/**
 * Escape every regular-expression metacharacter in `text`.
 *
 * The CLI's message is compared literally, so the whole set must be escaped —
 * escaping only the brackets that the current fixtures happen to contain would
 * make the test pass by luck and would be flagged as an incomplete escape.
 *
 * @param {string} text
 * @returns {string}
 */
function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("check: exit codes follow the ijson-jcs contract", async (t) => {
  const dir = makeTempDir();
  try {
    for (const vector of checkVectors.vectors) {
      await t.test(vector.name, () => {
        const file = writeTemp(dir, "case.json", vector.bytes);
        const result = runCli(["check", file]);
        assert.equal(result.status, vector.exit, `${vector.name}: ${result.stdout}`);
      });
    }
  } finally {
    cleanupTemp(dir);
  }
});

test("check: one line per file, in argument order", () => {
  const dir = makeTempDir();
  try {
    const ok = writeTemp(dir, "ok.json", '{"a":1}');
    const okNewline = writeTemp(dir, "ok-nl.json", '{"a":1}\n');
    const ugly = writeTemp(dir, "ugly.json", '{ "b": 1, "a": 2 }');
    const bad = writeTemp(dir, "bad.json", '{"a":1,"a":2}');
    const missing = join(dir, "absent.json");

    const result = runCli(["check", ok, okNewline, ugly, bad, missing]);
    assert.equal(result.status, 2);
    assert.deepEqual(result.stdout.trimEnd().split("\n"), [
      `OK ${ok}`,
      `OK ${okNewline}`,
      `NOT CANONICAL ${ugly}`,
      `INVALID ${bad}: JSON parse error: duplicate object key "a" (forbidden by RFC 7493 §2.3) at line 1 column 10`,
      `INVALID ${missing}: cannot read: file is missing or unreadable`,
    ]);
    assert.equal(result.stderr, "");
  } finally {
    cleanupTemp(dir);
  }
});

test("check: JSON diagnostics keep the ijson-jcs wording", () => {
  const dir = makeTempDir();
  try {
    const cases = [
      ['{"a":1,"a":2}', "duplicate object key"],
      ["[9007199254740993]", "Number outside safe integer range"],
      ["[1e400]", "number out of range"],
      ["[1,]", "expected value"],
    ];
    for (const [text, expected] of cases) {
      const file = writeTemp(dir, "bad.json", text);
      const result = runCli(["check", file]);
      assert.equal(result.status, 2, text);
      assert.match(result.stdout, /^INVALID .*: /, text);
      assert.match(result.stdout, new RegExp(escapeRegex(expected)), text);
    }
  } finally {
    cleanupTemp(dir);
  }
});

test("fix: writes canonical form plus exactly one newline, then is idempotent", () => {
  const dir = makeTempDir();
  try {
    const file = writeTemp(dir, "ugly.json", '{ "b": 1, "a": 2 }\n');
    const first = runCli(["fix", file]);
    assert.equal(first.status, 0);
    assert.equal(first.stdout, `FIXED ${file}\n`);
    assert.equal(readFileSync(file, "utf8"), '{"a":2,"b":1}\n');

    const second = runCli(["fix", file]);
    assert.equal(second.status, 0);
    assert.equal(second.stdout, `OK ${file}\n`);
    assert.equal(readFileSync(file, "utf8"), '{"a":2,"b":1}\n');

    assert.equal(runCli(["check", file]).status, 0);
  } finally {
    cleanupTemp(dir);
  }
});

test("fix: adds the newline to a bare canonical file", () => {
  const dir = makeTempDir();
  try {
    const file = writeTemp(dir, "bare.json", "[1,2]");
    assert.equal(runCli(["fix", file]).status, 0);
    assert.equal(readFileSync(file, "utf8"), "[1,2]\n");
  } finally {
    cleanupTemp(dir);
  }
});

test("fix: leaves invalid files byte-identical but still fixes valid ones", () => {
  const dir = makeTempDir();
  try {
    const badBytes = '{ "k": 1, "k": 2 }';
    const bad = writeTemp(dir, "dup.json", badBytes);
    const good = writeTemp(dir, "good.json", '{"z":1,"a":0}');
    const result = runCli(["fix", bad, good]);
    assert.equal(result.status, 2);
    assert.equal(readFileSync(bad, "utf8"), badBytes);
    assert.equal(readFileSync(good, "utf8"), '{"a":0,"z":1}\n');
    assert.equal(
      result.stdout,
      `INVALID ${bad}: JSON parse error: duplicate object key "k" (forbidden by RFC 7493 §2.3) at line 1 column 13\n` +
        `FIXED ${good}\n`,
    );
  } finally {
    cleanupTemp(dir);
  }
});

test("canon: emits canonical bytes with no trailing newline", () => {
  const result = runCli(["canon", "--format", "json"], {
    input: '{"a" : [ 1 ] }\n',
  });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdoutBytes.toString("binary"), '{"a":[1]}');
  assert.ok(!result.stdoutBytes.includes(0x0a), "canon output must not end with a newline");
});

test("canon: invalid input exits 2 and writes nothing to stdout", () => {
  const result = runCli(["canon", "--format", "json"], { input: '{"a":1,"a":2}' });
  assert.equal(result.status, 2);
  assert.equal(result.stdoutBytes.length, 0);
  assert.match(result.stderr, /^INVALID <stdin>: JSON parse error: duplicate object key/);
});

test("canon: KYAML is canonicalised through the bridge", () => {
  const result = runCli(["canon"], { input: "b: 1\na: [2, 3]\n" });
  assert.equal(result.status, 0);
  assert.equal(result.stdoutBytes.toString("utf8"), '{"a":[2,3],"b":1}');
});

test("canon: multi-document KYAML needs --array", () => {
  const refused = runCli(["canon"], { input: "a: 1\n---\nb: 2\n" });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /MULTI_DOC_STREAM/);

  const accepted = runCli(["canon", "--array"], { input: "a: 1\n---\nb: 2\n" });
  assert.equal(accepted.status, 0);
  assert.equal(accepted.stdoutBytes.toString("utf8"), '[{"a":1},{"b":2}]');
});

test("canon: a located KYAML failure names the line and column on stderr", () => {
  const result = runCli(["canon"], { input: "a: 1\na: 2\n" });
  assert.equal(result.status, 2);
  assert.match(
    result.stderr,
    /^INVALID <stdin>: DUPLICATE_KEY: duplicate mapping key "a".*\(line 2, column 1\) \(path a\)\n$/,
  );
});

test("check: KYAML canonical form, including the optional final newline", () => {
  const dir = makeTempDir();
  try {
    const canonical = readFixture("kyaml/valid/canonical.yaml").toString("utf8");
    const ok = writeTemp(dir, "ok.yaml", canonical);
    assert.equal(runCli(["check", ok]).status, 0);

    const noNewline = writeTemp(dir, "ok-nonl.yaml", canonical.replace(/\n$/, ""));
    assert.equal(runCli(["check", noNewline]).status, 0);

    const doubleNewline = writeTemp(dir, "ok-2nl.yaml", `${canonical}\n`);
    assert.equal(runCli(["check", doubleNewline]).status, 1);

    const example = writeTemp(
      dir,
      "example.yaml",
      repoFile("examples/deployment.yaml"),
    );
    const result = runCli(["check", example]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, `NOT CANONICAL ${example}\n`);

    const invalid = writeTemp(
      dir,
      "invalid.yaml",
      readFixture("kyaml/invalid/duplicate-key.yaml"),
    );
    const invalidResult = runCli(["check", invalid]);
    assert.equal(invalidResult.status, 2);
    assert.match(invalidResult.stdout, /^INVALID .*DUPLICATE_KEY: .*\(line 5, column 3\)/);
  } finally {
    cleanupTemp(dir);
  }
});

test("fix/fmt: KYAML formatter writes the canonical text and is idempotent", () => {
  const dir = makeTempDir();
  try {
    const file = writeTemp(
      dir,
      "deployment.yaml",
      repoFile("examples/deployment.yaml"),
    );
    const first = runCli(["fix", file]);
    assert.equal(first.status, 0);
    assert.equal(first.stdout, `FIXED ${file}\n`);
    const formatted = readFileSync(file, "utf8");
    assert.ok(formatted.endsWith("\n") && !formatted.endsWith("\n\n"));
    assert.equal(runCli(["check", file]).status, 0);

    // `fmt` is the same command under its YAML-facing name.
    const second = runCli(["fmt", file]);
    assert.equal(second.status, 0);
    assert.equal(second.stdout, `OK ${file}\n`);
    assert.equal(readFileSync(file, "utf8"), formatted);
  } finally {
    cleanupTemp(dir);
  }
});

test("validate: parses and bridges KYAML without judging canonical form", () => {
  const dir = makeTempDir();
  try {
    const example = writeTemp(
      dir,
      "example.yaml",
      repoFile("examples/deployment.yaml"),
    );
    const ok = runCli(["validate", example]);
    assert.equal(ok.status, 0);
    assert.equal(ok.stdout, `OK ${example}\n`);

    const lintFixture = writeTemp(
      dir,
      "lint.yaml",
      repoFile("tests/fixtures/invalid-deployment.yaml"),
    );
    assert.equal(
      runCli(["validate", lintFixture]).status,
      0,
      "a lint problem is not a KYAML problem",
    );

    const invalid = writeTemp(
      dir,
      "invalid.yaml",
      readFixture("kyaml/invalid/unsafe-integer.yaml"),
    );
    const bad = runCli(["validate", invalid]);
    assert.equal(bad.status, 2);
    assert.match(bad.stdout, /UNSAFE_INTEGER/);
  } finally {
    cleanupTemp(dir);
  }
});

test("--report json: one object per file with code, location and path", () => {
  const dir = makeTempDir();
  try {
    const invalid = writeTemp(
      dir,
      "nested.yaml",
      readFixture("kyaml/invalid/duplicate-key.yaml"),
    );
    const valid = writeTemp(dir, "ok.yaml", readFixture("kyaml/valid/canonical.yaml"));
    const result = runCli(["check", "--report", "json", invalid, valid]);
    assert.equal(result.status, 2);
    const lines = result.stdout.trimEnd().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(lines, [
      {
        file: invalid,
        format: "yaml",
        status: "invalid",
        error: {
          code: "DUPLICATE_KEY",
          kind: "kyaml",
          message: 'duplicate mapping key "name"; first defined at line 4, column 3',
          reason: lines[0].error.reason,
          line: 5,
          column: 3,
          path: "metadata/name",
        },
      },
      { file: valid, format: "yaml", status: "ok", error: null },
    ]);
    assert.match(lines[0].error.reason, /^DUPLICATE_KEY: /);
  } finally {
    cleanupTemp(dir);
  }
});

test("--report json: bridge failures keep their own kind", () => {
  const dir = makeTempDir();
  try {
    const file = writeTemp(dir, "key.yaml", "1: one\n");
    const result = runCli(["validate", "--report=json", file]);
    assert.equal(result.status, 2);
    const [entry] = result.stdout.trimEnd().split("\n").map((line) => JSON.parse(line));
    assert.equal(entry.error.code, "NON_STRING_KEY");
    assert.equal(entry.error.kind, "bridge");
    assert.equal(entry.error.line, 1);
    assert.equal(entry.error.column, 1);
  } finally {
    cleanupTemp(dir);
  }
});

test("format detection: extension, override and refusal", () => {
  const dir = makeTempDir();
  try {
    const json = writeTemp(dir, "x.json", '{"b":1,"a":2}');
    assert.equal(runCli(["check", json]).status, 1, "auto-detected as JSON");

    const yaml = writeTemp(dir, "x.yaml", "b: 1\na: 2\n");
    assert.equal(runCli(["check", "--format", "json", yaml]).status, 2, "forced JSON parse fails");

    const unknown = writeTemp(dir, "x.txt", "a: [1]\n");
    const refused = runCli(["check", unknown]);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /cannot tell the format of/);
    // Forced to KYAML the same bytes are valid but not canonical (fmt expands
    // the flow sequence into a block sequence).
    assert.equal(runCli(["check", "--format", "yaml", unknown]).status, 1);
  } finally {
    cleanupTemp(dir);
  }
});

test("-- allows file names that begin with a dash", () => {
  const dir = makeTempDir();
  try {
    writeTemp(dir, "-dash.json", '{"a":1}');

    // Without the separator the name is read as an (unknown) option.
    const refused = runCli(["check", "-dash.json"], { cwd: dir });
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /unknown option/);

    // With it, the file is checked and the printed path is what was given.
    const accepted = runCli(["check", "--", "-dash.json"], { cwd: dir });
    assert.equal(accepted.status, 0);
    assert.equal(accepted.stdout, "OK -dash.json\n");
  } finally {
    cleanupTemp(dir);
  }
});

test("usage errors exit 2 with a message on stderr", () => {
  for (const argv of [
    [],
    ["bogus"],
    ["check"],
    ["fix"],
    ["validate"],
    ["canon", "x.json"],
    ["check", "--nope"],
    ["check", "--format", "toml", "x.yaml"],
    ["check", "--report", "xml", "x.yaml"],
    ["validate", "--format", "json", "x.json"],
  ]) {
    const result = runCli(argv);
    assert.equal(result.status, 2, `argv ${JSON.stringify(argv)}`);
    assert.match(result.stderr, /kyq-conformance: /, `argv ${JSON.stringify(argv)}`);
  }
});

test("--help exits 0 and documents the exit codes; --version prints the pin", () => {
  const help = runCli(["--help"]);
  assert.equal(help.status, 0);
  for (const expected of [
    "check [OPTIONS] FILE...",
    "fix   [OPTIONS] FILE...",
    "canon [OPTIONS]",
    "validate [OPTIONS] FILE...",
    "--report text|json",
    "EXIT STATUS",
    VERSION,
  ]) {
    assert.ok(help.stdout.includes(expected), `help is missing ${expected}`);
  }

  const version = runCli(["--version"]);
  assert.equal(version.status, 0);
  assert.equal(version.stdout, `kyq-conformance ${VERSION}\n`);
});

test("oracle CLI vectors transcribed from ijson-jcs tests", async (t) => {
  const dir = makeTempDir();
  try {
    for (const vector of oracle.cliVectors) {
      await t.test(vector.name, () => {
        if (vector.checkBytes) {
          const files = vector.checkBytes.map((bytes, index) =>
            writeTemp(dir, `check-${index}.json`, bytes),
          );
          assert.equal(runCli(["check", ...files]).status, vector.exit);
        }
        if (vector.fixInput !== undefined) {
          const file = writeTemp(dir, "fix.json", vector.fixInput);
          assert.equal(runCli(["fix", file]).status, 0);
          assert.equal(readFileSync(file, "utf8"), vector.fixOutput);
          assert.equal(runCli(["fix", file]).stdout, `OK ${file}\n`);
          assert.equal(runCli(["check", file]).status, 0);
        }
        if (vector.usageArgv) {
          for (const argv of vector.usageArgv) {
            assert.equal(runCli([...argv]).status, vector.exit, JSON.stringify(argv));
          }
        }
      });
    }
  } finally {
    cleanupTemp(dir);
  }
});

test("canon bytes equal toJcs for every JSON canonical vector", () => {
  for (const vector of readCorpus("ijson/vectors.json").vectors.filter(
    (entry) => entry.jcs !== undefined && !entry.input_hex,
  )) {
    const result = runCli(["canon", "--format=json"], { input: vector.input });
    assert.equal(result.status, 0, vector.name);
    assert.equal(result.stdoutBytes.toString("utf8"), jcsBytes(vector.input), vector.name);
  }
});
