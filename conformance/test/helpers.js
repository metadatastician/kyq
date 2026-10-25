// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell (hyperpolymath) <j.d.a.jewell@open.ac.uk>
//
// Shared test helpers: corpus loading, a CLI runner, and a temporary
// workspace. Nothing here is imported by the CLI itself.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of `conformance/`. */
export const conformanceRoot = fileURLToPath(new URL("..", import.meta.url));
/** Absolute path of the CLI entry point. */
export const cliPath = join(conformanceRoot, "bin", "kyq-conformance.mjs");
/** Absolute path of a fixture (or any file under `conformance/`). */
export const fixturePath = (relative) => join(conformanceRoot, "fixtures", relative);

/**
 * Read a file the gate borrows from its parent repository.
 *
 * The gate lives inside the kyq repository, where `examples/deployment.yaml`
 * and `tests/fixtures/invalid-deployment.yaml` already exist. The published
 * tarball has no parent repository, so `conformance/tools/package.sh` mirrors
 * those two files into `fixtures/repo/`. Resolving through this helper keeps one
 * test body working under both layouts, instead of silently skipping the check
 * where the repository files are absent.
 *
 * @param {string} relative  Path relative to the repository root.
 * @returns {Buffer}
 */
export function repoFile(relative) {
  const inRepo = join(conformanceRoot, "..", relative);
  if (existsSync(inRepo)) return readFileSync(inRepo);
  const mirrored = join(conformanceRoot, "fixtures", "repo", relative.split("/").pop());
  if (!existsSync(mirrored)) {
    throw new Error(`missing repository file: ${relative} (and no mirror at ${mirrored})`);
  }
  return readFileSync(mirrored);
}

/**
 * Read and parse a JSON corpus file.
 *
 * @param {string} relative  Path under `conformance/fixtures/`.
 * @returns {any}
 */
export function readCorpus(relative) {
  return JSON.parse(readFileSync(fixturePath(relative), "utf8"));
}

/**
 * Read a fixture as bytes.
 *
 * @param {string} relative
 * @returns {Buffer}
 */
export function readFixture(relative) {
  return readFileSync(fixturePath(relative));
}

/**
 * Run the CLI as a child process.
 *
 * @param {string[]} args
 * @param {{input?: string|Uint8Array, cwd?: string}} [options]
 * @returns {{status: number, stdout: string, stderr: string, stdoutBytes: Buffer}}
 */
export function runCli(args, options = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    input: options.input,
    cwd: options.cwd,
  });
  if (result.error) throw result.error;
  const stdoutBytes = Buffer.isBuffer(result.stdout)
    ? result.stdout
    : Buffer.from(result.stdout ?? "");
  return {
    status: result.status ?? -1,
    stdout: stdoutBytes.toString("utf8"),
    stderr: (Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr ?? "")).toString("utf8"),
    stdoutBytes,
  };
}

/**
 * Create a temporary directory that the caller removes with `cleanupTemp`.
 *
 * @returns {string}
 */
export function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "kyq-conformance-"));
}

/**
 * Write bytes/text to `name` inside `dir` and return the full path.
 *
 * @param {string} dir
 * @param {string} name
 * @param {string|Uint8Array} contents
 * @returns {string}
 */
export function writeTemp(dir, name, contents) {
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

/**
 * Remove a temporary directory.
 *
 * @param {string} dir
 * @returns {void}
 */
export function cleanupTemp(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Decode hex into bytes (for `input_hex` vectors).
 *
 * @param {string} hex
 * @returns {Uint8Array}
 */
export function fromHex(hex) {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

/**
 * Encode a string as UTF-8 bytes.
 *
 * @param {string} text
 * @returns {Uint8Array}
 */
export function utf8(text) {
  return new TextEncoder().encode(text);
}
