// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell (hyperpolymath) <j.d.a.jewell@open.ac.uk>
//
// UTF-8 decoding and Unicode safety checks shared by the JSON and KYAML front
// ends. These are the I-JSON MUSTs from RFC 7493 §2.1 as `hyperpolymath/
// ijson-jcs` applies them: no lone surrogates, no noncharacters, and no BOM
// smuggling (a UTF-8 BOM is one code point, not three invisible bytes).

import { ConformanceError, formatCodePoint } from "./errors.js";

/** First noncharacter in the BMP block U+FDD0..U+FDEF. */
const NONCHARACTER_FDD0 = 0xfdd0;
/** Last code point of the U+FDD0..U+FDEF block. */
const NONCHARACTER_FDEF = 0xfdef;
/** Largest legal Unicode scalar value. */
const MAX_CODE_POINT = 0x10ffff;
/** Byte order mark, legal only (optionally) at the start of a KYAML stream. */
export const BOM = 0xfeff;

/**
 * Whether `codePoint` is a Unicode noncharacter (RFC 7493 §2.1 / `ijson-jcs`).
 *
 * Noncharacters are U+FDD0..U+FDEF and the last two code points of every
 * plane (U+FFFE, U+FFFF, U+1FFFE, U+1FFFF, ... U+10FFFF).
 *
 * @param {number} codePoint
 * @returns {boolean}
 */
export function isNoncharacter(codePoint) {
  if (codePoint >= NONCHARACTER_FDD0 && codePoint <= NONCHARACTER_FDEF) {
    return true;
  }
  if (codePoint <= MAX_CODE_POINT && (codePoint & 0xffff) >= 0xfffe) {
    return true;
  }
  return false;
}

/**
 * Whether `codePoint` is a UTF-16 surrogate code unit (U+D800..U+DFFF).
 *
 * @param {number} codePoint
 * @returns {boolean}
 */
export function isSurrogate(codePoint) {
  return codePoint >= 0xd800 && codePoint <= 0xdfff;
}

/**
 * Decode bytes as strict UTF-8.
 *
 * A BOM is *kept* as U+FEFF rather than stripped, so each front end decides
 * what to do with it: the JSON reader rejects it (as `serde_json` does) and the
 * KYAML reader accepts exactly one at the start of the stream.
 *
 * @param {Uint8Array} bytes
 * @param {"json"|"kyaml"} kind  Contract that owns the error code.
 * @returns {string}
 * @throws {ConformanceError} `INVALID_UTF8` when the bytes are not UTF-8.
 */
export function decodeUtf8(bytes, kind) {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new ConformanceError({
      code: "INVALID_UTF8",
      kind,
      message: "input is not valid UTF-8",
    });
  }
}

/**
 * Validate one decoded string against the I-JSON string rules.
 *
 * Reports the first offending code point with its code-point index inside the
 * string, which is the location `ijson-jcs` prints ("U+FFFF at index 0").
 *
 * @param {string} value
 * @param {string} path   Pointer path of the string, for the diagnostic.
 * @param {"json"|"kyaml"|"bridge"} kind
 * @param {{line: number, column: number}} [loc]  Source location, KYAML only.
 * @returns {void}
 * @throws {ConformanceError} `LONE_SURROGATE` or `NONCHARACTER`.
 */
export function assertIJsonString(value, path, kind, loc) {
  let index = 0;
  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (isSurrogate(codePoint)) {
      throw new ConformanceError({
        code: "LONE_SURROGATE",
        kind,
        message: `String contains unpaired surrogate: ${formatCodePoint(codePoint)} at index ${index}`,
        path,
        ...loc,
      });
    }
    if (isNoncharacter(codePoint)) {
      throw new ConformanceError({
        code: "NONCHARACTER",
        kind,
        message: `String contains noncharacter: ${formatCodePoint(codePoint)} at index ${index}`,
        path,
        ...loc,
      });
    }
    index += 1;
  }
}
