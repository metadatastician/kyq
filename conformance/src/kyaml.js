// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell (hyperpolymath) <j.d.a.jewell@open.ac.uk>
//
// KYAML parser: the block-and-flow YAML subset defined normatively in
// `docs/KYAML_SPEC.adoc` §4. It is a *subset*, and everything outside it is a
// located error rather than a silent re-interpretation:
//
//   * duplicate mapping keys are refused at parse time, on the resolved key
//     identity (`a`, `"a"` and `!!str a` are one key), with line/column and the
//     pointer path of the offending mapping;
//   * complex (`? `) keys, `%TAG` directives, `%YAML` versions other than 1.2,
//     non-core tags, multi-line plain/quoted scalars and trailing commas in flow
//     collections are refused with a specific code;
//   * anchors and aliases are resolved, alias cycles are impossible because an
//     alias may only name an already-completed node, and expansion is bounded.
//
// The AST keeps source locations on every node. Scalars carry their resolved
// core-schema type; integers are `BigInt` so the bridge can test the I-JSON
// range before any precision is lost.

import { ConformanceError, joinPath } from "./errors.js";
import { BOM, assertIJsonString, decodeUtf8 } from "./utf8.js";

/** Maximum number of nodes after alias expansion (SEC-1 / anchor bombs). */
export const NODE_BUDGET = 100000;

/**
 * @typedef {{line: number, column: number}} Loc
 *
 * @typedef {{kind: "null"|"bool"|"int"|"float"|"string", value: null|boolean|BigInt|number|string,
 *            raw: string, loc: Loc, style: string, tag?: string}} ScalarNode
 * @typedef {{kind: "map", entries: {key: ScalarNode, value: Node, loc: Loc}[], loc: Loc, tag?: string}} MapNode
 * @typedef {{kind: "seq", items: Node[], loc: Loc, tag?: string}} SeqNode
 * @typedef {ScalarNode|MapNode|SeqNode} Node
 */

/**
 * Whether a node is a scalar (the leaf kinds are the resolved types).
 *
 * @param {Node} node
 * @returns {boolean}
 */
function isScalarNode(node) {
  return node.kind !== "map" && node.kind !== "seq";
}

const CORE_TAGS = new Set([
  "!!str",
  "!!int",
  "!!float",
  "!!bool",
  "!!null",
  "!!map",
  "!!seq",
  "!",
]);

const NULL_WORDS = new Set(["null", "Null", "NULL", "~", ""]);
const TRUE_WORDS = new Set(["true", "True", "TRUE"]);
const FALSE_WORDS = new Set(["false", "False", "FALSE"]);

const DECIMAL_INT = /^[-+]?[0-9]+$/;
const OCTAL_INT = /^0o[0-7]+$/;
const HEX_INT = /^0x[0-9a-fA-F]+$/;
const FLOAT = /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/;
const INF = /^[-+]?\.(?:inf|Inf|INF)$/;
const NAN = /^\.(?:nan|NaN|NAN)$/;

const ANCHOR_NAME = /[^\s,[\]{}]+/y;
const ALIAS_NAME = /[^\s,[\]{}]+/y;

/**
 * Resolve a plain scalar with the YAML 1.2 Core Schema.
 *
 * `yes`/`no`/`on`/`off` are deliberately *strings* (YAML 1.2 Core, unlike 1.1);
 * `docs/KYAML_SPEC.adoc` §4.3 records that decision because it is the one place
 * where a YAML 1.1 habit silently changes a value.
 *
 * @param {string} text
 * @returns {{type: ScalarNode["kind"], value: ScalarNode["value"]}}
 */
export function resolvePlainScalar(text) {
  if (NULL_WORDS.has(text)) return { type: "null", value: null };
  if (TRUE_WORDS.has(text)) return { type: "bool", value: true };
  if (FALSE_WORDS.has(text)) return { type: "bool", value: false };
  if (DECIMAL_INT.test(text)) {
    return { type: "int", value: BigInt(text.replace(/^\+/, "")) };
  }
  if (OCTAL_INT.test(text) || HEX_INT.test(text)) {
    return { type: "int", value: BigInt(text) };
  }
  if (FLOAT.test(text) && text !== "") {
    return { type: "float", value: Number(text) };
  }
  if (INF.test(text)) {
    return { type: "float", value: text.startsWith("-") ? -Infinity : Infinity };
  }
  if (NAN.test(text)) return { type: "float", value: Number.NaN };
  return { type: "string", value: text };
}

/**
 * The identity used for duplicate-key detection.
 *
 * Keys are compared after resolution, so `a:`, `"a":` and `!!str a:` collide,
 * while the integer key `1` and the string key `"1"` stay distinct here and are
 * rejected separately by the JSON bridge (`NON_STRING_KEY`).
 *
 * @param {ScalarNode} key
 * @returns {string}
 */
export function keyIdentity(key) {
  switch (key.kind) {
    case "int":
      return `int:${key.value.toString()}`;
    case "float":
      return `float:${Number.isNaN(key.value) ? "nan" : String(key.value)}`;
    case "bool":
      return `bool:${key.value}`;
    case "null":
      return "null:";
    default:
      return `str:${key.value}`;
  }
}

/**
 * Scan one KYAML stream.
 *
 * Owns the cursor (`i`/`line`/`column`), the anchor table and the diagnostics.
 * All block parsing is indentation-driven; flow parsing ignores indentation but
 * still tracks line/column for errors.
 */
export class KyamlParser {
  /**
   * @param {string} text      Decoded UTF-8 stream (a leading BOM is allowed).
   * @param {string} [source]  File name used in diagnostics (informational).
   */
  constructor(text, source) {
    /** @type {string} */
    this.source = source ?? "<input>";
    // YAML line breaks are LF, CRLF and CR. Normalise the first two; a lone CR
    // is refused rather than guessed at.
    this.text = text;
    /** @type {number} */
    this.i = 0;
    /** @type {number} 1-based line. */
    this.line = 1;
    /** @type {number} 1-based column. */
    this.column = 1;
    /** @type {boolean} True when the cursor sits on the first non-space of a content line. */
    this.atContent = false;
    /** @type {Map<string, Node>} */
    this.anchors = new Map();
    /** @type {string[]} */
    this.tags = [];
  }

  /**
   * Parse the whole stream.
   *
   * @returns {Node[]} One node per document; an empty stream yields `[]`.
   * @throws {ConformanceError}
   */
  parseStream() {
    this.normaliseNewlines();
    if (this.text.startsWith("\uFEFF")) {
      // A single leading BOM is legal and does not move the first column.
      this.i = 1;
    }
    if (this.text.includes("\uFEFF")) {
      const at = this.text.indexOf("\uFEFF", 1);
      const loc = this.locationOf(at);
      throw this.error(
        "BOM_MIDSTREAM",
        "a byte order mark is only allowed at the start of a stream",
        loc,
      );
    }

    /** @type {Node[]} */
    const documents = [];
    let sawDirective = false;
    this.skipGap();

    while (!this.eof) {
      if (this.atDirective()) {
        if (documents.length > 0) {
          throw this.error(
            "UNSUPPORTED_DIRECTIVE",
            "a directive is only allowed before the first document",
            this.loc(),
          );
        }
        this.parseDirective();
        sawDirective = true;
        this.skipGap();
        continue;
      }
      if (this.atMarker("...")) {
        this.consumeMarker();
        this.skipGap();
        continue;
      }
      if (this.atMarker("---")) {
        this.consumeMarker();
        sawDirective = false;
        this.skipGap();
        if (this.eof) {
          // A final `---` with no content produces an empty document; YAML
          // makes it `null`, but a trailing empty document is dropped (spec §4.1).
          break;
        }
        if (this.atMarker("---") || this.atMarker("...")) {
          documents.push(this.nullNode(this.loc()));
          continue;
        }
        documents.push(this.parseContentDocument());
        continue;
      }
      if (sawDirective) {
        throw this.error(
          "MISSING_DOC_START",
          "a `---` document start marker is required after a directive",
          this.loc(),
        );
      }
      if (documents.length > 0) {
        throw this.error(
          "MISSING_DOC_MARKER",
          "a second document must start with `---`",
          this.loc(),
        );
      }
      documents.push(this.parseContentDocument());
    }

    return documents;
  }

  // ── cursor primitives ────────────────────────────────────────────────────

  /** @returns {boolean} True at end of input. */
  get eof() {
    return this.i >= this.text.length;
  }

  /**
   * The current character.
   *
   * @param {number} [offset=0]
   * @returns {string} One UTF-16 code unit, or `""` past EOF.
   */
  peek(offset = 0) {
    return this.text[this.i + offset] ?? "";
  }

  /**
   * The current location.
   *
   * @returns {Loc}
   */
  loc() {
    return { line: this.line, column: this.column };
  }

  /**
   * Location of an absolute offset (used only for whole-input checks).
   *
   * @param {number} offset
   * @returns {Loc}
   */
  locationOf(offset) {
    let line = 1;
    let column = 1;
    for (let index = 0; index < offset; index += 1) {
      if (this.text[index] === "\n") {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
    }
    return { line, column };
  }

  /**
   * Consume one code point, maintaining line/column.
   *
   * @returns {string}
   */
  bump() {
    if (this.eof) return "";
    const char = String.fromCodePoint(this.text.codePointAt(this.i));
    this.i += char.length;
    this.column += 1;
    if (char === "\n") {
      this.line += 1;
      this.column = 1;
    }
    this.atContent = false;
    return char;
  }

  /**
   * Move the cursor back to a saved line start.
   *
   * @param {{i: number, line: number}} saved
   * @returns {void}
   */
  rewind(saved) {
    this.i = saved.i;
    this.line = saved.line;
    this.column = 1;
    this.atContent = false;
  }

  /**
   * Build a located diagnostic.
   *
   * @param {string} code
   * @param {string} message
   * @param {Loc} [at]
   * @param {string} [path]
   * @returns {ConformanceError}
   */
  error(code, message, at, path) {
    return new ConformanceError({
      code,
      kind: "kyaml",
      message,
      line: (at ?? this.loc()).line,
      column: (at ?? this.loc()).column,
      path,
    });
  }

  /**
   * Normalise CRLF to LF and refuse a lone CR.
   *
   * @returns {void}
   */
  normaliseNewlines() {
    if (!this.text.includes("\r")) return;
    const loneCr = /(^|[^\r])\r(?!\n)/.exec(this.text);
    if (loneCr) {
      const offset = loneCr.index + loneCr[1].length;
      throw this.error(
        "INVALID_NEWLINE",
        "a bare CR line break is outside the KYAML subset; use LF or CRLF",
        this.locationOf(offset),
      );
    }
    this.text = this.text.replaceAll("\r\n", "\n");
  }

  /**
   * Skip indentation, comments, blank lines and trailing whitespace.
   *
   * Idempotent: when the cursor already sits on a content character it returns
   * immediately, so callers may safely re-enter it.
   *
   * @returns {void}
   */
  skipGap() {
    for (;;) {
      if (this.eof) {
        this.atContent = false;
        return;
      }
      if (this.atContent) return;
      if (this.column === 1) {
        while (this.peek() === " ") this.bump();
        if (this.peek() === "\t") {
          throw this.error(
            "TAB_INDENT",
            "a tab may not be used as indentation; use spaces",
          );
        }
        if (this.eof) {
          this.atContent = false;
          return;
        }
        if (this.peek() === "\n") {
          this.bump();
          continue;
        }
        if (this.peek() === "#") {
          this.skipToEndOfLine();
          continue;
        }
        this.atContent = true;
        return;
      }
      const char = this.peek();
      if (char === " " || char === "\t") {
        this.bump();
        continue;
      }
      if (char === "#") {
        this.skipToEndOfLine();
        continue;
      }
      if (char === "\n") {
        this.bump();
        continue;
      }
      throw this.error(
        "TRAILING_CONTENT",
        `unexpected content ${JSON.stringify(char)} after a node; only a comment may follow`,
      );
    }
  }

  /**
   * Consume to (and including) the next line break.
   *
   * @returns {void}
   */
  skipToEndOfLine() {
    while (!this.eof && this.peek() !== "\n") this.bump();
    if (!this.eof) this.bump();
    this.atContent = false;
  }

  /**
   * Consume trailing spaces and an optional comment, then require end of line.
   *
   * @returns {void}
   */
  expectEndOfLine() {
    while (this.peek() === " " || this.peek() === "\t") this.bump();
    if (this.peek() === "#") {
      this.skipToEndOfLine();
      return;
    }
    if (this.eof || this.peek() === "\n") return;
    throw this.error(
      "TRAILING_CONTENT",
      `unexpected content ${JSON.stringify(this.peek())} after a node`,
    );
  }

  /**
   * Whether the cursor is on a stream marker (`---` or `...`) at column 1.
   *
   * @param {"---"|"..."} [marker]
   * @returns {boolean}
   */
  atMarker(marker) {
    if (this.column !== 1) return false;
    return this.markerAt(this.i, marker);
  }

  /**
   * Whether an absolute offset begins a stream marker line.
   *
   * @param {number} index
   * @param {"---"|"..."} [marker]
   * @returns {boolean}
   */
  markerAt(index, marker) {
    const text = this.text.slice(index, index + 3);
    if (!/^[.-]{3}$/.test(text)) return false;
    if (marker !== undefined && text !== marker) return false;
    const after = this.text[index + 3] ?? "";
    return after === "" || after === " " || after === "\t" || after === "\n" || after === "#";
  }

  /**
   * Consume a `---` / `...` marker line.
   *
   * @returns {void}
   */
  consumeMarker() {
    const marker = this.text.slice(this.i, this.i + 3);
    for (let count = 0; count < 3; count += 1) this.bump();
    while (this.peek() === " " || this.peek() === "\t") this.bump();
    if (this.peek() === "#") {
      this.skipToEndOfLine();
      return;
    }
    if (!this.eof && this.peek() !== "\n") {
      throw this.error(
        "DOC_MARKER_CONTENT",
        `content on the same line as the \`${marker}\` marker is outside the KYAML subset; put it on the next line`,
      );
    }
  }

  /**
   * Whether the cursor starts a `%` directive line.
   *
   * @returns {boolean}
   */
  atDirective() {
    return this.column === 1 && this.peek() === "%";
  }

  /**
   * Parse one `%YAML` directive; every other directive is refused.
   *
   * @returns {void}
   */
  parseDirective() {
    const loc = this.loc();
    let line = "";
    while (!this.eof && this.peek() !== "\n") {
      line += this.bump();
    }
    const [name, ...args] = line.trim().split(/\s+/);
    if (name === "%YAML") {
      if (args.length !== 1 || args[0] !== "1.2") {
        throw this.error(
          "UNSUPPORTED_VERSION",
          `only \`%YAML 1.2\` is supported, got \`${line.trim()}\``,
          loc,
        );
      }
      return;
    }
    throw this.error(
      "UNSUPPORTED_DIRECTIVE",
      `directive \`${name}\` is outside the KYAML subset`,
      loc,
    );
  }

  // ── block structure ──────────────────────────────────────────────────────

  /**
   * Parse one document body starting at the current content line.
   *
   * @returns {Node}
   */
  parseContentDocument() {
    const indent = this.column - 1;
    const node = this.parseBlock(indent, "");
    this.skipGap();
    if (!this.eof && !this.atMarker("---") && !this.atMarker("...")) {
      throw this.error(
        "UNEXPECTED_CONTENT",
        "unexpected content after the document root; multi-line plain scalars are outside the KYAML subset (quote the value or use a block scalar)",
      );
    }
    return node;
  }

  /**
   * Parse the block node at `indent`.
   *
   * @param {number} indent  Expected indentation of sibling entries.
   * @param {string} path    Pointer path of this node.
   * @returns {Node}
   */
  parseBlock(indent, path, lineIndent = indent) {
    if (this.eof) return this.nullNode(this.loc());
    if (this.isSeqEntry()) return this.parseSeq(indent, path);
    if (this.isMapEntry()) return this.parseMap(indent, path);
    return this.parseInlineNode(indent, path, "root", lineIndent);
  }

  /**
   * Whether the cursor is on a block sequence entry (`-` + space/EOL).
   *
   * @returns {boolean}
   */
  isSeqEntry() {
    if (this.peek() !== "-") return false;
    const after = this.peek(1);
    return after === "" || after === " " || after === "\t" || after === "\n";
  }

  /**
   * Whether the cursor starts a block mapping entry, and where its key ends.
   *
   * Handles plain keys (terminated by `: ` / `:` + EOL) and quoted keys.
   *
   * @returns {boolean}
   */
  isMapEntry() {
    // A line opening with a flow indicator, anchor, alias, tag or block scalar
    // indicator is a node, not a `key:` entry — scanning it for a colon would
    // find one inside the flow collection or the quoted scalar.
    if ("{[&*!|>".includes(this.peek())) return false;
    if (this.peek() === "?" && /[ \t\n]/.test(this.peek(1) || "\n")) {
      throw this.error(
        "UNSUPPORTED_COMPLEX_KEY",
        "complex mapping keys (`? `) are outside the KYAML subset",
      );
    }
    const quote = this.peek();
    if (quote === "'" || quote === '"') {
      const end = this.findClosingQuote(quote);
      if (end === -1) return false;
      let index = end + 1;
      while (this.text[index] === " " || this.text[index] === "\t") index += 1;
      return this.text[index] === ":" && this.isSeparatorAfter(index + 1);
    }
    for (let index = this.i; index < this.text.length; index += 1) {
      const char = this.text[index];
      if (char === "\n") return false;
      if (char === "#" && (index === this.i || /\s/.test(this.text[index - 1]))) {
        return false;
      }
      if (char === ":" && this.isSeparatorAfter(index + 1)) {
        return index > this.i;
      }
    }
    return false;
  }

  /**
   * Whether the character after a `:` ends the key (`: `, `:` EOL, `:` EOF).
   *
   * @param {number} index
   * @returns {boolean}
   */
  isSeparatorAfter(index) {
    const char = this.text[index] ?? "";
    return char === "" || char === " " || char === "\t" || char === "\n";
  }

  /**
   * Find the closing quote of a quoted scalar on the current line.
   *
   * @param {string} quote  `'` or `"`
   * @returns {number} Index of the closing quote, or -1.
   */
  findClosingQuote(quote) {
    for (let index = this.i + 1; index < this.text.length; index += 1) {
      const char = this.text[index];
      if (char === "\n") return -1;
      if (quote === '"' && char === "\\") {
        index += 1;
        continue;
      }
      if (char === quote) {
        if (quote === "'" && this.text[index + 1] === "'") {
          index += 1;
          continue;
        }
        return index;
      }
    }
    return -1;
  }

  /**
   * Parse a block mapping.
   *
   * @param {number} indent
   * @param {string} path
   * @returns {MapNode}
   */
  parseMap(indent, path) {
    const loc = this.loc();
    /** @type {{key: ScalarNode, value: Node, loc: Loc}[]} */
    const entries = [];
    /** @type {Map<string, Loc>} */
    const seen = new Map();

    for (;;) {
      const keyLoc = this.loc();
      const key = this.parseKey();
      if (this.peek() !== ":") {
        throw this.error("MISSING_COLON", "expected `:` after a mapping key", keyLoc);
      }
      this.bump(); // `:`
      while (this.peek() === " " || this.peek() === "\t") this.bump();

      let value;
      if (this.eof || this.peek() === "\n" || this.peek() === "#") {
        value = this.parseNestedValue(indent, true, joinPath(path, this.pathToken(key)));
      } else {
        value = this.parseInlineNode(indent, joinPath(path, this.pathToken(key)), "map-value");
      }

      this.rejectMergeKey(key, keyLoc, path);
      const identity = keyIdentity(key);
      if (seen.has(identity)) {
        const first = seen.get(identity);
        throw this.error(
          "DUPLICATE_KEY",
          `duplicate mapping key ${JSON.stringify(this.keyText(key))}; first defined at line ${first.line}, column ${first.column}`,
          keyLoc,
          joinPath(path, this.pathToken(key)),
        );
      }
      seen.set(identity, keyLoc);
      entries.push({ key, value, loc: keyLoc });

      this.skipGap();
      if (this.eof || this.atMarker("---") || this.atMarker("...")) break;
      const nextIndent = this.column - 1;
      if (nextIndent < indent) break;
      if (nextIndent > indent) {
        throw this.error(
          "UNEXPECTED_INDENT",
          `unexpected indentation (${nextIndent} spaces, expected ${indent})`,
        );
      }
      if (this.isSeqEntry()) {
        throw this.error(
          "MIXED_COLLECTION",
          "a sequence entry cannot appear at mapping indentation",
        );
      }
    }

    return { kind: "map", entries, loc };
  }

  /**
   * Parse a block sequence.
   *
   * @param {number} indent
   * @param {string} path
   * @returns {SeqNode}
   */
  parseSeq(indent, path) {
    const loc = this.loc();
    /** @type {Node[]} */
    const items = [];

    for (;;) {
      this.bump(); // `-`
      while (this.peek() === " " || this.peek() === "\t") this.bump();
      const itemPath = joinPath(path, String(items.length));
      let item;
      if (this.eof || this.peek() === "\n" || this.peek() === "#") {
        item = this.parseNestedValue(indent, false, itemPath);
      } else {
        const itemIndent = this.column - 1;
        if (itemIndent <= indent) {
          throw this.error(
            "BAD_INDENT",
            "a sequence entry value must be indented past the `-`",
          );
        }
        item = this.parseBlock(itemIndent, itemPath, indent);
      }
      items.push(item);

      this.skipGap();
      if (this.eof || this.atMarker("---") || this.atMarker("...")) break;
      const nextIndent = this.column - 1;
      if (nextIndent < indent) break;
      if (nextIndent > indent) {
        throw this.error(
          "UNEXPECTED_INDENT",
          `unexpected indentation (${nextIndent} spaces, expected ${indent})`,
        );
      }
      if (!this.isSeqEntry()) {
        // The sequence ended; the parent (typically a mapping whose value this
        // sequence is) resumes at the same indentation.
        break;
      }
    }

    return { kind: "seq", items, loc };
  }

  /**
   * Parse a value that starts on a following line (after `key:` or `-`).
   *
   * @param {number} parentIndent
   * @param {boolean} allowSameIndentSeq  YAML lets a mapping value's sequence
   *   sit at the same indentation as its key.
   * @param {string} path
   * @returns {Node}
   */
  parseNestedValue(parentIndent, allowSameIndentSeq, path) {
    this.skipGap();
    if (this.eof || this.atMarker("---") || this.atMarker("...")) {
      return this.nullNode(this.loc());
    }
    const nextIndent = this.column - 1;
    if (nextIndent > parentIndent) return this.parseBlock(nextIndent, path);
    if (allowSameIndentSeq && nextIndent === parentIndent && this.isSeqEntry()) {
      return this.parseSeq(parentIndent, path);
    }
    return this.nullNode(this.loc());
  }

  // ── scalars, flow collections, anchors and tags ──────────────────────────

  /**
   * Parse a mapping key: a single-line plain or quoted scalar.
   *
   * @returns {ScalarNode}
   */
  parseKey() {
    const loc = this.loc();
    if (this.peek() === "'" || this.peek() === '"') {
      const node = this.parseQuoted(loc);
      while (this.peek() === " " || this.peek() === "\t") this.bump();
      return node;
    }
    let raw = "";
    while (!this.eof) {
      const char = this.peek();
      if (char === ":" && this.isSeparatorAfter(this.i + 1)) break;
      if (char === "\n") break;
      if (char === "#" && raw.endsWith(" ")) break;
      raw += this.bump();
    }
    raw = raw.replace(/[ \t]+$/, "");
    if (raw === "") {
      throw this.error("EMPTY_KEY", "empty mapping key", loc);
    }
    return this.scalarFromRaw(raw, loc, "plain");
  }

  /**
   * Parse a node that can carry anchors/tags and may be a scalar or flow node.
   *
   * @param {number} indent
   * @param {string} path
   * @param {"root"|"map-value"|"seq-item"} context
   * @returns {Node}
   */
  parseInlineNode(indent, path, context, lineIndent = indent) {
    const loc = this.loc();
    /** @type {string|null} */
    let anchor = null;
    /** @type {string|null} */
    let tag = null;

    for (;;) {
      if (this.peek() === "&") {
        this.bump();
        ANCHOR_NAME.lastIndex = this.i;
        const match = ANCHOR_NAME.exec(this.text);
        if (!match) {
          throw this.error("BAD_ANCHOR", "anchor name is missing", loc);
        }
        anchor = match[0];
        for (let count = 0; count < anchor.length; count += 1) this.bump();
        if (this.peek() === " " || this.peek() === "\t") {
          while (this.peek() === " " || this.peek() === "\t") this.bump();
        }
        continue;
      }
      if (this.peek() === "!") {
        tag = this.parseTag();
        while (this.peek() === " " || this.peek() === "\t") this.bump();
        continue;
      }
      break;
    }

    if (this.peek() === "*") {
      if (anchor !== null || tag !== null) {
        throw this.error(
          "ALIAS_DECORATED",
          "an alias may not carry an anchor or a tag",
          loc,
        );
      }
      this.bump();
      ALIAS_NAME.lastIndex = this.i;
      const match = ALIAS_NAME.exec(this.text);
      if (!match) throw this.error("BAD_ALIAS", "alias name is missing", loc);
      const name = match[0];
      for (let count = 0; count < name.length; count += 1) this.bump();
      const target = this.anchors.get(name);
      if (!target) {
        throw this.error(
          "UNKNOWN_ANCHOR",
          `alias \`*${name}\` names no anchor defined earlier in the stream`,
          loc,
          path,
        );
      }
      this.expectEndOfLine();
      return target;
    }

    /** @type {Node} */
    let node;
    if (this.eof || this.peek() === "\n" || this.peek() === "#") {
      // A bare anchor/tag with its value on the following line(s). At document
      // root the value may legitimately sit at the same indentation, so it is
      // parsed as that block rather than as a nested value.
      if (context === "root") {
        this.skipGap();
        if (this.eof || this.atMarker("---") || this.atMarker("...")) {
          node = this.nullNode(this.loc());
        } else {
          node = this.parseBlock(this.column - 1, path);
        }
      } else {
        node = this.parseNestedValue(indent, context === "map-value", path);
      }
    } else if (this.peek() === "|" || this.peek() === ">") {
      // The block scalar consumes its own header line and content lines. Its
      // content must be indented past the line that carries the indicator.
      node = this.parseBlockScalar(lineIndent, loc);
    } else if (this.peek() === "{" || this.peek() === "[") {
      node = this.parseFlowNode(path);
      this.expectEndOfLine();
    } else if (this.peek() === "'" || this.peek() === '"') {
      node = this.parseQuoted(loc);
      this.expectEndOfLine();
    } else {
      node = this.parsePlainBlockScalar(indent, path, context);
      this.expectEndOfLine();
    }
    // A nested block value (the first branch) and a block scalar consume their
    // own lines, so they must not run the end-of-line check here.

    if (tag !== null) node = this.applyTag(node, tag, loc, path);
    if (anchor !== null) this.anchors.set(anchor, node);
    return node;
  }

  /**
   * Parse a tag token (`!!str`, `!`, `!foo`).
   *
   * @returns {string}
   */
  parseTag() {
    const loc = this.loc();
    let tag = this.bump(); // `!`
    if (this.peek() === "!") tag += this.bump();
    while (!this.eof && !/[\s,[\]{}]/.test(this.peek())) tag += this.bump();
    if (tag === "!") return tag;
    if (!CORE_TAGS.has(tag)) {
      throw this.error(
        "UNSUPPORTED_TAG",
        `tag \`${tag}\` is outside the KYAML subset (only the YAML 1.2 core tags and \`!\` are accepted)`,
        loc,
      );
    }
    return tag;
  }

  /**
   * Apply an explicit core tag to a node, checking kind compatibility.
   *
   * @param {Node} node
   * @param {string} tag
   * @param {Loc} loc
   * @param {string} path
   * @returns {Node}
   */
  applyTag(node, tag, loc, path) {
    if (tag === "!") {
      if (isScalarNode(node) && node.style === "plain") {
        return { ...node, kind: "string", type: "string", value: node.raw };
      }
      return node;
    }
    if (tag === "!!map" || tag === "!!seq") {
      const want = tag === "!!map" ? "map" : "seq";
      if (node.kind !== want) {
        throw this.error(
          "TAG_KIND_MISMATCH",
          `tag \`${tag}\` applied to a ${node.kind} node`,
          loc,
          path,
        );
      }
      return node;
    }
    if (!isScalarNode(node)) {
      throw this.error(
        "TAG_KIND_MISMATCH",
        `tag \`${tag}\` applied to a ${node.kind} node`,
        loc,
        path,
      );
    }
    if (tag === "!!str") {
      return { ...node, kind: "string", type: "string", value: node.raw };
    }
    const resolved = resolvePlainScalar(node.raw);
    const expected = tag.slice(2);
    if (resolved.type !== expected) {
      throw this.error(
        "TAG_VALUE_MISMATCH",
        `tag \`${tag}\` cannot be applied to ${JSON.stringify(node.raw)} (resolves to ${resolved.type})`,
        loc,
        path,
      );
    }
    return { ...node, kind: resolved.type, type: resolved.type, value: resolved.value };
  }

  /**
   * Parse a plain scalar in block context.
   *
   * @param {number} indent
   * @param {string} path
   * @param {"root"|"map-value"|"seq-item"} context
   * @returns {ScalarNode}
   */
  parsePlainBlockScalar(indent, path, context) {
    const loc = this.loc();
    let raw = "";
    for (;;) {
      if (this.eof) break;
      const char = this.peek();
      if (char === "\n") break;
      if (char === "#" && (raw === "" || raw.endsWith(" "))) break;
      if (char === ":" && this.isSeparatorAfter(this.i + 1)) {
        if (raw !== "" && context !== "root") {
          throw this.error(
            "MAPPING_IN_VALUE",
            "a nested mapping cannot start on the same line as its parent value; put it on the next line",
            this.loc(),
            path,
          );
        }
        if (raw === "") {
          throw this.error(
            "MAPPING_IN_VALUE",
            "a nested mapping cannot start on the same line as its parent value",
            this.loc(),
            path,
          );
        }
      }
      if (char === "#" && raw.endsWith(" ")) break;
      raw += this.bump();
    }
    raw = raw.replace(/[ \t]+$/, "");
    if (raw === "") {
      throw this.error("EMPTY_VALUE", "empty scalar in value position", loc, path);
    }
    return this.scalarFromRaw(raw, loc, "plain");
  }

  /**
   * Build a plain scalar node with core-schema resolution.
   *
   * @param {string} raw
   * @param {Loc} loc
   * @param {string} style
   * @returns {ScalarNode}
   */
  scalarFromRaw(raw, loc, style) {
    const resolved = resolvePlainScalar(raw);
    const node = /** @type {ScalarNode} */ ({
      kind: resolved.type,
      type: resolved.type,
      value: resolved.value,
      raw,
      loc,
      style,
    });
    if (resolved.type === "string") {
      assertIJsonString(String(resolved.value), "", "kyaml", loc);
    }
    return node;
  }

  /**
   * Parse a single- or double-quoted scalar (single line).
   *
   * @param {Loc} loc
   * @returns {ScalarNode}
   */
  parseQuoted(loc) {
    const quote = this.bump();
    let out = "";
    for (;;) {
      if (this.eof || this.peek() === "\n") {
        throw this.error(
          "UNTERMINATED_QUOTE",
          `unterminated ${quote === "'" ? "single" : "double"}-quoted scalar (multi-line quoted scalars are outside the KYAML subset)`,
          loc,
        );
      }
      const char = this.bump();
      if (char === quote) {
        if (quote === "'" && this.peek() === "'") {
          this.bump();
          out += "'";
          continue;
        }
        break;
      }
      if (quote === '"' && char === "\\") {
        out += this.parseDoubleQuotedEscape();
        continue;
      }
      const codePoint = char.codePointAt(0);
      if (codePoint < 0x20 && codePoint !== 0x09) {
        throw this.error(
          "CONTROL_CHARACTER",
          `raw control character U+${codePoint.toString(16).toUpperCase().padStart(4, "0")} in a quoted scalar`,
          loc,
        );
      }
      out += char;
    }
    assertIJsonString(out, "", "kyaml", loc);
    return { kind: "string", type: "string", value: out, raw: out, loc, style: "quoted" };
  }

  /**
   * Decode one YAML double-quoted escape (backslash already consumed).
   *
   * @returns {string}
   */
  parseDoubleQuotedEscape() {
    const loc = this.loc();
    const escape = this.bump();
    const simple = {
      "0": "\0",
      a: "\x07",
      b: "\b",
      t: "\t",
      "\t": "\t",
      n: "\n",
      v: "\v",
      f: "\f",
      r: "\r",
      e: "\x1b",
      " ": " ",
      '"': '"',
      "/": "/",
      "\\": "\\",
      N: "\u0085",
      _: "\u00a0",
      L: "\u2028",
      P: "\u2029",
    };
    if (Object.hasOwn(simple, escape)) return simple[escape];
    const width = escape === "x" ? 2 : escape === "u" ? 4 : escape === "U" ? 8 : 0;
    if (width === 0) {
      throw this.error(
        "BAD_ESCAPE",
        `unknown escape sequence \\${escape}`,
        loc,
      );
    }
    let hex = "";
    for (let count = 0; count < width; count += 1) hex += this.bump();
    if (!new RegExp(`^[0-9a-fA-F]{${width}}$`).test(hex)) {
      throw this.error("BAD_ESCAPE", `invalid escape sequence \\${escape}${hex}`, loc);
    }
    const codePoint = Number.parseInt(hex, 16);
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      throw this.error(
        "LONE_SURROGATE",
        `escape \\${escape}${hex} is a lone surrogate; JSON strings must not contain one`,
        loc,
      );
    }
    if (codePoint > 0x10ffff) {
      throw this.error("BAD_ESCAPE", `escape \\${escape}${hex} is above U+10FFFF`, loc);
    }
    return String.fromCodePoint(codePoint);
  }

  /**
   * Parse a `|` / `>` block scalar, including chomping and indent indicators.
   *
   * @param {number} parentIndent
   * @param {Loc} loc
   * @returns {ScalarNode}
   */
  parseBlockScalar(parentIndent, loc) {
    const style = this.bump() === "|" ? "literal" : "folded";
    let chomp = "clip";
    if (this.peek() === "+" || this.peek() === "-") {
      chomp = this.bump() === "+" ? "keep" : "strip";
    }
    let explicitIndent = null;
    if (/[1-9]/.test(this.peek())) {
      explicitIndent = Number(this.bump());
    }
    while (this.peek() === " " || this.peek() === "\t") this.bump();
    if (this.peek() === "#") this.skipToEndOfLine();
    else if (!this.eof && this.peek() !== "\n") {
      throw this.error(
        "BAD_BLOCK_SCALAR",
        "unexpected character in a block scalar header",
        loc,
      );
    }
    if (!this.eof) this.bump(); // header line break

    /** @type {{text: string, moreIndented: boolean, blank: boolean}[]} */
    const lines = [];
    let contentIndent = explicitIndent === null ? null : parentIndent + explicitIndent;

    for (;;) {
      if (this.eof) break;
      if (this.column !== 1) {
        throw this.error("BAD_BLOCK_SCALAR", "block scalar content must start on a new line");
      }
      const lineStart = { i: this.i, line: this.line };
      if (this.markerAt(this.i)) break;
      let spaces = 0;
      while (this.peek() === " ") {
        this.bump();
        spaces += 1;
      }
      if (this.peek() === "\t" && contentIndent !== null && spaces < contentIndent) {
        throw this.error(
          "TAB_INDENT",
          "a tab may not be used as block scalar indentation",
        );
      }
      if (this.peek() === "\n" || this.eof) {
        if (!this.eof) this.bump();
        lines.push({ text: "", moreIndented: false, blank: true });
        continue;
      }
      if (contentIndent === null) {
        if (spaces <= parentIndent) {
          this.rewind(lineStart);
          break;
        }
        contentIndent = spaces;
      }
      if (spaces < contentIndent) {
        this.rewind(lineStart);
        break;
      }
      let text = " ".repeat(spaces - contentIndent);
      while (!this.eof && this.peek() !== "\n") text += this.bump();
      if (!this.eof) this.bump();
      lines.push({ text, moreIndented: spaces > contentIndent, blank: false });
    }

    // Drop trailing blank lines from the content; chomping decides their fate.
    let trailingBreaks = 0;
    while (lines.length > 0 && lines[lines.length - 1].blank) {
      lines.pop();
      trailingBreaks += 1;
    }

    let body;
    if (style === "literal") {
      body = lines.map((line) => line.text).join("\n");
      if (lines.length > 0) body += "\n";
    } else {
      // Folded style: a line break between two ordinary text lines becomes a
      // space; breaks next to a blank or more-indented line are kept, and N
      // consecutive breaks become N−1 newlines (YAML 1.2 §8.1.3).
      body = "";
      let pendingBreaks = 0;
      let firstLine = true;
      let previousMoreIndented = false;
      for (const line of lines) {
        if (line.blank) {
          pendingBreaks += 1;
          continue;
        }
        if (firstLine) {
          body += "\n".repeat(pendingBreaks) + line.text;
          firstLine = false;
        } else if (line.moreIndented || previousMoreIndented) {
          body += "\n".repeat(pendingBreaks + 1) + line.text;
        } else if (pendingBreaks > 0) {
          body += "\n".repeat(pendingBreaks) + line.text;
        } else {
          body += ` ${line.text}`;
        }
        pendingBreaks = 0;
        previousMoreIndented = line.moreIndented;
      }
      if (lines.length > 0 && !firstLine) body += "\n";
    }

    if (chomp === "strip") {
      body = body.replace(/\n+$/, "");
    } else if (chomp === "clip") {
      body = body.replace(/\n+$/, "");
      if (lines.length > 0) body += "\n";
    } else {
      body += "\n".repeat(trailingBreaks);
    }

    assertIJsonString(body, "", "kyaml", loc);
    return { kind: "string", type: "string", value: body, raw: body, loc, style: "block" };
  }

  /**
   * Parse a flow collection (may span lines).
   *
   * @param {string} path
   * @returns {Node}
   */
  parseFlowNode(path) {
    const loc = this.loc();
    const opener = this.peek();
    if (opener === "[") {
      this.bump();
      /** @type {Node[]} */
      const items = [];
      for (;;) {
        this.skipFlowGap();
        if (this.peek() === "]") {
          this.bump();
          break;
        }
        if (this.eof) {
          throw this.error("UNTERMINATED_FLOW", "unterminated flow sequence", loc, path);
        }
        items.push(this.parseFlowItem(joinPath(path, String(items.length))));
        this.skipFlowGap();
        if (this.peek() === ",") {
          this.bump();
          this.skipFlowGap();
          if (this.peek() === "]") {
            throw this.error(
              "FLOW_TRAILING_COMMA",
              "a trailing comma in a flow collection is outside the KYAML subset",
            );
          }
          continue;
        }
        if (this.peek() === "]") {
          this.bump();
          break;
        }
        if (this.eof) {
          throw this.error("UNTERMINATED_FLOW", "unterminated flow sequence", loc, path);
        }
        throw this.error(
          "FLOW_SEPARATOR",
          `expected \`,\` or \`]\` in a flow sequence, found ${JSON.stringify(this.peek())}`,
          this.loc(),
          path,
        );
      }
      return { kind: "seq", items, loc };
    }

    this.bump(); // `{`
    /** @type {{key: ScalarNode, value: Node, loc: Loc}[]} */
    const entries = [];
    /** @type {Map<string, Loc>} */
    const seen = new Map();
    for (;;) {
      this.skipFlowGap();
      if (this.peek() === "}") {
        this.bump();
        break;
      }
      if (this.eof) {
        throw this.error("UNTERMINATED_FLOW", "unterminated flow mapping", loc, path);
      }
      const keyLoc = this.loc();
      const key = this.parseFlowKey();
      this.skipFlowGap();
      if (this.peek() !== ":") {
        throw this.error(
          "FLOW_SEPARATOR",
          "expected `:` after a flow mapping key",
          this.loc(),
          path,
        );
      }
      this.bump();
      const value = this.parseFlowItem(joinPath(path, this.pathToken(key)));
      this.rejectMergeKey(key, keyLoc, path);
      const identity = keyIdentity(key);
      if (seen.has(identity)) {
        const first = seen.get(identity);
        throw this.error(
          "DUPLICATE_KEY",
          `duplicate mapping key ${JSON.stringify(this.keyText(key))}; first defined at line ${first.line}, column ${first.column}`,
          keyLoc,
          joinPath(path, this.pathToken(key)),
        );
      }
      seen.set(identity, keyLoc);
      entries.push({ key, value, loc: keyLoc });
      this.skipFlowGap();
      if (this.peek() === ",") {
        this.bump();
        this.skipFlowGap();
        if (this.peek() === "}") {
          throw this.error(
            "FLOW_TRAILING_COMMA",
            "a trailing comma in a flow collection is outside the KYAML subset",
          );
        }
        continue;
      }
      if (this.peek() === "}") {
        this.bump();
        break;
      }
      if (this.eof) {
        throw this.error("UNTERMINATED_FLOW", "unterminated flow mapping", loc, path);
      }
      throw this.error(
        "FLOW_SEPARATOR",
        `expected \`,\` or \`}\` in a flow mapping, found ${JSON.stringify(this.peek())}`,
        this.loc(),
        path,
      );
    }
    return { kind: "map", entries, loc };
  }

  /**
   * Skip whitespace, newlines and comments inside a flow collection.
   *
   * @returns {void}
   */
  skipFlowGap() {
    for (;;) {
      if (this.eof) return;
      const char = this.peek();
      if (char === " " || char === "\t" || char === "\n") {
        this.bump();
        continue;
      }
      if (char === "#") {
        this.skipToEndOfLine();
        continue;
      }
      return;
    }
  }

  /**
   * Parse one flow item (scalar, nested flow collection, anchor or alias).
   *
   * @param {string} path
   * @returns {Node}
   */
  parseFlowItem(path) {
    this.skipFlowGap();
    const loc = this.loc();
    /** @type {string|null} */
    let anchor = null;
    /** @type {string|null} */
    let tag = null;
    for (;;) {
      if (this.peek() === "&") {
        this.bump();
        ANCHOR_NAME.lastIndex = this.i;
        const match = ANCHOR_NAME.exec(this.text);
        if (!match) throw this.error("BAD_ANCHOR", "anchor name is missing", loc);
        anchor = match[0];
        for (let count = 0; count < anchor.length; count += 1) this.bump();
        this.skipFlowGap();
        continue;
      }
      if (this.peek() === "!") {
        tag = this.parseTag();
        this.skipFlowGap();
        continue;
      }
      break;
    }
    if (this.peek() === "*") {
      this.bump();
      ALIAS_NAME.lastIndex = this.i;
      const match = ALIAS_NAME.exec(this.text);
      if (!match) throw this.error("BAD_ALIAS", "alias name is missing", loc);
      const name = match[0];
      for (let count = 0; count < name.length; count += 1) this.bump();
      const target = this.anchors.get(name);
      if (!target) {
        throw this.error(
          "UNKNOWN_ANCHOR",
          `alias \`*${name}\` names no anchor defined earlier in the stream`,
          loc,
          path,
        );
      }
      return target;
    }

    /** @type {Node} */
    let node;
    if (this.peek() === "[" || this.peek() === "{") {
      node = this.parseFlowNode(path);
    } else if (this.peek() === "'" || this.peek() === '"') {
      node = this.parseQuoted(loc);
    } else if (this.eof || /[,\]}\n]/.test(this.peek())) {
      node = this.nullNode(loc);
    } else {
      let raw = "";
      while (!this.eof) {
        const char = this.peek();
        if (/[,\]}\n]/.test(char)) break;
        if (char === ":" && this.isSeparatorAfter(this.i + 1)) break;
        if (char === "#" && (raw === "" || raw.endsWith(" "))) break;
        raw += this.bump();
      }
      raw = raw.replace(/[ \t]+$/, "");
      if (raw === "") {
        throw this.error(
          "EMPTY_VALUE",
          "empty flow scalar",
          loc,
          path,
        );
      }
      node = this.scalarFromRaw(raw, loc, "plain");
    }
    if (tag !== null) node = this.applyTag(node, tag, loc, path);
    if (anchor !== null) this.anchors.set(anchor, node);
    return node;
  }

  /**
   * Parse a key inside a flow mapping.
   *
   * @returns {ScalarNode}
   */
  parseFlowKey() {
    const loc = this.loc();
    if (this.peek() === "'" || this.peek() === '"') return this.parseQuoted(loc);
    let raw = "";
    while (!this.eof) {
      const char = this.peek();
      if (char === ":" || /[,\]}\n]/.test(char)) break;
      raw += this.bump();
    }
    raw = raw.trim();
    if (raw === "") throw this.error("EMPTY_KEY", "empty flow mapping key", loc);
    return this.scalarFromRaw(raw, loc, "plain");
  }

  // ── small helpers ────────────────────────────────────────────────────────

  /**
   * Refuse the YAML 1.1 `<<` merge key.
   *
   * `<<` is not in the YAML 1.2 Core Schema; treating it as an ordinary string
   * key would silently change the document's meaning for every consumer that
   * expects merge semantics, so it is an error here.
   *
   * @param {ScalarNode} key
   * @param {Loc} loc
   * @param {string} path
   * @returns {void}
   */
  rejectMergeKey(key, loc, path) {
    if (key.kind === "string" && key.value === "<<") {
      throw this.error(
        "UNSUPPORTED_MERGE_KEY",
        "the YAML merge key `<<` is outside the KYAML subset; spell the merged keys out",
        loc,
        path,
      );
    }
  }

  /**
   * The pointer token for a key node (the resolved text of a scalar key).
   *
   * @param {ScalarNode} key
   * @returns {string}
   */
  pathToken(key) {
    if (key.kind === "string") return String(key.value);
    if (key.kind === "null") return "null";
    return key.raw;
  }

  /**
   * Human text of a key, for duplicate-key diagnostics.
   *
   * @param {ScalarNode} key
   * @returns {string}
   */
  keyText(key) {
    return key.kind === "string" ? String(key.value) : key.raw;
  }

  /**
   * Build the `null` node.
   *
   * @param {Loc} loc
   * @returns {ScalarNode}
   */
  nullNode(loc) {
    return { kind: "null", type: "null", value: null, raw: "", loc, style: "plain" };
  }
}

/**
 * Parse a KYAML stream from bytes.
 *
 * @param {Uint8Array} bytes
 * @param {string} [source]  File name for diagnostics.
 * @returns {Node[]}
 * @throws {ConformanceError}
 */
export function parseKyaml(bytes, source) {
  const text = decodeUtf8(bytes, "kyaml");
  return new KyamlParser(text, source).parseStream();
}

export { BOM };
