// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell (hyperpolymath) <j.d.a.jewell@open.ac.uk>
//
// Resource budgets (owner ruling R3, 2026-11-17): the ONE module that defines
// them. Every other module imports its limits from here.
//
// The budgets are on *value* measures, not on encoded bytes, so that the gate
// is closed under its own canonical form: `canon` and `fix` change the bytes
// (numbers grow up to 3.4x, indentation grows, aliases expand) but never the
// value, so a value that passed every budget on the way in passes them again
// when its canonical text is checked (`check(canon x) = OK`). A budget on
// encoded bytes would break that (verify-logic L6).
//
// The measures, all taken on the JSON data-model image of the input (aliases
// expanded, keys are not values):
//
//   depth        containers on the longest root-to-leaf path. A scalar adds
//                nothing; `[]` has depth 1; `[[1]]` has depth 2.
//   nodes        values: every container and every scalar, keys excluded.
//   string bytes UTF-8 bytes of every decoded string *and* every key.
//   expansion    for KYAML only: what aliases add, i.e. the expanded measure
//                minus the measure of the distinct nodes, for nodes and for
//                string bytes. A document without aliases expands by zero.
//
// Defaults and rationale (pending a standards ruling; see
// docs/proposals/STANDARDS-BUDGETS-FLOATS.adoc):
//
//   MAX_DEPTH 127. hyperpolymath/ijson-jcs at kyq's pin 2c880594 parses text
//     with serde_json 1.0.151, whose Deserializer starts at remaining_depth
//     128 and fails when a `[`/`{` brings it to 0 (serde_json src/de.rs:63 and
//     :1372-1378): 127 containers are accepted, the 128th is
//     "recursion limit exceeded". ijson-jcs main 1735d68 adds MAX_DEPTH = 128
//     for constructed values (src/lib.rs:81) and keeps the same text limit.
//     The gate matches the text limit, so JSON verdicts and messages agree.
//   MAX_NODES 500 000. About 1.4x the 10 MB KYAML stream used by the weight
//     benchmark (9 801 Kubernetes documents, 352 836 nodes, measured
//     2026-11-17); estate configuration files are orders of magnitude
//     smaller. It also keeps the output bound below MAX_INPUT_BYTES (below).
//   MAX_STRING_BYTES 8 MiB. About 2x the same stream's 4 250 147 string bytes.
//   MAX_EXPANSION_NODES 100 000. The old per-document NODE_BUDGET, now applied
//     only to what aliases add (the anchor-bomb limit, SEC-1).
//   MAX_EXPANSION_BYTES 1 MiB. Bounds string amplification through aliases: the
//     64 108-byte probe that expanded to 81 984 110 bytes (and the 125 548-byte
//     one that crashed node) is refused from memoised per-node measures, in
//     time linear in the source, without expanding anything (23-49 ms
//     measured on node 22 and bun 1.4.4, 2026-11-17).
//   MAX_INPUT_BYTES 256 MiB. The only encoded-bytes limit, at the CLI edge. It
//     must not refuse a canonical output of an accepted value, so it is at
//     least outputBound(MAX_NODES, MAX_STRING_BYTES) (asserted below and by
//     test). It also sits below V8's string-length limit (2^29 - 24 UTF-16
//     units), so huge inputs get a typed refusal instead of a runtime-specific
//     RangeError.
//
// Every limit is checked by an explicit counter. Nothing relies on a stack
// overflow, so the verdict does not depend on the runtime or the JIT.

import { ConformanceError } from "./errors.js";

/** Containers on the longest path (ijson-jcs text limit at pin 2c880594). */
export const MAX_DEPTH = 127;
/** Values in the expanded data-model image (keys excluded). */
export const MAX_NODES = 500_000;
/** UTF-8 bytes of all decoded strings and keys in the expanded image. */
export const MAX_STRING_BYTES = 8 * 1024 * 1024;
/** Nodes that alias expansion may add to a KYAML stream. */
export const MAX_EXPANSION_NODES = 100_000;
/** String bytes that alias expansion may add to a KYAML stream. */
export const MAX_EXPANSION_BYTES = 1024 * 1024;
/** Raw input bytes, enforced only at the CLI edge. */
export const MAX_INPUT_BYTES = 256 * 1024 * 1024;

/**
 * Typed codes, one per budget. Names follow the existing
 * `NODE_BUDGET_EXCEEDED` (contract <= 0.3.0), which keeps its name and now
 * means the value-node budget.
 */
export const BUDGET_CODES = Object.freeze({
  depth: "DEPTH_BUDGET_EXCEEDED",
  nodes: "NODE_BUDGET_EXCEEDED",
  stringBytes: "STRING_BUDGET_EXCEEDED",
  expansion: "EXPANSION_BUDGET_EXCEEDED",
  input: "INPUT_BUDGET_EXCEEDED",
});

/**
 * Upper bound on the length of any canonical text of a value with these
 * measures: JCS bytes, or the KYAML formatter's text.
 *
 * Per value: at most one formatter line, whose indentation is at most
 * 2 * MAX_DEPTH = 254 bytes, plus `- `, `key: ` punctuation (and the key's
 * quotes), a scalar of at most 26 bytes (the longest ES number text, e.g.
 * `-0.0000012345678901234567`), a newline and a `---` separator line: under
 * 300 bytes. JCS needs at most 32 bytes per value. Per string byte: at most 6
 * bytes (`\u0001`), plus quotes, which are already in the per-value cost.
 *
 * @param {number} nodes
 * @param {number} stringBytes
 * @returns {number}
 */
export function outputBound(nodes, stringBytes) {
  return nodes * 300 + stringBytes * 6;
}

if (outputBound(MAX_NODES, MAX_STRING_BYTES) > MAX_INPUT_BYTES) {
  // A misconfiguration here would let `check` refuse `canon`'s own output.
  throw new Error("budgets: MAX_INPUT_BYTES is below the canonical output bound");
}

/**
 * UTF-8 length of a JS string without allocating. A surrogate pair is four
 * bytes; a lone surrogate (refused elsewhere) is counted as three.
 *
 * @param {string} text
 * @returns {number}
 */
export function utf8Length(text) {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Build the typed diagnostic for an exceeded budget.
 *
 * @param {"depth"|"nodes"|"stringBytes"|"expansion"|"input"} which
 * @param {string} message
 * @param {{kind?: string, line?: number, column?: number, path?: string}} [at]
 * @returns {ConformanceError}
 */
export function budgetError(which, message, at = {}) {
  return new ConformanceError({
    code: BUDGET_CODES[which],
    kind: at.kind ?? "bridge",
    message,
    line: at.line,
    column: at.column,
    path: at.path,
  });
}

/** Message fragments shared by every caller, so the text is uniform. */
export const budgetMessage = Object.freeze({
  depth: (depth = MAX_DEPTH + 1) =>
    `nesting depth ${depth} exceeds the budget of ${MAX_DEPTH} containers`,
  nodes: () => `the value has more than ${MAX_NODES} nodes`,
  stringBytes: () => `the value has more than ${MAX_STRING_BYTES} bytes of decoded strings and keys`,
  expansionNodes: () => `alias expansion adds more than ${MAX_EXPANSION_NODES} nodes`,
  expansionBytes: () => `alias expansion adds more than ${MAX_EXPANSION_BYTES} bytes of decoded strings and keys`,
  output: (size) =>
    `the fixed output would be ${size} bytes, over the ${MAX_INPUT_BYTES}-byte input budget; the gate would refuse it`,
  input: (size) => `the input is ${size} bytes, over the ${MAX_INPUT_BYTES}-byte input budget`,
});

/**
 * Measure a JSON data-model value (`Map`, array, string, number-like, null,
 * boolean) and refuse it if any value budget is exceeded. Iterative, so the
 * walk itself cannot overflow the stack.
 *
 * This is the closure guard: `toJcs` runs it on every value it emits, and the
 * JSON reader enforces the same limits while parsing, so the emitted text of an
 * accepted value is accepted again.
 *
 * @param {unknown} value
 * @param {string} [kind]  Diagnostic kind (`jcs` from the serialiser).
 * @returns {{depth: number, nodes: number, stringBytes: number}}
 * @throws {ConformanceError}
 */
export function assertValueBudgets(value, kind = "jcs") {
  let nodes = 0;
  let stringBytes = 0;
  let maxDepth = 0;
  /** @type {[unknown, number][]} value and the containers above it */
  const stack = [[value, 0]];
  while (stack.length > 0) {
    const [current, above] = /** @type {[unknown, number]} */ (stack.pop());
    nodes += 1;
    if (nodes > MAX_NODES) throw budgetError("nodes", budgetMessage.nodes(), { kind });
    if (typeof current === "string") {
      stringBytes += utf8Length(current);
    } else if (Array.isArray(current) || current instanceof Map) {
      const depth = above + 1;
      if (depth > MAX_DEPTH) throw budgetError("depth", budgetMessage.depth(depth), { kind });
      if (depth > maxDepth) maxDepth = depth;
      if (Array.isArray(current)) {
        for (const item of current) stack.push([item, depth]);
      } else {
        for (const [key, item] of current) {
          stringBytes += utf8Length(key);
          stack.push([item, depth]);
        }
      }
    }
    if (stringBytes > MAX_STRING_BYTES) {
      throw budgetError("stringBytes", budgetMessage.stringBytes(), { kind });
    }
  }
  return { depth: maxDepth, nodes, stringBytes };
}
