// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell (hyperpolymath) <j.d.a.jewell@open.ac.uk>
//
// Negative controls for tools/native-diff.mjs: the harness must fail on a
// wrong implementation and on a missing one. The positive run needs the built
// native binary, so it is a CI step (.github/workflows/conformance.yml) and
// `just conformance-native`, not a test here.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { cleanupTemp, conformanceRoot, makeTempDir, writeTemp } from "./helpers.js";

const tool = join(conformanceRoot, "tools", "native-diff.mjs");
const diff = (impl) => spawnSync(process.execPath, [tool, "--impl", impl], { encoding: "utf8" });

function planted(body) {
  const dir = makeTempDir();
  const path = writeTemp(dir, "impl.mjs", `#!/usr/bin/env node\n${body}\n`);
  chmodSync(path, 0o755);
  return { dir, path };
}

test("an implementation that accepts everything as {} is caught", () => {
  const { dir, path } = planted('process.stdout.write("{}");');
  try {
    const result = diff(path);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /UNLISTED .*bytes-differ/);
    assert.match(result.stderr, /UNLISTED .*gate-refuses .* impl-accepts/);
  } finally {
    cleanupTemp(dir);
  }
});

test("an implementation that refuses everything is caught, and listed rows go stale", () => {
  const { dir, path } = planted("process.exit(2);");
  try {
    const result = diff(path);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /UNLISTED .*gate-accepts impl-refuses/);
    assert.match(result.stderr, /STALE /);
  } finally {
    cleanupTemp(dir);
  }
});

test("a missing implementation is a failure, not a pass", () => {
  const result = diff(join(conformanceRoot, "no-such-binary"));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /implementation not found/);
});
