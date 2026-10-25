#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell (hyperpolymath) <j.d.a.jewell@open.ac.uk>
//
// Differential harness: build the pinned `hyperpolymath/ijson-jcs` commit and
// compare the real binary with this gate, byte for byte and status for status.
//
// The static corpus (`conformance/fixtures/`) pins expectations so the gate can
// be tested without a Rust toolchain. This tool is the other half of that
// pinning: it re-derives the expectations from the oracle itself, which turns
// "transcribed by hand" into "measured". It is what the `oracle` job in
// .github/workflows/conformance.yml runs, and what
// `docs/IJSON_JCS_INTEGRATION.adoc` cites.
//
// Usage:
//   node conformance/tools/ijson-jcs-diff.mjs
//   node conformance/tools/ijson-jcs-diff.mjs --bin /path/to/ijson-jcs
//   node conformance/tools/ijson-jcs-diff.mjs --work /tmp/oracle --keep
//
// Exit codes: 0 = every case agrees, 2 = a mismatch, or an oracle that could
// not be obtained or built. A missing toolchain is a failure, never a pass.
//
// The build uses `--locked`: ijson-jcs ships a Cargo.lock, so its dependency
// tree is pinned as well as its commit.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_URL = "https://github.com/hyperpolymath/ijson-jcs.git";
const gateRoot = fileURLToPath(new URL("..", import.meta.url));
const gateCli = join(gateRoot, "bin", "kyq-conformance.mjs");

/**
 * Read a JSON fixture.
 *
 * @param {string} ...segments path segments below `conformance/`
 * @returns {any}
 */
function fixture(...segments) {
  return JSON.parse(readFileSync(join(gateRoot, ...segments), "utf8"));
}

/**
 * Render a case's input as the exact bytes to feed a CLI.
 *
 * @param {{input?: string, input_hex?: string}} vector
 * @returns {Buffer}
 */
function bytesOf(vector) {
  if (typeof vector.input_hex === "string") {
    return Buffer.from(vector.input_hex, "hex");
  }
  return Buffer.from(vector.input ?? "", "utf8");
}

/**
 * Parse argv.
 *
 * @param {string[]} argv
 * @returns {{bin: string|null, commit: string, crate: string, work: string|null, keep: boolean}}
 */
function parseArgs(argv) {
  const oracle = fixture("fixtures", "oracle", "ijson-jcs.json").oracle;
  const options = {
    bin: null,
    commit: oracle.commit,
    crate: oracle.crate,
    work: null,
    keep: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--bin") {
      options.bin = argv[index + 1];
      index += 1;
    } else if (arg === "--commit") {
      options.commit = argv[index + 1];
      index += 1;
    } else if (arg === "--work") {
      options.work = argv[index + 1];
      index += 1;
    } else if (arg === "--keep") {
      options.keep = true;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "usage: ijson-jcs-diff.mjs [--bin PATH] [--commit SHA] [--work DIR] [--keep]\n",
      );
      process.exit(0);
    } else {
      process.stderr.write(`ijson-jcs-diff: unknown argument '${arg}'\n`);
      process.exit(2);
    }
  }
  if (options.bin === null && !/^[0-9a-f]{40}$/.test(options.commit)) {
    process.stderr.write(`ijson-jcs-diff: '${options.commit}' is not a full commit id\n`);
    process.exit(2);
  }
  return options;
}

/**
 * Run a command and return its result with raw byte output.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, input?: Buffer}} [options]
 * @returns {{status: number, stdout: Buffer, stderr: Buffer}}
 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: options.cwd, input: options.input });
  if (result.error) {
    return { status: 127, stdout: Buffer.alloc(0), stderr: Buffer.from(String(result.error)) };
  }
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: result.stderr ?? Buffer.alloc(0),
  };
}

/**
 * Clone and build the pinned commit; return the binary path.
 *
 * @param {{commit: string, work: string|null, keep: boolean}} options
 * @returns {string}
 */
function buildOracle(options) {
  const dir = options.work ?? mkdtempSync(join(tmpdir(), "ijson-jcs-oracle-"));
  const checkout = join(dir, "src");
  if (options.work !== null) mkdirSync(options.work, { recursive: true });
  const cleanup = () => {
    if (options.work === null) rmSync(dir, { recursive: true, force: true });
  };
  if (!options.keep) process.on("exit", cleanup);

  /**
   * Fail the whole run with a message that says what to install.
   *
   * @param {string} what
   * @param {{stderr: Buffer}} result
   * @returns {never}
   */
  const fail = (what, result) => {
    process.stderr.write(`ijson-jcs-diff: ${what}\n${result.stderr.toString().slice(-4000)}\n`);
    process.exit(2);
  };

  if (!existsSync(join(checkout, ".git"))) {
    const clone = run("git", ["clone", "--quiet", REPO_URL, checkout]);
    if (clone.status !== 0) fail("git clone of the oracle failed", clone);
  }
  // A fresh clone already contains every reachable commit, so try a plain
  // checkout first: asking the server for a bare SHA is a capability some hosts
  // disable, and a needless fetch is a needless way to fail.
  const switchToCommit = () =>
    run("git", ["checkout", "--quiet", options.commit], { cwd: checkout });
  let switched = switchToCommit();
  if (switched.status !== 0) {
    const fetch = run("git", ["fetch", "--quiet", "origin", options.commit], { cwd: checkout });
    if (fetch.status !== 0) fail(`cannot fetch ${options.commit}`, fetch);
    switched = switchToCommit();
  }
  if (switched.status !== 0) fail(`cannot check out ${options.commit}`, switched);
  const head = run("git", ["rev-parse", "HEAD"], { cwd: checkout }).stdout.toString().trim();
  if (head !== options.commit) {
    process.stderr.write(`ijson-jcs-diff: HEAD is ${head}, not the pinned ${options.commit}\n`);
    process.exit(2);
  }

  process.stdout.write(`ijson-jcs-diff: building the oracle at ${options.commit}\n`);
  const cargo = run("cargo", ["build", "--release", "--locked"], { cwd: checkout });
  if (cargo.status !== 0) {
    fail(
      "cargo build failed (a stable Rust toolchain with 2024-edition support is required)",
      cargo,
    );
  }
  return join(checkout, "target", "release", "ijson-jcs");
}

/**
 * Collect every case to diff, tagged with the surface it exercises.
 *
 * @returns {{name: string, kind: "canon"|"refuse"|"check", bytes: Buffer,
 *            expected: string|number}[]}
 */
function collectCases() {
  /** @type {{name: string, kind: "canon"|"refuse"|"check", bytes: Buffer, expected: string|number}[]} */
  const cases = [];

  for (const vector of fixture("fixtures", "ijson", "vectors.json").vectors) {
    if (typeof vector.jcs === "string") {
      cases.push({ name: `vectors/${vector.name}`, kind: "canon", bytes: bytesOf(vector), expected: vector.jcs });
    } else if (vector.error !== undefined) {
      cases.push({ name: `vectors/${vector.name}`, kind: "refuse", bytes: bytesOf(vector), expected: 2 });
    }
  }
  for (const vector of fixture("fixtures", "ijson", "check.json").vectors) {
    cases.push({
      name: `check/${vector.name}`,
      kind: "check",
      bytes: Buffer.from(vector.bytes, "utf8"),
      expected: vector.exit,
    });
  }
  const oracle = fixture("fixtures", "oracle", "ijson-jcs.json");
  for (const vector of oracle.canonVectors) {
    cases.push({ name: `oracle/${vector.name}`, kind: "canon", bytes: bytesOf(vector), expected: vector.jcs });
  }
  for (const vector of oracle.acceptVectors) {
    cases.push({ name: `oracle/${vector.name}`, kind: "canon", bytes: bytesOf(vector), expected: vector.jcs });
  }
  for (const vector of oracle.rejectVectors) {
    cases.push({ name: `oracle/${vector.name}`, kind: "refuse", bytes: bytesOf(vector), expected: 2 });
  }
  for (const vector of oracle.cliVectors) {
    if (typeof vector.input === "string" && typeof vector.stdout === "string") {
      cases.push({
        name: `oracle/${vector.name}`,
        kind: "canon",
        bytes: bytesOf(vector),
        expected: vector.stdout,
      });
    } else if (Array.isArray(vector.checkBytes)) {
      for (const [index, text] of vector.checkBytes.entries()) {
        cases.push({
          name: `oracle/${vector.name}[${index}]`,
          kind: "check",
          bytes: Buffer.from(text, "utf8"),
          expected: vector.exit,
        });
      }
    }
  }
  return cases;
}

/**
 * Diff one case on both CLIs.
 *
 * @param {string} bin
 * @param {{name: string, kind: "canon"|"refuse"|"check", bytes: Buffer,
 *          expected: string|number}} testCase
 * @param {string} dir scratch directory for `check` cases
 * @returns {string[]} mismatch descriptions, empty when the case agrees
 */
function diffCase(bin, testCase, dir) {
  const problems = [];
  if (testCase.kind === "canon") {
    const oracleResult = run(bin, ["canon"], { input: testCase.bytes });
    const gateResult = run(process.execPath, [gateCli, "canon", "--format", "json"], {
      input: testCase.bytes,
    });
    if (oracleResult.status !== 0) {
      problems.push(`oracle exit ${oracleResult.status}: ${oracleResult.stderr.toString().trim()}`);
    } else if (oracleResult.stdout.toString("utf8") !== testCase.expected) {
      problems.push(
        `pinned bytes stale: corpus ${JSON.stringify(testCase.expected)} != oracle ${JSON.stringify(oracleResult.stdout.toString("utf8"))}`,
      );
    }
    if (gateResult.status !== 0) {
      problems.push(`gate exit ${gateResult.status}: ${gateResult.stderr.toString().trim()}`);
    } else if (!gateResult.stdout.equals(oracleResult.stdout)) {
      problems.push(
        `bytes differ: oracle ${JSON.stringify(oracleResult.stdout.toString("utf8"))} != gate ${JSON.stringify(gateResult.stdout.toString("utf8"))}`,
      );
    }
    return problems;
  }

  if (testCase.kind === "refuse") {
    const oracleResult = run(bin, ["canon"], { input: testCase.bytes });
    const gateResult = run(process.execPath, [gateCli, "canon", "--format", "json"], {
      input: testCase.bytes,
    });
    if (oracleResult.status !== 2) {
      problems.push(`oracle accepted a refused vector (exit ${oracleResult.status})`);
    }
    if (gateResult.status !== 2) {
      problems.push(`gate accepted a refused vector (exit ${gateResult.status})`);
    }
    // Both must locate the refusal on the `INVALID <stdin>:` line, per
    // tests/cli.rs:canon_rejects_invalid_input_with_exit_2.
    if (!oracleResult.stderr.toString("utf8").startsWith("INVALID <stdin>:")) {
      problems.push("oracle stderr does not start with 'INVALID <stdin>:'");
    }
    if (!gateResult.stderr.toString("utf8").startsWith("INVALID <stdin>:")) {
      problems.push("gate stderr does not start with 'INVALID <stdin>:'");
    }
    return problems;
  }

  const file = join(dir, `${testCase.name.replace(/[^a-z0-9]+/gi, "-")}.json`);
  writeFileSync(file, testCase.bytes);
  const oracleResult = run(bin, ["check", file]);
  const gateResult = run(process.execPath, [gateCli, "check", file]);
  const expected = /** @type {number} */ (testCase.expected);
  if (oracleResult.status !== expected) {
    problems.push(`oracle check exit ${oracleResult.status} != expected ${expected}`);
  }
  if (gateResult.status !== expected) {
    problems.push(`gate check exit ${gateResult.status} != expected ${expected}`);
  }
  // The printed line is part of the contract, so compare it modulo the path.
  const normalise = (buffer) => buffer.toString("utf8").trimEnd().split(dir).join("<dir>");
  const oracleLine = normalise(oracleResult.stdout);
  const gateLine = normalise(gateResult.stdout);
  if (oracleLine !== gateLine) {
    problems.push(`printed line differs: oracle ${JSON.stringify(oracleLine)} != gate ${JSON.stringify(gateLine)}`);
  }
  return problems;
}

/**
 * Entry point.
 *
 * @returns {number}
 */
function main() {
  const options = parseArgs(process.argv.slice(2));
  const bin = options.bin ?? buildOracle(options);
  if (!existsSync(bin)) {
    process.stderr.write(`ijson-jcs-diff: no oracle binary at ${bin}\n`);
    return 2;
  }

  const cases = collectCases();
  if (cases.length === 0) {
    process.stderr.write("ijson-jcs-diff: no cases collected; refusing to report a pass\n");
    return 2;
  }

  const dir = mkdtempSync(join(tmpdir(), "ijson-jcs-cases-"));
  const failures = [];
  try {
    for (const testCase of cases) {
      const problems = diffCase(bin, testCase, dir);
      if (problems.length > 0) failures.push(`${testCase.name}\n  ${problems.join("\n  ")}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    process.stderr.write(
      `ijson-jcs-diff: ${failures.length} of ${cases.length} cases disagree with ${options.crate} at ${options.commit}\n\n`,
    );
    process.stderr.write(`${failures.join("\n\n")}\n`);
    return 2;
  }

  process.stdout.write(
    `ijson-jcs-diff: ${cases.length} cases agree with ${options.crate} at ${options.commit}\n`,
  );
  return 0;
}

process.exitCode = main();
