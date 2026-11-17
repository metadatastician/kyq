// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell (hyperpolymath) <j.d.a.jewell@open.ac.uk>
//
// `fix` and comments (spec §7.3). Comments are not data, so formatting drops
// them; `fix` therefore keeps the leading header comment block byte for byte
// (it carries the SPDX licence line) and REFUSES, with `COMMENTS_WOULD_BE_LOST`,
// any file with a comment outside that header. `check` accepts exactly what `fix`
// writes (header verbatim + formatted body), so `check(fix x) = OK` holds for headed
// files too. `canon` drops comments (a departure from CORRECTIONS B2 pending an
// owner ruling, see KYAML_SPEC §7.3).

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { MAX_INPUT_BYTES } from "../src/budgets.js";
import { checkVerdict, fixText } from "../src/cli.js";
import { KyamlParser, parseKyamlWithComments } from "../src/kyaml.js";

import {
  cleanupTemp,
  fixturePath,
  makeTempDir,
  readCorpus,
  readFixture,
  runCli,
  writeTemp,
} from "./helpers.js";

/** The exact text `fix` writes for each accepted fixture. */
const accepted = {
  "spdx-header.yaml":
    "# SPDX-License-Identifier: MPL-2.0\n# SPDX-FileCopyrightText: 2026 Example\n\n# Free-form header note.\napiVersion: v1\nkind: Namespace\nmetadata:\n  name: demo\n  labels:\n    tier: web\n",
  // The header keeps its CRLF line ends byte for byte; the body is the formatter's LF text.
  "spdx-header-crlf.yaml": "# SPDX-License-Identifier: MPL-2.0\r\n\r\nmetadata:\n  name: demo\n",
  // A stream of comments only has no body; the header is the whole file.
  "header-only.yaml": "# SPDX-License-Identifier: MPL-2.0\n# nothing else\n",
  // No comment, no header: exactly the previous behaviour.
  "no-header.yaml": "a:\n  b: 1\n",
};

/** Refused fixtures and the 1-based position of the first lost comment. */
const refused = {
  "interior-comment.yaml": [4, 1],
  "trailing-comment.yaml": [2, 16],
  "eof-comment.yaml": [3, 1],
  "directive-comment.yaml": [1, 11],
};

const spdx = "# SPDX-License-Identifier: MPL-2.0";

test("every fix fixture is classified exactly once", () => {
  const files = readdirSync(fixturePath("kyaml/fix")).sort();
  assert.deepEqual(files, [...Object.keys(accepted), ...Object.keys(refused)].sort());
});

for (const [name, expected] of Object.entries(accepted)) {
  test(`fix keeps the header byte for byte and is idempotent: ${name}`, () => {
    const dir = makeTempDir();
    try {
      const file = writeTemp(dir, "case.yaml", readFixture(`kyaml/fix/${name}`));
      const first = runCli(["fix", file]);
      assert.equal(first.status, 0, first.stdout);
      const once = readFileSync(file);
      assert.equal(once.toString("utf8"), expected);
      // fmt(fmt x) = fmt x: a second fix reports OK and leaves the bytes alone.
      const second = runCli(["fmt", file]);
      assert.equal(second.status, 0);
      assert.equal(second.stdout, `OK ${file}\n`);
      assert.deepEqual(readFileSync(file), once);
    } finally {
      cleanupTemp(dir);
    }
  });
}

for (const [name, [line, column]] of Object.entries(refused)) {
  test(`fix refuses and leaves the file untouched: ${name}`, () => {
    const dir = makeTempDir();
    try {
      const input = readFixture(`kyaml/fix/${name}`);
      const file = writeTemp(dir, "case.yaml", input);
      const result = runCli(["fix", "--report", "json", file]);
      assert.equal(result.status, 2);
      const report = JSON.parse(result.stdout);
      assert.equal(report.status, "invalid");
      assert.equal(report.error.code, "COMMENTS_WOULD_BE_LOST");
      assert.equal(report.error.kind, "kyaml");
      assert.equal(report.error.line, line);
      assert.equal(report.error.column, column);
      assert.deepEqual(readFileSync(file), input, "a refused file must not be modified");
      // The text report names the code and the position too.
      const text = runCli(["fix", file]);
      assert.equal(text.status, 2);
      assert.match(text.stdout, new RegExp(`COMMENTS_WOULD_BE_LOST.*\\(line ${line}, column ${column}\\)`));
    } finally {
      cleanupTemp(dir);
    }
  });
}

test("the SPDX line is never deleted, on any valid fixture", async (t) => {
  const corpus = readCorpus("kyaml/cases.json");
  for (const entry of corpus.cases.filter((c) => c.expect === "valid")) {
    await t.test(entry.file, () => {
      const dir = makeTempDir();
      try {
        const bytes = readFixture(`kyaml/${entry.file}`);
        const withSpdx = Buffer.concat([Buffer.from(`${spdx}\n`), bytes]);
        const file = writeTemp(dir, "case.yaml", withSpdx);
        const result = runCli(["fix", file]);
        const after = readFileSync(file);
        if (result.status === 0) {
          assert.ok(after.toString("utf8").startsWith(spdx), "SPDX line lost");
          // Idempotence on everything fix accepts.
          const again = runCli(["fix", file]);
          assert.equal(again.status, 0);
          assert.deepEqual(readFileSync(file), after);
        } else {
          assert.equal(result.status, 2);
          assert.deepEqual(after, withSpdx, "a refusal must not modify the file");
        }
      } finally {
        cleanupTemp(dir);
      }
    });
  }
});

test("check and fix agree on headed files: unformatted is NOT CANONICAL, fixed is OK", () => {
  const dir = makeTempDir();
  try {
    const file = writeTemp(dir, "case.yaml", readFixture("kyaml/fix/spdx-header.yaml"));
    const before = runCli(["check", file]);
    assert.equal(before.status, 1);
    assert.equal(before.stdout, `NOT CANONICAL ${file}\n`);
    assert.equal(runCli(["fix", file]).status, 0);
    const after = runCli(["check", file]);
    assert.equal(after.status, 0, after.stdout);
    assert.equal(after.stdout, `OK ${file}\n`);
  } finally {
    cleanupTemp(dir);
  }
});

test("check(fix x) = OK and fix(fix x) = fix x on header edge cases", () => {
  const cases = {
    "header-only, no final newline": "# only",
    "header and body, odd spacing": "# SPDX-License-Identifier: MPL-2.0\nk:   1\n",
    "BOM then header": "\uFEFF# SPDX-License-Identifier: MPL-2.0\nk: 1\n",
    "header then --- marker": "# SPDX-License-Identifier: MPL-2.0\n---\nk: 1\n",
    "CRLF header, LF-less end": "# SPDX-License-Identifier: MPL-2.0\r\nk: 1",
    "CRLF header only": "# a\r\n# b\r\n",
    "blank lines inside the header": "# a\n\n\n# b\n\nk: 1\n",
    "header before a multi-document stream": "# h\n---\na: 1\n---\nb: 2\n",
  };
  for (const [name, input] of Object.entries(cases)) {
    const fixed = fixText(Buffer.from(input), "yaml");
    assert.equal(checkVerdict(Buffer.from(fixed), "yaml").status, "ok", `check(fix x) for ${name}`);
    assert.equal(fixText(Buffer.from(fixed), "yaml"), fixed, `fix(fix x) for ${name}`);
    // The header's own bytes, line endings included, lead the output.
    const lead = input.replace(/^\uFEFF/, "").match(/^(?:[ \t]*(?:#[^\n]*)?\r?\n)*/)[0];
    assert.ok(fixed.startsWith(lead), `header kept verbatim for ${name}`);
  }
});

test("check still rejects a file whose comment fix would refuse", () => {
  const verdict = checkVerdict(readFixture("kyaml/fix/interior-comment.yaml"), "yaml");
  assert.equal(verdict.status, "not-canonical");
});

test("comments are not recorded on the check and canon paths (O(1) memory)", () => {
  const text = `a: 1\n${"#\n".repeat(200000)}`;
  const noHeader = parseKyamlWithComments(Buffer.from(text));
  assert.equal(noHeader.lostComment, null, "nothing is recorded unless fix asks");
  const asked = parseKyamlWithComments(Buffer.from(text), undefined, 1);
  assert.deepEqual(asked.lostComment, { line: 2, column: 1 }, "only the first lost comment is kept");
  const parser = new KyamlParser("a: 1\n#\n#\n");
  assert.ok(!Array.isArray(parser.comments), "no per-comment list exists");
});

test("a large comment-only stream gets a verdict, not a runtime abort", { timeout: 120000 }, () => {
  // 64 MiB of comment lines: the base code held one object per comment and the
  // node heap aborted (no verdict) at 250 MiB while bun finished; both now give
  // the same typed verdict from constant memory.
  const header = "#\n".repeat(32 * 1024 * 1024);
  assert.equal(checkVerdict(Buffer.from(`${header}a: 1\n`), "yaml").status, "ok");
  assert.equal(checkVerdict(Buffer.from(`a:   1\n${header}`), "yaml").status, "not-canonical");
  assert.throws(
    () => fixText(Buffer.from(`a: 1\n${header}`), "yaml"),
    (error) => error.code === "COMMENTS_WOULD_BE_LOST" && error.line === 2,
  );
});

test("fix refuses, typed and untouched, when header + body would pass the input budget", { timeout: 120000 }, () => {
  // The header is written verbatim and is not covered by outputBound. The
  // input is under the budget; the body is longer than its source, so the
  // result would be over it and the gate would refuse its own fix output.
  const body = Buffer.from("[1e15]\n");
  const header = Buffer.alloc(2 * Math.floor((MAX_INPUT_BYTES - body.length) / 2), "#\n");
  const input = Buffer.concat([header, body]);
  assert.ok(input.length <= MAX_INPUT_BYTES);
  assert.throws(
    () => fixText(input, "yaml"),
    (error) => error.code === "INPUT_BUDGET_EXCEEDED" && error.kind === "kyaml",
  );
});

// PENDING OWNER RULING: CORRECTIONS B2 says `canon` keeps comments or refuses with
// a typed code. This pins the current behaviour (drop) so a ruling changes it
// loudly; see KYAML_SPEC §7.3.
test("canon projects to JSON and drops comments (it edits no file)", () => {
  const result = runCli(["canon"], { input: readFixture("kyaml/fix/spdx-header.yaml") });
  assert.equal(result.status, 0);
  assert.equal(
    result.stdout,
    '{"apiVersion":"v1","kind":"Namespace","metadata":{"labels":{"tier":"web"},"name":"demo"}}',
  );
});
