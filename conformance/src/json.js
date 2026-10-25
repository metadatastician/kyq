// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell (hyperpolymath) <j.d.a.jewell@open.ac.uk>
//
// Strict I-JSON front end: the text reader `hyperpolymath/ijson-jcs` implements
// in `src/strict.rs` + `src/ijson.rs`, re-derived from the RFCs rather than from
// that implementation.
//
// Two things must be decided *from the text*, because a parsed value has already
// lost them (the caveat in the ijson-jcs README):
//
//   1. a repeated object key (RFC 7493 §2.3) — `serde_json` keeps the last one;
//   2. an integer token outside ±(2^53−1) — beyond `i64`/`u64` it silently
//      becomes a double.
//
// Numbers therefore keep their representation (`JNumber`): an integer token and
// a float token with the same mathematical value are not interchangeable in
// I-JSON validation, and the canonical form must agree with `ijson-jcs` for
// both.

import { ConformanceError, joinPath } from "./errors.js";
import { assertIJsonString, decodeUtf8 } from "./utf8.js";

/** Largest integer exactly representable in IEEE-754 binary64: 2^53 − 1. */
export const SAFE_INT_MAX = 9007199254740991n;
/** Most negative safe integer: −(2^53 − 1). */
export const SAFE_INT_MIN = -9007199254740991n;

/**
 * A JSON number that remembers which grammar production produced it.
 *
 * `serde_json::Number` distinguishes an `i64`/`u64` from an `f64`; `ijson-jcs`
 * validation depends on that distinction (a float token such as `1e18` is
 * allowed even though its value is outside the safe-integer range, while the
 * integer token `1000000000000000000` is refused). Canonical output collapses
 * both to the ECMAScript number-to-string form.
 */
export class JNumber {
  /**
   * @param {number} value      The IEEE-754 double value of the token.
   * @param {boolean} isInteger True for an integer token (no `.`, `e` or `E`).
   * @param {string} [token]    The token as written, for diagnostics.
   */
  constructor(value, isInteger, token = String(value)) {
    /** @type {number} */
    this.value = value;
    /** @type {boolean} */
    this.isInteger = isInteger;
    /** @type {string} */
    this.token = token;
  }
}

/**
 * Position of the last consumed character, in the 1-based `serde_json` sense.
 *
 * The reader's `column` points at the next character, so an error raised while
 * that character is still pending belongs at `column - 1`. At the very start of
 * the input `serde_json` reports column 0.
 *
 * @param {number} line
 * @param {number} column
 * @returns {{line: number, column: number}}
 */
function lastConsumed(line, column) {
  return { line, column: Math.max(0, column - 1) };
}

/**
 * Build the JSON parse-error message shape `ijson-jcs` prints.
 *
 * @param {string} detail  e.g. `trailing characters`
 * @param {number} line
 * @param {number} column
 * @returns {string}
 */
function parseMessage(detail, line, column) {
  return `JSON parse error: ${detail} at line ${line} column ${column}`;
}

/**
 * Build an I-JSON validation-error message, including the path when non-empty.
 *
 * `ijson-jcs`'s CLI renders validation errors as
 * `I-JSON validation error: <detail> (at <path>)`, so the gate does too.
 *
 * @param {string} detail
 * @param {string} path
 * @returns {string}
 */
function validationMessage(detail, path) {
  const suffix = path === "" ? "" : ` (at ${path})`;
  return `I-JSON validation error: ${detail}${suffix}`;
}

/**
 * Number scanner/parser over one JSON text.
 *
 * Kept as a closure-free class so error positions stay exact: every advance
 * updates `line`/`column`, and every diagnostic is raised at the position that
 * caused it.
 */
class JsonReader {
  /**
   * @param {string} text  Decoded UTF-8 JSON text.
   */
  constructor(text) {
    /** @type {string} */
    this.text = text;
    /** @type {number} */
    this.index = 0;
    /** @type {number} 1-based. */
    this.line = 1;
    /** @type {number} 1-based. */
    this.column = 1;
  }

  /** @returns {boolean} True at end of input. */
  get eof() {
    return this.index >= this.text.length;
  }

  /**
   * The current character without consuming it.
   *
   * @returns {string} One UTF-16 code unit, or `""` at EOF.
   */
  peek() {
    return this.text[this.index] ?? "";
  }

  /**
   * Advance one UTF-16 code unit, maintaining line/column.
   *
   * @returns {string} The consumed code unit (empty string at EOF).
   */
  next() {
    if (this.eof) return "";
    const char = this.text[this.index];
    this.index += 1;
    if (char === "\n") {
      this.line += 1;
      this.column = 1;
    } else {
      this.column += 1;
    }
    return char;
  }

  /**
   * Skip the four JSON whitespace characters.
   *
   * @returns {void}
   */
  skipWhitespace() {
    while (!this.eof) {
      const char = this.peek();
      if (char === " " || char === "\t" || char === "\n" || char === "\r") {
        this.next();
      } else {
        return;
      }
    }
  }

  /**
   * Raise an EOF parse error at the position of the last consumed character.
   *
   * `serde_json` reports where the input stopped, not where the reader is
   * waiting, so an empty document reports column 0 and `[` reports column 1.
   *
   * @param {string} detail
   * @returns {never}
   */
  failEof(detail) {
    this.fail(detail, lastConsumed(this.line, this.column));
  }

  /**
   * Raise a parse error at the current position.
   *
   * @param {string} detail
   * @param {{line?: number, column?: number}} [at]
   * @returns {never}
   */
  fail(detail, at) {
    throw new ConformanceError({
      code: "JSON_PARSE_ERROR",
      kind: "json",
      message: parseMessage(
        detail,
        at?.line ?? this.line,
        at?.column ?? this.column,
      ),
      line: at?.line ?? this.line,
      column: at?.column ?? this.column,
    });
  }

  /**
   * Parse one complete JSON value and assert that nothing follows it.
   *
   * @returns {unknown}
   */
  parseDocument() {
    this.skipWhitespace();
    if (this.eof) this.failEof("EOF while parsing a value");
    const value = this.parseValue("");
    this.skipWhitespace();
    if (!this.eof) this.fail("trailing characters");
    return value;
  }

  /**
   * Parse a value at `path`.
   *
   * @param {string} path
   * @returns {unknown}
   */
  parseValue(path) {
    this.skipWhitespace();
    if (this.eof) this.failEof("EOF while parsing a value");
    const char = this.peek();
    if (char === "{") return this.parseObject(path);
    if (char === "[") return this.parseArray(path);
    if (char === '"') return this.parseString(path);
    if (char === "t") return this.parseKeyword("true", true);
    if (char === "f") return this.parseKeyword("false", false);
    if (char === "n") return this.parseKeyword("null", null);
    if (char === "-" || (char >= "0" && char <= "9")) {
      return this.parseNumber(path);
    }
    this.fail("expected value");
  }

  /**
   * Parse `true`, `false` or `null`.
   *
   * @param {string} word
   * @param {boolean|null} value
   * @returns {boolean|null}
   */
  parseKeyword(word, value) {
    for (const expected of word) {
      const actual = this.next();
      if (actual !== expected) {
        this.fail("expected ident");
      }
    }
    return value;
  }

  /**
   * Parse an object, rejecting repeated keys.
   *
   * @param {string} path
   * @returns {Map<string, unknown>}
   */
  parseObject(path) {
    this.next(); // `{`
    /** @type {Map<string, unknown>} */
    const object = new Map();
    /** @type {Map<string, {line: number, column: number}>} */
    const locations = new Map();
    this.skipWhitespace();
    if (this.peek() === "}") {
      this.next();
      return object;
    }
    for (;;) {
      this.skipWhitespace();
      if (this.peek() !== '"') {
        this.fail("key must be a string");
      }
      const keyLocation = { line: this.line, column: this.column };
      // ijson-jcs validates a key against the *object's* path, not a synthetic
      // "<key>" segment, so a noncharacter in a key reports the parent path.
      const key = this.parseString(path);
      if (object.has(key)) {
        // serde_json reports the position of the duplicate key's last character
        // and nothing else, so the line is byte-identical to the oracle's.
        this.fail(
          `duplicate object key ${JSON.stringify(key)} (forbidden by RFC 7493 §2.3)`,
          lastConsumed(this.line, this.column),
        );
      }
      object.set(key, null);
      locations.set(key, keyLocation);
      this.skipWhitespace();
      if (this.next() !== ":") this.fail("expected `:`");
      const childPath = joinPath(path, key);
      object.set(key, this.parseValue(childPath));
      this.skipWhitespace();
      const separator = this.next();
      if (separator === "}") return object;
      if (separator !== ",") this.fail("expected `,` or `}`");
    }
  }

  /**
   * Parse an array.
   *
   * @param {string} path
   * @returns {unknown[]}
   */
  parseArray(path) {
    this.next(); // `[`
    /** @type {unknown[]} */
    const array = [];
    this.skipWhitespace();
    if (this.peek() === "]") {
      this.next();
      return array;
    }
    for (;;) {
      const index = array.length;
      array.push(this.parseValue(joinPath(path, String(index))));
      this.skipWhitespace();
      const separator = this.next();
      if (separator === "]") return array;
      if (separator !== ",") this.fail("expected `,` or `]`");
    }
  }

  /**
   * Parse a JSON string literal, validating escapes and Unicode safety.
   *
   * @param {string} path  Pointer path, for noncharacter diagnostics.
   * @returns {string}
   */
  parseString(path) {
    const start = { line: this.line, column: this.column };
    this.next(); // opening quote
    let out = "";
    for (;;) {
      if (this.eof) this.fail("EOF while parsing a string", start);
      const char = this.next();
      if (char === '"') break;
      if (char === "\\") {
        out += this.parseEscape(path);
        continue;
      }
      const codePoint = char.codePointAt(0);
      if (codePoint < 0x20) {
        this.fail(
          `control character (\\u${codePoint.toString(16).toUpperCase().padStart(4, "0")}) found while parsing a string`,
        );
      }
      out += char;
    }
    this.assertString(out, path, start);
    return out;
  }

  /**
   * Decode one escape sequence (the backslash is already consumed).
   *
   * @param {string} path
   * @returns {string}
   */
  parseEscape(path) {
    const escape = this.next();
    switch (escape) {
      case '"':
        return '"';
      case "\\":
        return "\\";
      case "/":
        return "/";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "u":
        return this.parseUnicodeEscape(path);
      default:
        this.fail(`invalid escape sequence \\${escape}`);
    }
  }

  /**
   * Decode a `\uXXXX` escape, pairing surrogates and refusing lone halves.
   *
   * @param {string} path
   * @returns {string}
   */
  parseUnicodeEscape(path) {
    const unit = this.readHex4();
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (this.peek() !== "\\" || this.text[this.index + 1] !== "u") {
        this.fail("lone leading surrogate in hex escape");
      }
      this.next(); // backslash
      this.next(); // u
      const low = this.readHex4();
      if (low < 0xdc00 || low > 0xdfff) {
        this.fail("lone leading surrogate in hex escape");
      }
      return String.fromCodePoint(
        0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00),
      );
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      this.fail("lone trailing surrogate in hex escape");
    }
    return String.fromCharCode(unit);
  }

  /**
   * Read exactly four hexadecimal digits.
   *
   * @returns {number}
   */
  readHex4() {
    let value = 0;
    for (let i = 0; i < 4; i += 1) {
      const char = this.next();
      const digit = Number.parseInt(char, 16);
      if (!/^[0-9a-fA-F]$/.test(char)) {
        this.fail("invalid hex escape");
      }
      value = value * 16 + digit;
    }
    return value;
  }

  /**
   * Validate a decoded string against the I-JSON string rules.
   *
   * @param {string} value
   * @param {string} path
   * @param {{line: number, column: number}} at
   * @returns {void}
   */
  assertString(value, path, at) {
    try {
      assertIJsonString(value, path, "json", at);
    } catch (error) {
      if (error instanceof ConformanceError) {
        throw new ConformanceError({
          code: error.code,
          kind: "json",
          message: validationMessage(error.message, path),
          line: at.line,
          column: at.column,
          path,
        });
      }
      throw error;
    }
  }

  /**
   * Parse a JSON number, enforcing the I-JSON number rules from the token.
   *
   * @param {string} path
   * @returns {JNumber}
   */
  parseNumber(path) {
    const start = { line: this.line, column: this.column };
    const startIndex = this.index;
    if (this.peek() === "-") this.next();
    if (this.peek() === "0") {
      this.next();
    } else if (this.peek() >= "1" && this.peek() <= "9") {
      while (this.peek() >= "0" && this.peek() <= "9") this.next();
    } else {
      this.fail("invalid number");
    }
    let isInteger = true;
    if (this.peek() === ".") {
      isInteger = false;
      this.next();
      if (!(this.peek() >= "0" && this.peek() <= "9")) {
        this.fail("invalid number: expected digit after `.`");
      }
      while (this.peek() >= "0" && this.peek() <= "9") this.next();
    }
    if (this.peek() === "e" || this.peek() === "E") {
      isInteger = false;
      this.next();
      if (this.peek() === "+" || this.peek() === "-") this.next();
      if (!(this.peek() >= "0" && this.peek() <= "9")) {
        this.fail("invalid number: expected digit in exponent");
      }
      while (this.peek() >= "0" && this.peek() <= "9") this.next();
    }
    const token = this.text.slice(startIndex, this.index);
    const value = Number(token);
    if (isInteger) {
      const magnitude = BigInt(token.startsWith("-") ? token.slice(1) : token);
      if (magnitude > SAFE_INT_MAX) {
        throw new ConformanceError({
          code: "UNSAFE_INTEGER",
          kind: "json",
          message: validationMessage(
            `Number outside safe integer range: ${token} (must be in [-(2^53)+1, (2^53)-1] for exact IEEE-754 binary64 representation)`,
            path,
          ),
          line: start.line,
          column: start.column,
          path,
        });
      }
      return new JNumber(value, true, token);
    }
    if (!Number.isFinite(value)) {
      this.fail("number out of range", start);
    }
    return new JNumber(value, false, token);
  }
}

/**
 * Parse and validate one JSON text as strict I-JSON.
 *
 * @param {string} text  Decoded UTF-8 JSON text.
 * @returns {unknown} The parsed value (`Map` for objects, `JNumber` for numbers).
 * @throws {ConformanceError}
 */
export function parseIJsonText(text) {
  const reader = new JsonReader(text);
  return reader.parseDocument();
}

/**
 * Parse and validate one JSON byte string as strict I-JSON.
 *
 * @param {Uint8Array} bytes
 * @returns {unknown}
 * @throws {ConformanceError} `INVALID_UTF8` or a JSON/I-JSON diagnostic.
 */
export function parseIJson(bytes) {
  return parseIJsonText(decodeUtf8(bytes, "json"));
}

/**
 * Validate an already-built value against the checks a `Value` can still show.
 *
 * Mirrors `ijson_jcs::validate_i_json`: strings, surrogate/noncharacter
 * freedom, safe integers for integer representations, finiteness for floats.
 * Duplicate keys cannot appear in a `Map`, which is the same reason the text
 * reader owns that check.
 *
 * @param {unknown} value
 * @param {string} [path]
 * @returns {void}
 * @throws {ConformanceError}
 */
export function validateValue(value, path = "") {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    try {
      assertIJsonString(value, path, "json");
    } catch (error) {
      if (error instanceof ConformanceError) {
        throw new ConformanceError({
          code: error.code,
          kind: "json",
          message: validationMessage(error.message, path),
          path,
        });
      }
      throw error;
    }
    return;
  }
  if (value instanceof JNumber) {
    if (value.isInteger) {
      if (!Number.isSafeInteger(value.value)) {
        throw new ConformanceError({
          code: "UNSAFE_INTEGER",
          kind: "json",
          message: validationMessage(
            `Number outside safe integer range: ${value.token} (must be in [-(2^53)+1, (2^53)-1] for exact IEEE-754 binary64 representation)`,
            path,
          ),
          path,
        });
      }
      return;
    }
    if (!Number.isFinite(value.value)) {
      throw new ConformanceError({
        code: "NON_FINITE_NUMBER",
        kind: "json",
        message: validationMessage(`Non-finite number: ${value.token}`, path),
        path,
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      validateValue(item, joinPath(path, String(index)));
    });
    return;
  }
  if (value instanceof Map) {
    for (const [key, item] of value) {
      try {
        assertIJsonString(key, path, "json");
      } catch (error) {
        if (error instanceof ConformanceError) {
          throw new ConformanceError({
            code: error.code,
            kind: "json",
            message: validationMessage(error.message, path),
            path,
          });
        }
        throw error;
      }
      validateValue(item, joinPath(path, key));
    }
    return;
  }
  throw new ConformanceError({
    code: "INTERNAL_VALUE_TYPE",
    kind: "json",
    message: `value of unsupported type ${typeof value} cannot be validated`,
    path,
  });
}
