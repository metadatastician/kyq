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
//   * a float whose canonical text is an integer token outside ±(2^53−1)
//     (`1e18`, `9007199254740993.0`) → `UNSAFE_FLOAT_INTEGER` (ruling R3:
//     otherwise `check(canon x)` would refuse what `canon` printed)
//   * surrogate / noncharacter text  → `LONE_SURROGATE` / `NONCHARACTER`
//
// The result uses `Map` for objects (insertion order, no prototype keys) and
// `JNumber` for numbers (integer vs float representation is preserved), which is
// the value model `jcs.js` canonicalises.

import {
  MAX_DEPTH,
  MAX_EXPANSION_BYTES,
  MAX_EXPANSION_NODES,
  MAX_NODES,
  MAX_STRING_BYTES,
  budgetError,
  budgetMessage,
  utf8Length,
} from "./budgets.js";
import { ConformanceError, joinPath } from "./errors.js";
import {
  JNumber,
  SAFE_INT_MAX,
  SAFE_INT_MIN,
  isUnsafeIntegerFloat,
  unsafeFloatDetail,
} from "./json.js";
import { assertIJsonString } from "./utf8.js";

/**
 * Measure a parsed KYAML stream on the JSON data-model image and refuse it if
 * any value budget (`budgets.js`) is exceeded. Nothing is expanded: aliases
 * are shared node objects, so each distinct node is measured once (post-order,
 * iterative) and an alias contributes its target's memoised measure. A bomb is
 * therefore refused in time linear in its *source* size.
 *
 *   expanded measure  what the bridged value will have (keys are not values,
 *                     their bytes count as string bytes);
 *   expansion         expanded measure minus distinct measure: what aliases add.
 *
 * Totals are over the whole stream, because the whole stream is in memory and
 * `canon --array` emits it as one value.
 *
 * @param {import("./kyaml.js").Node[]} documents
 * @returns {{depth: number, nodes: number, stringBytes: number,
 *            expansionNodes: number, expansionBytes: number}}
 * @throws {ConformanceError}
 */
export function assertStreamBudgets(documents) {
  /** @type {Map<object, {height: number, nodes: number, bytes: number}>} */
  const memo = new Map();
  let distinctNodes = 0;
  let distinctBytes = 0;
  let nodes = 0;
  let bytes = 0;
  let depth = 0;
  for (const root of documents) {
    const at = { kind: "bridge", line: root.loc?.line, column: root.loc?.column };
    // Post-order over distinct nodes: [node, childrenPushed].
    /** @type {[any, boolean][]} */
    const stack = [[root, false]];
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const node = top[0];
      if (memo.has(node)) {
        stack.pop();
        continue;
      }
      const children = node.kind === "map" ? node.entries.map((entry) => entry.value)
        : node.kind === "seq" ? node.items : [];
      if (!top[1]) {
        top[1] = true;
        for (const child of children) if (!memo.has(child)) stack.push([child, false]);
        continue;
      }
      stack.pop();
      let height = 0;
      let count = 1;
      let size = node.kind === "string" ? utf8Length(String(node.value)) : 0;
      let own = size;
      if (node.kind === "map") {
        for (const entry of node.entries) {
          const keyBytes = utf8Length(String(entry.key.value));
          size += keyBytes;
          own += keyBytes;
        }
      }
      for (const child of children) {
        const measure = /** @type {{height: number, nodes: number, bytes: number}} */ (memo.get(child));
        if (measure.height > height) height = measure.height;
        count += measure.nodes;
        size += measure.bytes;
      }
      if (children.length > 0 || node.kind === "map" || node.kind === "seq") height += 1;
      // Saturate: a value past any limit is refused anyway, and saturating
      // keeps 9^k-style bombs from leaving the exact range of doubles.
      memo.set(node, {
        height,
        nodes: Math.min(count, Number.MAX_SAFE_INTEGER),
        bytes: Math.min(size, Number.MAX_SAFE_INTEGER),
      });
      distinctNodes += 1;
      distinctBytes += own;
    }
    const measure = /** @type {{height: number, nodes: number, bytes: number}} */ (memo.get(root));
    if (measure.height > MAX_DEPTH) throw budgetError("depth", budgetMessage.depth(measure.height), at);
    if (measure.height > depth) depth = measure.height;
    nodes += measure.nodes;
    bytes += measure.bytes;
    // A document root that is an alias of another document's anchor cannot
    // occur (anchors are per document), so the distinct counts stay exact.
    if (nodes - distinctNodes > MAX_EXPANSION_NODES) {
      throw budgetError("expansion", budgetMessage.expansionNodes(), at);
    }
    if (bytes - distinctBytes > MAX_EXPANSION_BYTES) {
      throw budgetError("expansion", budgetMessage.expansionBytes(), at);
    }
    if (nodes > MAX_NODES) throw budgetError("nodes", budgetMessage.nodes(), at);
    if (bytes > MAX_STRING_BYTES) throw budgetError("stringBytes", budgetMessage.stringBytes(), at);
  }
  return {
    depth,
    nodes,
    stringBytes: bytes,
    expansionNodes: nodes - distinctNodes,
    expansionBytes: bytes - distinctBytes,
  };
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
      if (isUnsafeIntegerFloat(value)) {
        throw new ConformanceError({
          code: "UNSAFE_FLOAT_INTEGER",
          kind: "bridge",
          message: unsafeFloatDetail(node.raw, value),
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
 * Convert one document with the value budgets enforced.
 *
 * `bridgeNode` alone is the recursive converter and would let an alias bomb
 * through; the CLI uses `bridgeDocuments`, which budgets the whole stream.
 *
 * @param {import("./kyaml.js").Node} node
 * @returns {unknown}
 * @throws {ConformanceError}
 */
export function bridgeDocument(node) {
  assertStreamBudgets([node]);
  return bridgeNode(node, "");
}

/**
 * Convert every document of a stream, with the budgets enforced on the stream
 * as a whole (before any value is built). Returns one value per document.
 *
 * @param {import("./kyaml.js").Node[]} documents
 * @returns {unknown[]}
 * @throws {ConformanceError}
 */
export function bridgeDocuments(documents) {
  assertStreamBudgets(documents);
  return documents.map((document) => bridgeNode(document, ""));
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
  assertStreamBudgets(documents);
  if (documents.length === 1) return bridgeNode(documents[0], "");
  // The array adds one level and one node; toJcs re-checks the final value, so
  // a stream at the limit is refused there rather than emitted.
  return documents.map((document, index) => bridgeNode(document, joinPath("", String(index))));
}
