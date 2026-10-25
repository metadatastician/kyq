// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell (hyperpolymath) <j.d.a.jewell@open.ac.uk>
//
// Typed diagnostics for the KYAML / I-JSON / JCS conformance gate.
//
// Every failure this gate reports is a `ConformanceError`: a machine-readable
// `code`, an optional source location (`line`, `column`, both 1-based), an
// optional JSON-Pointer-style `path`, and a human `message`. The CLI renders
// the same object either as text (`INVALID <file>: <reason>`) or as one JSON
// object per file (`--report json`), so a consumer CI can assert on the code
// and location instead of matching prose.

/**
 * A diagnostic raised by the gate.
 *
 * `kind` separates the three contracts that can fail:
 *   - `"json"`  — the text is not valid/valid-I-JSON (RFC 7493).
 *   - `"jcs"`   — the value cannot be canonicalised (RFC 8785).
 *   - `"kyaml"` — the text is not in the KYAML subset (`docs/KYAML_SPEC.adoc`).
 *   - `"bridge"`— KYAML data that has no lossless JSON image.
 */
export class ConformanceError extends Error {
  /**
   * @param {object} spec
   * @param {string} spec.code      Stable diagnostic code, e.g. `DUPLICATE_KEY`.
   * @param {string} spec.message   One-line human explanation.
   * @param {string} [spec.kind]    `json` | `jcs` | `kyaml` | `bridge`.
   * @param {number} [spec.line]    1-based source line.
   * @param {number} [spec.column]  1-based source column.
   * @param {string} [spec.path]    JSON Pointer path of the offending value.
   */
  constructor({ code, message, kind = "kyaml", line, column, path }) {
    super(message);
    /** @type {string} */
    this.name = "ConformanceError";
    /** @type {string} */
    this.code = code;
    /** @type {string} */
    this.kind = kind;
    /** @type {number|undefined} */
    this.line = line;
    /** @type {number|undefined} */
    this.column = column;
    /** @type {string|undefined} */
    this.path = path;
  }

  /** @returns {boolean} True when the error carries a source location. */
  get located() {
    return Number.isInteger(this.line) && Number.isInteger(this.column);
  }

  /**
   * The rendered reason used in `INVALID <file>: <reason>` lines.
   *
   * JSON mode deliberately renders the reason *without* the code prefix so the
   * line matches `ijson-jcs check` byte-for-byte for the same input; KYAML and
   * bridge diagnostics lead with the code and end with the location so a
   * source-located failure is never ambiguous.
   *
   * @returns {string}
   */
  get reason() {
    if (this.kind === "json") return this.message;
    const parts = [`${this.code}: ${this.message}`];
    if (this.located) parts.push(`(line ${this.line}, column ${this.column})`);
    if (this.path) parts.push(`(path ${this.path})`);
    return parts.join(" ");
  }

  /**
   * The diagnostic as a JSON-serialisable object (the `--report json` shape).
   *
   * @returns {{code: string, kind: string, message: string, reason: string,
   *            line: number|null, column: number|null, path: string|null}}
   */
  toJSON() {
    return {
      code: this.code,
      kind: this.kind,
      message: this.message,
      reason: this.reason,
      line: this.located ? this.line : null,
      column: this.located ? this.column : null,
      path: this.path ?? null,
    };
  }
}

/**
 * Encode one JSON Pointer reference token (RFC 6901): `~` -> `~0`, `/` -> `~1`.
 *
 * The gate uses the pointer body without a leading slash, matching the path
 * format `hyperpolymath/ijson-jcs` reports (`a/1/b~0~1c`).
 *
 * @param {string} token
 * @returns {string}
 */
export function encodePointerToken(token) {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

/**
 * Join a parent path and one token into a `/`-separated pointer body.
 *
 * @param {string} parent  Existing path (`""` at the document root).
 * @param {string} token   Raw (unencoded) reference token.
 * @returns {string}
 */
export function joinPath(parent, token) {
  const encoded = encodePointerToken(token);
  return parent === "" ? encoded : `${parent}/${encoded}`;
}

/**
 * Render a code point for a diagnostic (`U+00FF`, uppercase, at least 4 digits).
 *
 * @param {number} codePoint
 * @returns {string}
 */
export function formatCodePoint(codePoint) {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}
