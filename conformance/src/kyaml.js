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
//     non-core tags and multi-line plain/quoted scalars are refused with a
//     specific code; a trailing comma in a flow collection is accepted;
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

/** Longest implicit mapping key, in characters (YAML 1.2 §7.4.2). */
const MAX_IMPLICIT_KEY = 1024;

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

// YAML separation is space, tab and line break; a no-break space or other
// Unicode space is part of a name (ns-anchor-char).
const ANCHOR_NAME = /[^ \t\n,[\]{}]+/y;
const ALIAS_NAME = /[^ \t\n,[\]{}]+/y;

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
    /** @type {number|null} The indentation a flow collection's lines must reach. */
    this.flowMin = null;
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
    // Any BOM after the one just skipped is smuggled in mid-stream.
    const at = this.text.indexOf("\uFEFF", this.i);
    if (at !== -1) {
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
    // Whether the stream is between documents: at its start or after a `...`
    // marker, where directives for the next document may appear (YAML 1.2
    // §9.1.4). A directive needs a `---` after it.
    let ended = true;
    const missingDocStart = () =>
      this.error(
        "MISSING_DOC_START",
        "a `---` document start marker is required after a directive",
        this.loc(),
      );
    this.assertPrintable();
    this.skipGap();

    for (;;) {
      if (this.eof) {
        if (sawDirective) throw missingDocStart();
        break;
      }
      if (this.atDirective()) {
        if (!ended) {
          throw this.error(
            "UNSUPPORTED_DIRECTIVE",
            "a directive must come before a document, after `...` if one precedes it",
            this.loc(),
          );
        }
        if (sawDirective && /^%YAML(?:[ \t\n]|$)/.test(this.text.slice(this.i, this.i + 6))) {
          throw this.error("DUPLICATE_DIRECTIVE", "a document has at most one `%YAML`", this.loc());
        }
        this.parseDirective();
        sawDirective = true;
        this.skipGap();
        continue;
      }
      if (this.atMarker("...")) {
        if (sawDirective) throw missingDocStart();
        this.consumeMarker();
        ended = true;
        this.skipGap();
        continue;
      }
      if (this.atMarker("---")) {
        this.consumeMarker();
        // Anchors are scoped to one document (YAML 1.2 §7.1).
        this.anchors = new Map();
        sawDirective = false;
        ended = false;
        this.skipGap();
        if (this.eof) {
          // A final `---` with no content starts an empty document: null, as
          // YAML reads it (the YAML test suite's 6XDY, PUW8).
          documents.push(this.nullNode(this.loc()));
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
      ended = false;
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
    // A leading BOM is zero-width, as parse() treats it.
    const start = offset > 0 && this.text[0] === "﻿" ? 1 : 0;
    // Columns count code points, as bump() does: a character outside the BMP
    // is two UTF-16 units but one column.
    for (let index = start; index < offset; index += this.text.codePointAt(index) > 0xffff ? 2 : 1) {
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
          this.skipComment();
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
        this.skipComment();
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
   * Refuse the first character outside YAML's printable set (YAML 1.2 §5.1,
   * c-printable) anywhere in the stream, at that character: a C0 control
   * other than tab and line feed, DEL, a C1 control other than NEL (U+0085),
   * or the noncharacters U+FFFE and U+FFFF. Surrogates cannot occur in a
   * decoded string. Scalars, comments, directives and properties are all
   * covered by this one check.
   *
   * @returns {void}
   */
  assertPrintable() {
    const bad = /[\u0000-\u0008\u000B-\u001F\u007F-\u0084\u0086-\u009F\uFFFE\uFFFF]/u.exec(this.text);
    if (bad === null) return;
    const code = bad[0].codePointAt(0);
    const hex = code.toString(16).toUpperCase().padStart(4, "0");
    if (code >= 0xfffe) {
      throw this.error("NONCHARACTER", `noncharacter U+${hex} is not printable YAML`, this.locationOf(bad.index));
    }
    throw this.error(
      "CONTROL_CHARACTER",
      `raw control character U+${hex} is not printable YAML`,
      this.locationOf(bad.index),
    );
  }

  /**
   * Consume to (and including) the next line break. (Comment text was checked
   * to be printable with the rest of the stream.)
   *
   * @returns {void}
   */
  skipToEndOfLine() {
    while (!this.eof && this.peek() !== "\n") this.bump();
    if (!this.eof) this.bump();
    this.atContent = false;
  }

  /**
   * A `#` starts a comment only at the start of a line or after white space
   * (YAML 1.2 §6.6): `"x"#y` and `[1]#y` are not commented.
   *
   * @returns {void}
   */
  skipComment() {
    const before = this.i > 0 ? this.text[this.i - 1] : "\n";
    if (this.column !== 1 && before !== " " && before !== "\t" && before !== "\n") {
      throw this.error(
        "BAD_COMMENT",
        "a comment must be separated from what precedes it by white space",
      );
    }
    this.skipToEndOfLine();
  }

  /**
   * Consume trailing spaces and an optional comment, then require end of line.
   *
   * @returns {void}
   */
  expectEndOfLine() {
    while (this.peek() === " " || this.peek() === "\t") this.bump();
    if (this.peek() === "#") {
      this.skipComment();
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
    // Only the two marker spellings: `--.` or `-.-` is a plain scalar.
    if (text !== "---" && text !== "...") return false;
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
      this.skipComment();
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
    // YAML separates directive fields with spaces and tabs only (s-separate-
    // in-line): `%YAML` + U+00A0 + `1.2` is one unknown directive name.
    const fields = line.replace(/^[ \t]+|[ \t]+$/g, "");
    const [name, ...words] = fields.split(/[ \t]+/);
    // A comment may follow a directive's arguments (`%YAML 1.2 # note`).
    const comment = words.findIndex((word) => word.startsWith("#"));
    const args = comment === -1 ? words : words.slice(0, comment);
    if (name === "%YAML") {
      if (args.length !== 1 || args[0] !== "1.2") {
        throw this.error(
          "UNSUPPORTED_VERSION",
          `only \`%YAML 1.2\` is supported, got \`${fields}\``,
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
    // The document root is a block node at indentation -1 (YAML 1.2 §9.2): a
    // root flow collection may close at column 1, and a root block scalar's
    // content may start there.
    const node = this.parseBlock(indent, "", -1);
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
   * @param {number} [lineIndent]
   * @param {number|null} [seqAt]
   * @param {number} [floor] The indentation of the block node that holds
   *   this one: a flow collection's lines and a block scalar's content are
   *   indented past it (YAML 1.2 s-flow-line-prefix, s-indent).
   * @returns {Node}
   */
  parseBlock(indent, path, lineIndent = indent, seqAt = null, floor = lineIndent) {
    if (this.eof) return this.nullNode(this.loc());
    if (this.isSeqEntry()) return this.parseSeq(indent, path);
    if (this.isMapEntry()) return this.parseMap(indent, path);
    return this.parseInlineNode(indent, path, "root", lineIndent, [null, null], seqAt, floor);
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
    // An anchor, tag or alias that falls on a key is outside the KYAML subset.
    if ("&*!".includes(this.peek()) && this.peek() !== "") {
      if (this.isPropertyKey()) this.throwKeyProperty(this.loc());
      return false;
    }
    // A line opening with a flow indicator or block scalar indicator is a
    // node, not a `key:` entry — scanning it for a colon would find one inside
    // the flow collection.
    if ("{[|>".includes(this.peek())) return false;
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
      if (char === "#" && (index === this.i || /[ \t\n]/.test(this.text[index - 1]))) {
        return false;
      }
      if (char === ":" && this.isSeparatorAfter(index + 1)) {
        return index > this.i;
      }
    }
    return false;
  }

  /**
   * Whether a line that opens with an anchor, tag or alias is a mapping entry,
   * so that the property would fall on its key (`&a b: 1`, `!!str b: 1`,
   * `*a : 1`). Read as a plain key, `!!str a` would be a different key from `a`.
   *
   * @returns {boolean}
   */
  isPropertyKey() {
    const token = (index) => {
      while (index < this.text.length && !/[ \t\n,[\]{}]/.test(this.text[index])) index += 1;
      return index;
    };
    const blanks = (index) => {
      while (this.text[index] === " " || this.text[index] === "\t") index += 1;
      return index;
    };
    let index = this.i;
    while (this.text[index] === "&" || this.text[index] === "!") {
      index = blanks(token(index + 1));
    }
    const char = this.text[index] ?? "";
    if (char === "*") {
      const after = blanks(token(index + 1));
      return this.text[after] === ":" && this.isSeparatorAfter(after + 1);
    }
    if (char === "" || char === "\n" || char === "#") return false;
    const saved = this.i;
    this.i = index;
    try {
      return this.isMapEntry();
    } finally {
      this.i = saved;
    }
  }

  /**
   * @param {Loc} loc
   * @returns {never}
   */
  throwKeyProperty(loc) {
    throw this.error(
      "KEY_PROPERTY",
      "an anchor, tag or alias on a mapping key is outside the KYAML subset",
      loc,
    );
  }

  /**
   * Whether the character after a `:` ends the key (`: `, `:` EOL, `:` EOF).
   *
   * @param {number} index
   * @returns {boolean}
   */
  isFlowSeparatorAfter(index) {
    return /^[ \t\n,[\]{}]?$/.test(this.text[index] ?? "");
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
      let tabbed = false;
      while (this.peek() === " " || this.peek() === "\t") {
        if (this.peek() === "\t") tabbed = true;
        this.bump();
      }
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
        // A compact nested collection is indented by its `- `: with spaces
        // only, since a tab there is indentation (YAML 1.2 s-indent).
        if (tabbed && (this.isSeqEntry() || this.isMapEntry())) {
          throw this.error("TAB_INDENT", "a tab may not indent a nested collection");
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
    if (nextIndent > parentIndent) {
      // A value on the following line is indented past its parent, and that
      // parent, not the value's own column, is what a flow collection's
      // continuation lines and a block scalar's content are measured from.
      return this.parseBlock(nextIndent, path, nextIndent, allowSameIndentSeq ? parentIndent : null, parentIndent);
    }
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
    if ("&*!".includes(this.peek()) && this.peek() !== "" && this.isPropertyKey()) {
      this.throwKeyProperty(loc);
    }
    if (this.peek() === "'" || this.peek() === '"') {
      const start = this.i;
      const node = this.parseQuoted(loc);
      this.checkKeyLength(this.text.slice(start, this.i), loc);
      while (this.peek() === " " || this.peek() === "\t") this.bump();
      return node;
    }
    let raw = "";
    while (!this.eof) {
      const char = this.peek();
      if (char === ":" && this.isSeparatorAfter(this.i + 1)) break;
      if (char === "\n") break;
      if (char === "#" && /[ \t]$/.test(raw)) break;
      raw += this.bump();
    }
    raw = raw.replace(/[ \t]+$/, "");
    if (raw === "") {
      throw this.error("EMPTY_KEY", "empty mapping key", loc);
    }
    this.checkKeyLength(raw, loc);
    return this.scalarFromRaw(raw, loc, "plain");
  }

  /**
   * Parse a node that can carry anchors/tags and may be a scalar or flow node.
   *
   * @param {number} indent
   * @param {string} path
   * @param {"root"|"map-value"|"seq-item"} context
   * @param {number} [lineIndent]
   * @param {[string|null, string|null]} [props] Anchor and tag already read
   *   from a line above, for properties continued on the next line.
   * @param {number|null} [seqAt] The indentation of the mapping whose value
   *   this is, when a block sequence may sit at that same indentation.
   * @param {number} [floor] See parseBlock.
   * @returns {Node}
   */
  parseInlineNode(indent, path, context, lineIndent = indent, props = [null, null], seqAt = null, floor = lineIndent) {
    const loc = this.loc();
    /** @type {string|null} */
    let anchor = props[0];
    /** @type {string|null} */
    let tag = props[1];

    for (;;) {
      if (this.peek() === "&") {
        if (anchor !== null) this.throwDuplicateProperty("anchor");
        this.bump();
        ANCHOR_NAME.lastIndex = this.i;
        const match = ANCHOR_NAME.exec(this.text);
        if (!match) {
          throw this.error("BAD_ANCHOR", "anchor name is missing", loc);
        }
        anchor = match[0];
        for (let count = 0; count < anchor.length; count += 1) this.bump();
        this.assertPropertyEnd();
        if (this.peek() === " " || this.peek() === "\t") {
          while (this.peek() === " " || this.peek() === "\t") this.bump();
        }
        continue;
      }
      if (this.peek() === "!") {
        if (tag !== null) this.throwDuplicateProperty("tag");
        tag = this.parseTag();
        this.assertPropertyEnd();
        while (this.peek() === " " || this.peek() === "\t") this.bump();
        continue;
      }
      break;
    }

    // A bare anchor or tag at the end of a line may be followed by more
    // properties on the next line (`a: &x` then `  !!str v`): they are the
    // same node's, so they go through the same one-anchor, one-tag check
    // rather than starting a fresh node that the outer ones would overwrite.
    if ((anchor !== null || tag !== null) && (this.eof || this.peek() === "\n" || this.peek() === "#")) {
      const saved = { i: this.i, line: this.line, column: this.column, atContent: this.atContent };
      this.skipGap();
      const ownsNextLine =
        !this.eof &&
        (context === "root" ? !this.isEnclosingLine(indent, lineIndent, seqAt) : this.column - 1 > indent);
      if (ownsNextLine && (this.peek() === "&" || this.peek() === "!") && !this.isPropertyKey()) {
        return this.parseInlineNode(indent, path, context, lineIndent, [anchor, tag], seqAt, floor);
      }
      // `a: &b` then `  *c`: the alias on the next line is this node, so it
      // carries the anchor or tag as surely as `a: &b *c` does. Left alone, it
      // would register `b` as an alias of `c`, and chains of such aliases cost
      // the node budget nothing per link.
      if (ownsNextLine && this.peek() === "*") {
        throw this.error("ALIAS_DECORATED", "an alias may not carry an anchor or a tag", loc);
      }
      Object.assign(this, saved);
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
        if (
          this.eof ||
          this.atMarker("---") ||
          this.atMarker("...") ||
          this.isEnclosingLine(indent, lineIndent, seqAt)
        ) {
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
      node = this.parseBlockScalar(floor, loc);
    } else if (this.peek() === "{" || this.peek() === "[") {
      // Each line of a flow collection must be indented past the block node
      // that holds it (YAML 1.2 s-flow-line-prefix).
      this.flowMin = floor + 1;
      node = this.parseFlowNode(path);
      this.flowMin = null;
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
   * A node has at most one anchor and one tag (YAML 1.2 §6.9); a second would
   * silently replace the first.
   *
   * @param {"anchor"|"tag"} what
   * @returns {never}
   */
  throwDuplicateProperty(what) {
    throw this.error("DUPLICATE_PROPERTY", `a node may carry only one ${what}`, this.loc());
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
    while (!this.eof && !/[ \t\n,[\]{}]/.test(this.peek())) tag += this.bump();
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
    let resolved = resolvePlainScalar(node.raw);
    const expected = tag.slice(2);
    // The Core Schema's float pattern also matches a decimal integer, so
    // `!!float 1` is the float 1.
    if (expected === "float" && resolved.type === "int" && FLOAT.test(node.raw)) {
      resolved = { type: "float", value: Number(node.raw) };
    }
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
      // A comment is separated by white space: a space or a tab (YAML 1.2 §6.6).
      if (char === "#" && (raw === "" || /[ \t]$/.test(raw))) break;
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
    // A plain scalar may not start with an indicator (YAML 1.2 ns-plain-first):
    // `@`, `` ` ``, `%`, `[`, `{`, `|`, `>`, `,`, `]` and `}` ever, and `-`,
    // `?` or `:` unless a safe character follows, so `a: - item` is not the
    // string "- item" (`-1` and `-x` are plain scalars). A later mapping key
    // such as `[b]` or `|b` reaches here as text, and YAML does not read it
    // as that string.
    if (/^[@`%,[\]{}|>]/.test(raw) || /^[-?:]($|[ \t])/.test(raw)) {
      throw this.error(
        "PLAIN_INDICATOR",
        `a plain scalar cannot start with \`${raw[0]}\` here; quote it`,
        loc,
      );
    }
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
    // The chomping and indentation indicators may come in either order
    // (YAML 1.2 §8.1.1: `|2-` and `|-2`).
    let chomp = null;
    let explicitIndent = null;
    for (;;) {
      if (chomp === null && (this.peek() === "+" || this.peek() === "-")) {
        chomp = this.bump() === "+" ? "keep" : "strip";
      } else if (explicitIndent === null && /[1-9]/.test(this.peek())) {
        explicitIndent = Number(this.bump());
      } else {
        break;
      }
    }
    chomp ??= "clip";
    while (this.peek() === " " || this.peek() === "\t") this.bump();
    if (this.peek() === "#") {
      // The comment runs to, and consumes, the header line break.
      this.skipComment();
    } else if (!this.eof && this.peek() !== "\n") {
      throw this.error(
        "BAD_BLOCK_SCALAR",
        "unexpected character in a block scalar header",
        loc,
      );
    } else if (!this.eof) {
      this.bump(); // header line break
    }

    /** @type {{text: string, moreIndented: boolean, blank: boolean, spaces?: number}[]} */
    const lines = [];
    // The document root sits at indentation -1; its content counts from 0.
    let contentIndent = explicitIndent === null ? null : Math.max(parentIndent, 0) + explicitIndent;

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
        if (contentIndent !== null && spaces > contentIndent) {
          // Spaces past the content indentation are content, even on an
          // otherwise empty line (YAML 1.2 §8.1.3).
          lines.push({ text: " ".repeat(spaces - contentIndent), moreIndented: true, blank: false });
        } else {
          lines.push({ text: "", moreIndented: false, blank: true, spaces });
        }
        continue;
      }
      if (contentIndent === null) {
        if (spaces <= parentIndent) {
          this.rewind(lineStart);
          break;
        }
        // A detected indentation must cover the leading blank lines: one with
        // more spaces than the first content line is an error (YAML 1.2
        // §8.1.1.1), not silently dropped spaces.
        if (lines.some((line) => line.blank && line.spaces > spaces)) {
          throw this.error(
            "BAD_BLOCK_SCALAR",
            "a leading blank line is indented past the block scalar's content",
          );
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
      // A line that starts with white space after the indentation, a tab
      // included, is "spaced" and is not folded (YAML 1.2 §8.1.3).
      lines.push({ text, moreIndented: spaces > contentIndent || text.startsWith("\t"), blank: false });
    }

    // Drop trailing blank lines from the content; chomping decides their fate.
    let trailingBreaks = 0;
    while (lines.length > 0 && lines[lines.length - 1].blank) {
      lines.pop();
      trailingBreaks += 1;
    }
    // The end of input ends the last line as a line break would: the YAML test
    // suite reads `x: |\n  a` as "a\n" (L24T/01, JEF9/02).
    const finalBreak = lines.length > 0;

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

    body = body.replace(/\n+$/, "");
    if (chomp === "clip" && finalBreak) {
      body += "\n";
    } else if (chomp === "keep") {
      body += "\n".repeat((finalBreak ? 1 : 0) + trailingBreaks);
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
        if (this.peek() === ",") {
          // A `,` must follow an entry: `[1,,2]` and `[,]` have an empty one.
          throw this.error("EMPTY_VALUE", "empty flow sequence entry", this.loc(), path);
        }
        items.push(this.parseFlowItem(joinPath(path, String(items.length))));
        this.skipFlowGap();
        if (this.peek() === ",") {
          // YAML 1.2 allows a final `,`; KYAML (KEP-5295) writes one after every
          // entry. The next pass sees the closer and ends the collection.
          this.bump();
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
      const keyLine = this.line;
      this.skipFlowGap();
      // An implicit key is on one line (YAML 1.2 §7.4.2).
      if (this.line !== keyLine && this.peek() === ":") {
        throw this.error(
          "MULTILINE_KEY",
          "a flow mapping key must end on the line it starts",
          keyLoc,
          path,
        );
      }
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
      if (char === " " || char === "\t") {
        this.bump();
        continue;
      }
      if (char === "\n" || char === "#") {
        if (char === "#") this.skipComment();
        else this.bump();
        if (this.flowLineStart()) return;
        continue;
      }
      return;
    }
  }

  /**
   * At the start of a line inside a flow collection: its content must be
   * indented past the enclosing block node, with spaces (a tab there is
   * indentation), and it cannot be a document marker. A line that only closes
   * the collection may sit at the holding block's own column.
   *
   * @returns {boolean} True when the cursor is on the line's content.
   */
  flowLineStart() {
    if (this.eof || this.column !== 1) return false;
    if (this.markerAt(this.i)) {
      throw this.error(
        "UNTERMINATED_FLOW",
        "a document marker cannot appear inside a flow collection",
      );
    }
    let spaces = 0;
    while (this.peek() === " ") {
      this.bump();
      spaces += 1;
    }
    const need = this.flowMin ?? 0;
    const char = this.peek();
    if (char === "\t" && spaces < need) {
      throw this.error("TAB_INDENT", "a tab may not be used as indentation; use spaces");
    }
    if (this.eof || char === "\n" || char === "#" || char === "\t") return false;
    if (spaces < need && !((char === "]" || char === "}") && spaces >= need - 1)) {
      throw this.error(
        "BAD_INDENT",
        "a flow collection's lines must be indented past the block that holds it",
      );
    }
    return true;
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
        if (anchor !== null) this.throwDuplicateProperty("anchor");
        this.bump();
        ANCHOR_NAME.lastIndex = this.i;
        const match = ANCHOR_NAME.exec(this.text);
        if (!match) throw this.error("BAD_ANCHOR", "anchor name is missing", loc);
        anchor = match[0];
        for (let count = 0; count < anchor.length; count += 1) this.bump();
        this.assertPropertyEnd();
        this.skipFlowGap();
        continue;
      }
      if (this.peek() === "!") {
        if (tag !== null) this.throwDuplicateProperty("tag");
        tag = this.parseTag();
        this.assertPropertyEnd();
        this.skipFlowGap();
        continue;
      }
      break;
    }
    if (this.peek() === "*") {
      // An alias carries no properties (YAML 1.2 §7.1), in flow as in block.
      if (anchor !== null || tag !== null) {
        throw this.error("ALIAS_DECORATED", "an alias may not carry an anchor or a tag", loc);
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
        if (/[,[\]{}\n]/.test(char)) break;
        if (char === ":" && this.isFlowSeparatorAfter(this.i + 1)) break;
        if (char === "#" && (raw === "" || /[ \t]$/.test(raw))) break;
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
    if ("&*!".includes(this.peek()) && this.peek() !== "") this.throwKeyProperty(loc);
    if (this.peek() === "?" && /^[ \t\n]?$/.test(this.peek(1))) {
      throw this.error(
        "UNSUPPORTED_COMPLEX_KEY",
        "complex mapping keys (`? `) are outside the KYAML subset",
        loc,
      );
    }
    if (this.peek() === "'" || this.peek() === '"') {
      const start = this.i;
      const node = this.parseQuoted(loc);
      this.checkKeyLength(this.text.slice(start, this.i), loc);
      return node;
    }
    let raw = "";
    while (!this.eof) {
      const char = this.peek();
      // A `:` before a safe character is part of the key: `{http://x: 1}`.
      if ((char === ":" && this.isFlowSeparatorAfter(this.i + 1)) || /[,[\]{}\n]/.test(char)) break;
      // A `#` after white space starts a comment, which ends the key's line.
      if (char === "#" && /[ \t]$/.test(raw)) break;
      raw += this.bump();
    }
    // YAML white space is space and tab only (s-white); a no-break space is
    // part of the key.
    raw = raw.replace(/^[ \t]+|[ \t]+$/g, "");
    if (raw === "") throw this.error("EMPTY_KEY", "empty flow mapping key", loc);
    this.checkKeyLength(raw, loc);
    return this.scalarFromRaw(raw, loc, "plain");
  }

  // ── small helpers ────────────────────────────────────────────────────────

  /**
   * Whether the line at the cursor belongs to an enclosing collection rather
   * than to the node at `indent`: left of the node and not past the enclosing
   * line (`- &a` then `- b` is two entries, the first null). At the document
   * root `lineIndent` is -1, so every line belongs to the node. A sequence
   * entry at `seqAt` is the node's own compact sequence (`k:` then `  &a`
   * then `- x`, yaml-test-suite SKE5).
   *
   * @param {number} indent
   * @param {number} lineIndent
   * @param {number|null} seqAt
   * @returns {boolean}
   */
  isEnclosingLine(indent, lineIndent, seqAt) {
    const column = this.column - 1;
    return column < indent && column <= lineIndent && !(seqAt === column && this.isSeqEntry());
  }

  /**
   * An implicit key is at most 1024 characters (YAML 1.2 §7.4.2, §8.2.2),
   * counted in code points over the key itself: a plain key without its
   * trailing blanks, or a quoted key with its quotes.
   *
   * @param {string} text
   * @param {Loc} loc
   * @returns {void}
   */
  checkKeyLength(text, loc) {
    const length = [...text].length;
    if (length > MAX_IMPLICIT_KEY) {
      throw this.error(
        "KEY_TOO_LONG",
        `an implicit mapping key is limited to ${MAX_IMPLICIT_KEY} characters, this one has ${length}`,
        loc,
      );
    }
  }

  /**
   * An anchor or tag is followed by white space before its node (YAML 1.2
   * §6.9): `&a[1]` and `!!seq{}` are not a property and a collection.
   *
   * @returns {void}
   */
  assertPropertyEnd() {
    if (this.peek() === "[" || this.peek() === "{") {
      throw this.error(
        "PROPERTY_SEPARATION",
        "an anchor or tag must be followed by white space before its node",
        this.loc(),
      );
    }
  }

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
