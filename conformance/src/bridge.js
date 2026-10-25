// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell (hyperpolymath) <j.d.a.jewell@open.ac.uk>
//
// The KYAML → JSON bridge φ (`docs/IJSON_JCS_INTEGRATION.adoc` §"KYAML → JCS
// pipeline").
//
// φ is total on the KYAML subset and *lossy nowhere*: every case YAML can
// express but JSON cannot is refused with a located error instead of coerced.
//
//   * non-string mapping keys        → `NON_STRING_KEY`
//   * integers outside ±(2^53−1)     → `UNSAFE_INTEGER` (checked in `BigInt`
//     before any double conversion, so no rounding has happened yet)
//   * `.inf` / `.nan`                → `NON_FINITE_NUMBER`
//   * surrogate / noncharacter text  → `LONE_SURROGATE` / `NONCHARACTER`
//
// The result uses `Map` for objects (insertion order, no prototype keys) and
// `JNumber` for numbers (integer vs float representation is preserved), which is
// the value model `jcs.js` canonicalises.

import { ConformanceError, joinPath } from "./errors.js";
import { JNumber, SAFE_INT_MAX, SAFE_INT_MIN } from "./json.js";
import { NODE_BUDGET } from "./kyaml.js";
import { assertIJsonString } from "./utf8.js";

/**
 * Count a node tree after alias expansion, refusing an anchor bomb.
 *
 * Aliases are shared node references, so a shared subtree counts once per
 * occurrence — the count is the size of the *expanded* document.
 *
 * @param {import("./kyaml.js").Node} node
 * @param {number} [limit]
 * @returns {void}
 * @throws {ConformanceError} `NODE_BUDGET_EXCEEDED`
 */
export function assertNodeBudget(node, limit = NODE_BUDGET) {
  let count = 0;
  /** @type {import("./kyaml.js").Node[]} */
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    count += 1;
    if (count > limit) {
      throw new ConformanceError({
        code: "NODE_BUDGET_EXCEEDED",
        kind: "bridge",
        message: `document expands to more than ${limit} nodes after alias resolution`,
      });
    }
    if (current.kind === "map") {
      for (const entry of current.entries) stack.push(entry.value);
    } else if (current.kind === "seq") {
      stack.push(...current.items);
    }
  }
}

/**
 * Convert one KYAML node to the JSON value model.
 *
 * @param {import("./kyaml.js").Node} node
 * @param {string} [path]
 * @returns {unknown}
 * @throws {ConformanceError}
 */
export function bridgeNode(node, path = "") {
  switch (node.kind) {
    case "null":
      return null;
    case "bool":
      return Boolean(node.value);
    case "int": {
      const value = /** @type {bigint} */ (node.value);
      if (value > SAFE_INT_MAX || value < SAFE_INT_MIN) {
        throw new ConformanceError({
          code: "UNSAFE_INTEGER",
          kind: "bridge",
          message: `integer ${node.raw} is outside the I-JSON safe range [-(2^53)+1, (2^53)-1] and cannot be represented exactly in JSON`,
          line: node.loc.line,
          column: node.loc.column,
          path,
        });
      }
      return new JNumber(Number(value), true, node.raw);
    }
    case "float": {
      const value = /** @type {number} */ (node.value);
      if (!Number.isFinite(value)) {
        throw new ConformanceError({
          code: "NON_FINITE_NUMBER",
          kind: "bridge",
          message: `${node.raw} is not representable in JSON (no NaN or Infinity)`,
          line: node.loc.line,
          column: node.loc.column,
          path,
        });
      }
      return new JNumber(value, false, node.raw);
    }
    case "string": {
      const value = String(node.value);
      assertIJsonString(value, path, "bridge", node.loc);
      return value;
    }
    case "seq": {
      if (node.items.length === 0) return [];
      return node.items.map((item, index) =>
        bridgeNode(item, joinPath(path, String(index))),
      );
    }
    case "map": {
      /** @type {Map<string, unknown>} */
      const object = new Map();
      for (const entry of node.entries) {
        if (entry.key.kind !== "string") {
          throw new ConformanceError({
            code: "NON_STRING_KEY",
            kind: "bridge",
            message: `mapping key ${JSON.stringify(entry.key.raw)} resolves to ${entry.key.kind}, but JSON object keys must be strings`,
            line: entry.key.loc.line,
            column: entry.key.loc.column,
            path,
          });
        }
        const key = String(entry.key.value);
        object.set(key, bridgeNode(entry.value, joinPath(path, key)));
      }
      return object;
    }
    default:
      throw new ConformanceError({
        code: "INTERNAL_NODE_KIND",
        kind: "bridge",
        message: `unknown node kind ${String(node.kind)}`,
        path,
      });
  }
}

/**
 * Convert one document with the node budget enforced.
 *
 * This is the entry point every command uses: `bridgeNode` alone is the
 * recursive converter and would let an alias bomb through.
 *
 * @param {import("./kyaml.js").Node} node
 * @returns {unknown}
 * @throws {ConformanceError}
 */
export function bridgeDocument(node) {
  assertNodeBudget(node);
  return bridgeNode(node, "");
}

/**
 * Convert a parsed stream to the JSON value model.
 *
 * A single document becomes that document's value; a multi-document stream
 * becomes an array when `array` is set and is refused otherwise, because there
 * is no lossless single-value image of a stream.
 *
 * @param {import("./kyaml.js").Node[]} documents
 * @param {{array?: boolean}} [options]
 * @returns {unknown}
 * @throws {ConformanceError}
 */
export function bridgeStream(documents, options = {}) {
  if (documents.length === 0) {
    throw new ConformanceError({
      code: "EMPTY_STREAM",
      kind: "bridge",
      message: "the stream contains no document, so there is no JSON value to emit",
    });
  }
  if (documents.length > 1 && !options.array) {
    throw new ConformanceError({
      code: "MULTI_DOC_STREAM",
      kind: "bridge",
      message: `the stream contains ${documents.length} documents; pass --array to bridge it as one JSON array`,
    });
  }
  if (documents.length === 1) return bridgeDocument(documents[0]);
  return documents.map((document, index) => {
    assertNodeBudget(document);
    return bridgeNode(document, joinPath("", String(index)));
  });
}
