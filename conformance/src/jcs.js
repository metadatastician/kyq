// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell (hyperpolymath) <j.d.a.jewell@open.ac.uk>
//
// JCS (RFC 8785) canonical serialisation.
//
// The bytes must be identical to `ijson_jcs::to_jcs` for the same logical value
// (`docs/IJSON_JCS_INTEGRATION.adoc`, Thm JCS-8). Three rules carry that:
//
//   * object keys sort by UTF-16 code-unit order — JavaScript's `<` on strings
//     *is* code-unit order, so no normalisation is applied anywhere;
//   * no insignificant whitespace, arrays keep their order, keys are quoted and
//     escaped like `serde_json` (only `"`, `\` and C0 controls are escaped;
//     `/` and every non-ASCII character stay raw);
//   * numbers serialise per ECMAScript `Number.prototype.toString`, which is
//     exactly what RFC 8785 §3.2.2.3 mandates — JavaScript's `String(n)` is the
//     normative algorithm, not an approximation of it.

import { ConformanceError } from "./errors.js";
import { JNumber, validateValue } from "./json.js";

/** Escape one string as a JSON string literal, serde_json-compatible. */
const SHORT_ESCAPES = new Map([
  ['"', '\\"'],
  ["\\", "\\\\"],
  ["\b", "\\b"],
  ["\t", "\\t"],
  ["\n", "\\n"],
  ["\f", "\\f"],
  ["\r", "\\r"],
]);

/**
 * Serialise a string exactly as `serde_json::to_string` does.
 *
 * @param {string} value
 * @returns {string} The quoted literal.
 */
export function escapeJsonString(value) {
  let out = '"';
  for (const char of value) {
    const short = SHORT_ESCAPES.get(char);
    if (short !== undefined) {
      out += short;
      continue;
    }
    const codePoint = char.codePointAt(0);
    if (codePoint < 0x20) {
      out += `\\u${codePoint.toString(16).padStart(4, "0")}`;
      continue;
    }
    out += char;
  }
  return `${out}"`;
}

/**
 * Format a finite double exactly as ECMAScript `Number.prototype.toString`.
 *
 * `-0` becomes `0`; every other value is whatever the language prints, which is
 * the algorithm RFC 8785 §3.2.2.3 adopts (`1e+30`, `4.5`, `1e-7`, `1e+21`,
 * `100000000000000000000`).
 *
 * @param {number} value
 * @returns {string}
 * @throws {ConformanceError} `NON_FINITE_NUMBER` for NaN/±Infinity.
 */
export function esNumberToString(value) {
  if (!Number.isFinite(value)) {
    throw new ConformanceError({
      code: "NON_FINITE_NUMBER",
      kind: "jcs",
      message: `Number format error: ${value}`,
    });
  }
  if (value === 0) return "0";
  return String(value);
}

/**
 * Sort object keys by UTF-16 code-unit order (RFC 8785 §3.2.3).
 *
 * `Array.prototype.sort` with a comparator on `<`/`>` compares UTF-16 code
 * units, which is why U+1F600 sorts before U+FB33 although its code point is
 * larger.
 *
 * @param {string[]} keys
 * @returns {string[]} A sorted copy.
 */
export function sortKeysUtf16(keys) {
  return [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Append the canonical form of one value.
 *
 * @param {unknown} value
 * @param {string[]} out  Accumulator of string chunks.
 * @returns {void}
 */
function writeCanonical(value, out) {
  if (value === null) {
    out.push("null");
    return;
  }
  if (value === true) {
    out.push("true");
    return;
  }
  if (value === false) {
    out.push("false");
    return;
  }
  if (typeof value === "string") {
    out.push(escapeJsonString(value));
    return;
  }
  if (value instanceof JNumber) {
    out.push(esNumberToString(value.value));
    return;
  }
  if (typeof value === "number") {
    // A bare double can only reach here from an internal caller; treat it as a
    // float so canonical output is still correct.
    out.push(esNumberToString(value));
    return;
  }
  if (Array.isArray(value)) {
    out.push("[");
    value.forEach((item, index) => {
      if (index > 0) out.push(",");
      writeCanonical(item, out);
    });
    out.push("]");
    return;
  }
  if (value instanceof Map) {
    const keys = sortKeysUtf16([...value.keys()]);
    out.push("{");
    keys.forEach((key, index) => {
      if (index > 0) out.push(",");
      out.push(escapeJsonString(key));
      out.push(":");
      writeCanonical(value.get(key), out);
    });
    out.push("}");
    return;
  }
  throw new ConformanceError({
    code: "INTERNAL_VALUE_TYPE",
    kind: "jcs",
    message: `cannot canonicalise a value of type ${typeof value}`,
  });
}

/**
 * Canonicalise a value to JCS bytes.
 *
 * Validation runs first, exactly as `ijson_jcs::to_jcs` does, so a value that
 * is not I-JSON can never be quietly emitted in canonical form.
 *
 * @param {unknown} value
 * @returns {Uint8Array}
 * @throws {ConformanceError}
 */
export function toJcs(value) {
  try {
    validateValue(value);
  } catch (error) {
    if (error instanceof ConformanceError) {
      throw new ConformanceError({
        code: error.code,
        kind: "jcs",
        message: `Cannot canonicalize non-I-JSON data: ${error.message}`,
        line: error.line,
        column: error.column,
        path: error.path,
      });
    }
    throw error;
  }
  /** @type {string[]} */
  const chunks = [];
  writeCanonical(value, chunks);
  return new TextEncoder().encode(chunks.join(""));
}

/**
 * Canonicalise a value to a JCS string.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function toJcsString(value) {
  return new TextDecoder().decode(toJcs(value));
}
