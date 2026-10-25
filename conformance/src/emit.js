// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell (hyperpolymath) <j.d.a.jewell@open.ac.uk>
//
// Canonical KYAML formatter (`docs/KYAML_SPEC.adoc` §5).
//
// The output is a normal form, not a style preference:
//
//   * two-space indentation, block collections only, `key: value` spacing;
//   * a document stream is separated by `---` lines and ends with exactly one
//     `\n`; an empty stream formats to no bytes at all;
//   * comments, anchors, aliases and explicit tags are dropped (aliases are
//     expanded, tags have already been applied to the value), so the canonical
//     form contains neither;
//   * strings stay plain only when the plain form re-resolves to the very same
//     string, otherwise they are double-quoted with JSON-compatible escapes;
//   * numbers use the same canonical text as JCS, so a document's YAML text and
//     its canonical JSON bytes agree digit-for-digit.

import { escapeJsonString, esNumberToString } from "./jcs.js";
import { resolvePlainScalar } from "./kyaml.js";

/** Characters that may not begin a plain scalar (YAML indicators). */
const LEADING_INDICATORS = /^[-?:,[\]{}#&*!|>'"%@`]/;
/** Control characters that require a double-quoted scalar. */
const CONTROLS = /[\u0000-\u001f\u007f]/;
/**
 * YAML 1.1 boolean words.
 *
 * The Core Schema of YAML 1.2 resolves these to *strings*, but a YAML 1.1
 * reader treats them as booleans. They are quoted in canonical form so the
 * output cannot change meaning for a consumer on the older schema.
 */
const YAML_1_1_BOOLEANS = /^(?:y|Y|yes|Yes|YES|n|N|no|No|NO|on|On|ON|off|Off|OFF)$/;

/**
 * Whether a string can be written as a plain (unquoted) scalar and read back
 * unchanged.
 *
 * The check is behavioural, not a hand-written charset: the candidate is run
 * through the same core-schema resolution the parser uses, so `true`, `3`,
 * `0x10` and `~` are quoted while `3 pods` and `nginx:1.25.3` are not.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isPlainSafeString(value) {
  if (value === "") return false;
  if (value !== value.trim()) return false;
  if (CONTROLS.test(value)) return false;
  if (value.includes(" #")) return false;
  if (value.includes(": ") || value.endsWith(":")) return false;
  if (LEADING_INDICATORS.test(value)) return false;
  if (YAML_1_1_BOOLEANS.test(value)) return false;
  return resolvePlainScalar(value).type === "string";
}

/**
 * Format one string scalar (plain when safe, double-quoted otherwise).
 *
 * @param {string} value
 * @returns {string}
 */
export function formatString(value) {
  return isPlainSafeString(value) ? value : escapeJsonString(value);
}

/**
 * Format a scalar node as canonical text.
 *
 * @param {import("./kyaml.js").ScalarNode} node
 * @returns {string}
 */
export function formatScalar(node) {
  switch (node.kind) {
    case "null":
      return "null";
    case "bool":
      return node.value === true ? "true" : "false";
    case "int":
      return /** @type {bigint} */ (node.value).toString();
    case "float": {
      const value = /** @type {number} */ (node.value);
      if (!Number.isFinite(value)) {
        throw new Error(
          "the formatter only runs on bridged documents, so non-finite floats cannot reach it",
        );
      }
      return esNumberToString(value);
    }
    case "string":
      return formatString(String(node.value));
    default:
      throw new Error(`unknown scalar kind ${String(node.kind)}`);
  }
}

/**
 * Whether a node is written on its parent's line (`{}`, `[]`, or a scalar).
 *
 * @param {import("./kyaml.js").Node} node
 * @returns {boolean}
 */
function isInline(node) {
  if (node.kind === "map") return node.entries.length === 0;
  if (node.kind === "seq") return node.items.length === 0;
  return true;
}

/**
 * Render a node as an inline collection or scalar.
 *
 * @param {import("./kyaml.js").Node} node
 * @returns {string}
 */
function formatInline(node) {
  if (node.kind === "map") return "{}";
  if (node.kind === "seq") return "[]";
  return formatScalar(node);
}

/**
 * Emit a node and its children into `lines`.
 *
 * @param {import("./kyaml.js").Node} node
 * @param {number} indent
 * @param {string[]} lines
 * @returns {void}
 */
function emitNode(node, indent, lines) {
  const pad = " ".repeat(indent);
  if (node.kind === "map") {
    if (node.entries.length === 0) {
      lines.push(`${pad}{}`);
      return;
    }
    for (const entry of node.entries) {
      const key = formatString(String(entry.key.value));
      if (isInline(entry.value)) {
        lines.push(`${pad}${key}: ${formatInline(entry.value)}`);
      } else {
        lines.push(`${pad}${key}:`);
        emitNode(entry.value, indent + 2, lines);
      }
    }
    return;
  }
  if (node.kind === "seq") {
    if (node.items.length === 0) {
      lines.push(`${pad}[]`);
      return;
    }
    for (const item of node.items) {
      if (isInline(item)) {
        lines.push(`${pad}- ${formatInline(item)}`);
        continue;
      }
      /** @type {string[]} */
      const child = [];
      emitNode(item, indent + 2, child);
      // Pull the first line up onto the dash line: `- key: value`.
      child[0] = `${pad}- ${child[0].slice(indent + 2)}`;
      lines.push(...child);
    }
    return;
  }
  lines.push(`${pad}${formatScalar(node)}`);
}

/**
 * Emit one document body (no stream markers, no trailing newline).
 *
 * @param {import("./kyaml.js").Node} node
 * @returns {string}
 */
export function emitDocument(node) {
  /** @type {string[]} */
  const lines = [];
  emitNode(node, 0, lines);
  return lines.join("\n");
}

/**
 * Emit a whole stream in canonical form.
 *
 * @param {import("./kyaml.js").Node[]} documents
 * @returns {string} Canonical text; `""` for an empty stream, otherwise ending
 *   with exactly one newline.
 */
export function formatStream(documents) {
  if (documents.length === 0) return "";
  return `${documents.map(emitDocument).join("\n---\n")}\n`;
}
