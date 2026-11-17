// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell (hyperpolymath) <j.d.a.jewell@open.ac.uk>
//
// Test-time translation validation (TV) for `canon`. UNVERIFIED: this is the
// executable design of the later verified Idris2 checker (design §8.3 P4).
// It imports NOTHING from conformance/src: every rule is restated here from
// the RFCs and the KYAML spec, so a bug in the gate's JavaScript is not a bug
// here. That is independence of SOURCE CODE only. The shared trust base is the
// runtime: Number() (decimal to double), Number#toString (shortest round-trip,
// used by jcs() below and by the gate's esNumberToString), TextDecoder, and
// UTF-16 string comparison. A bug in any of those is common-mode; node and bun
// agreeing only partly covers it. The float-closure test in number() is the
// same expression the gate uses, restated. P4 (Idris2) must bring its own
// shortest-round-trip printer and derive the closure rule itself; an optional
// cross-check against the RFC 8785 Appendix B number vectors is in
// test/tv.test.js.
//
// Statement (CORRECTIONS L1): tv(in, out) = OK  <=>  in ∈ Dom  ∧  out = c(p in)
//   (i)   out is strict I-JSON (RFC 8259 + RFC 7493), re-parsed independently;
//   (ii)  out is JCS-canonical: re-serialising its value gives the same bytes;
//   (iii) out's value equals an independent parse of `in`, and `in` ∈ Dom.
// (iii) is available for JSON inputs and for the KYAML *flow profile*. For any
// other KYAML input (block style: nearly all real files) only (i)+(ii) run and
// the result is CERT-ONLY: `tv()` returns `{semantic: false}` and checks
// neither conjunct of the statement above. Callers must read `semantic`; a
// normal return is not an OK for `in ∈ Dom ∧ out = c(p in)` unless it is true.
// Dom = strict input, R3 budgets (depth 127, 500 000 nodes, 8 MiB string
// bytes) and R3 float closure (no integer-shaped float outside ±(2^53−1)).

const DEPTH = 127, NODES = 500000, BYTES = 8 * 1024 * 1024, SAFE = 9007199254740991n;

/** kind: "profile" (outside the semantic profile), "domain" (in ∉ Dom), "output", "semantic". */
export class TvError extends Error {
  constructor(kind, message) { super(`TV ${kind}: ${message}`); this.kind = kind; }
}
const no = (kind, message) => { throw new TvError(kind, message); };

function utf8Bytes(s) {
  let n = 0;
  for (const ch of s) { const c = ch.codePointAt(0); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; }
  return n;
}
function checkText(s, kind) {
  for (let k = 0; k < s.length; k += 1) {
    const c = s.charCodeAt(k);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(k + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) no(kind, "lone surrogate");
      if ((((c - 0xd800) << 10) + (d - 0xdc00) + 0x10000 & 0xfffe) === 0xfffe) no(kind, "noncharacter");
      k += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) no(kind, "lone surrogate");
    else if ((c >= 0xfdd0 && c <= 0xfdef) || c === 0xfffe || c === 0xffff) no(kind, "noncharacter");
  }
}
function number(token, isInt, kind) {
  if (isInt) { const b = BigInt(token); if (b > SAFE || b < -SAFE) no(kind, `unsafe integer ${token}`); return Number(b); }
  const x = Number(token);
  if (!Number.isFinite(x)) no(kind, `non-finite ${token}`);
  if (!Number.isSafeInteger(x) && /^-?[0-9]+$/.test(String(x))) no(kind, `float ${token} prints as an unsafe integer`);
  return x;
}
/** Dom budgets on a value (Map, array, string, number, boolean, null). */
export function measure(v, kind = "domain") {
  let nodes = 0, bytes = 0;
  const walk = (x, depth) => {
    nodes += 1;
    if (typeof x === "string") bytes += utf8Bytes(x);
    else if (Array.isArray(x) || x instanceof Map) {
      if (depth + 1 > DEPTH) no(kind, "depth over 127");
      for (const [k, y] of x instanceof Map ? x : x.entries()) { if (x instanceof Map) bytes += utf8Bytes(k); walk(y, depth + 1); }
    }
  };
  walk(v, 0);
  if (nodes > NODES) no(kind, "over 500000 nodes");
  if (bytes > BYTES) no(kind, "over 8 MiB of string bytes");
}

/** Strict I-JSON reader. `kind` names the failure ("domain" for in, "output" for out). */
export function readJson(bytes, kind) {
  let s;
  try { s = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { no(kind, "not UTF-8"); }
  let i = 0;
  const ws = () => { while (" \t\n\r".includes(s[i]) && i < s.length) i += 1; };
  const str = () => {
    let out = "";
    for (i += 1; ; ) {
      if (i >= s.length) no(kind, "unterminated string");
      const c = s[i++];
      if (c === '"') break;
      if (c < " ") no(kind, "raw control character");
      if (c !== "\\") { out += c; continue; }
      const e = s[i++];
      const simple = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }[e];
      if (simple !== undefined) out += simple;
      else if (e === "u" && /^[0-9a-fA-F]{4}$/.test(s.slice(i, i + 4))) { out += String.fromCharCode(parseInt(s.slice(i, i + 4), 16)); i += 4; }
      else no(kind, "bad escape");
    }
    checkText(out, kind);
    return out;
  };
  const NUM = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?/y;
  const val = (depth) => {
    ws();
    const c = s[i];
    if (c === "{" || c === "[") {
      if (depth >= DEPTH) no(kind, "depth over 127");
      i += 1; ws();
      const close = c === "{" ? "}" : "]", out = c === "{" ? new Map() : [];
      if (s[i] === close) { i += 1; return out; }
      for (;;) {
        if (c === "{") {
          ws(); if (s[i] !== '"') no(kind, "key must be a string");
          const k = str(); if (out.has(k)) no(kind, `duplicate key ${JSON.stringify(k)}`);
          ws(); if (s[i++] !== ":") no(kind, "expected :");
          out.set(k, val(depth + 1));
        } else out.push(val(depth + 1));
        ws(); const d = s[i++];
        if (d === close) return out;
        if (d !== ",") no(kind, "expected , or close");
      }
    }
    if (c === '"') return str();
    for (const [w, v] of [["true", true], ["false", false], ["null", null]]) if (s.startsWith(w, i)) { i += w.length; return v; }
    NUM.lastIndex = i; const m = NUM.exec(s);
    if (!m) no(kind, `unexpected character at ${i}`);
    i = NUM.lastIndex;
    return number(m[0], !m[1] && !m[2], kind);
  };
  const v = val(0); ws();
  if (i !== s.length) no(kind, "trailing characters");
  measure(v, kind);
  return v;
}

/** The KYAML flow profile (KEP-5295 shape). Returns the documents' values. */
export function readKyamlFlow(bytes) {
  let s;
  try { s = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { no("domain", "not UTF-8"); }
  s = s.replaceAll("\r\n", "\n");
  if (/[\r\t\u0000-\u0008\u000b-\u001f\u007f-\u009f﻿]/.test(s)) no("profile", "tab, CR, control or BOM");
  let i = 0;
  const gap = () => {
    for (;;) {
      if (s[i] === " " || s[i] === "\n") i += 1;
      else if (s[i] === "#" && (i === 0 || s[i - 1] === " " || s[i - 1] === "\n")) while (i < s.length && s[i] !== "\n") i += 1;
      else return;
    }
  };
  const dq = () => {
    let out = "";
    for (i += 1; ; ) {
      const c = s[i++];
      if (c === undefined || c === "\n") no("profile", "multi-line or unterminated quoted scalar");
      if (c === '"') break;
      if (c !== "\\") { out += c; continue; }
      const e = s[i++];
      const simple = { 0: "\0", a: "\x07", b: "\b", t: "\t", n: "\n", v: "\v", f: "\f", r: "\r", e: "\x1b", " ": " ",
        '"': '"', "/": "/", "\\": "\\", N: "\u0085", _: " ", L: " ", P: " " }[e];
      if (simple !== undefined) { out += simple; continue; }
      const w = { x: 2, u: 4, U: 8 }[e], h = s.slice(i, i + (w ?? 0));
      if (!w || !new RegExp(`^[0-9a-fA-F]{${w}}$`).test(h)) no("profile", "unknown escape");
      const cp = parseInt(h, 16);
      if (cp > 0x10ffff) no("profile", "escape beyond U+10FFFF");
      // Every surrogate escape is outside Dom, a pair included. The spec says
      // only that lone ones are LONE_SURROGATE; the gate refuses pairs too.
      // PENDING OWNER RULING (open question in KYAML_SPEC.adoc): whether an
      // escaped pair such as \uD83D\uDE00 is legal. TV mirrors the gate now.
      if (cp >= 0xd800 && cp <= 0xdfff) no("domain", "surrogate escape");
      out += String.fromCodePoint(cp);
      i += w;
    }
    checkText(out, "domain");
    return out;
  };
  // A flow plain scalar ends only at `,` `[` `]` `{` `}`, `: `, ` #` or end of
  // line (KYAML_SPEC). Take it whole first; only a single token of the profile
  // alphabet is judged, anything else (interior spaces, glued colons) is
  // outside the profile and is never resolved.
  // In block context (a top-level document) the flow indicators are ordinary
  // characters: the scalar runs to `: `, ` #` or the end of the line.
  const plain = (flow) => {
    const from = i;
    while (i < s.length && s[i] !== "\n" && !(flow && ",[]{}".includes(s[i]))) {
      if (s[i] === ":" && (i + 1 === s.length || " \n".includes(s[i + 1]) || (flow && ",[]{}".includes(s[i + 1])))) break;
      if (s[i] === "#" && i > from && s[i - 1] === " ") break;
      i += 1;
    }
    const token = s.slice(from, i).replace(/ +$/, "");
    if (token === "") no("profile", `unexpected ${JSON.stringify(s[i])}`);
    if (!/^[-+.0-9A-Za-z_~]+$/.test(token)) no("profile", "plain scalar outside the profile");
    return token;
  };
  const resolve = (t) => {
    if (/^(null|Null|NULL|~)$/.test(t)) return null;
    if (/^(true|True|TRUE)$/.test(t)) return true;
    if (/^(false|False|FALSE)$/.test(t)) return false;
    if (/^[-+]?[0-9]+$/.test(t)) return number(t.replace(/^\+/, ""), true, "domain");
    if (/^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(t)) return number(t, false, "domain");
    if (/^[-+]?\.(inf|Inf|INF)$|^\.(nan|NaN|NAN)$/.test(t)) no("domain", "non-finite");
    if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(t) && !/^[-+.0-9]/.test(t)) return { plainString: t };
    no("profile", `plain scalar ${t}`);
  };
  const val = (depth) => {
    gap();
    const c = s[i];
    if (c === "[" || c === "{") {
      if (depth >= DEPTH) no("domain", "depth over 127");
      i += 1;
      const close = c === "{" ? "}" : "]", out = c === "{" ? new Map() : [];
      for (;;) {
        gap();
        if (s[i] === close) { i += 1; return out; }
        if (c === "[") out.push(val(depth + 1));
        else {
          let k;
          if (s[i] === '"') k = dq();
          else { k = resolve(plain(true)); if (typeof k?.plainString !== "string") no("domain", "non-string key"); k = k.plainString; }
          // An implicit key is on one line: only spaces may precede its `:`.
          while (s[i] === " ") i += 1;
          if (s[i] !== ":") { gap(); if (s[i] === ":") no("domain", "implicit key spans lines"); no("profile", "expected :"); }
          i += 1;
          if (out.has(k)) no("domain", `duplicate key ${JSON.stringify(k)}`);
          out.set(k, val(depth + 1));
        }
        gap();
        if (s[i] === ",") i += 1;
        else if (s[i] !== close) no("profile", "expected , or close");
      }
    }
    if (c === '"') return dq();
    if (c === "'" || c === "&" || c === "*" || c === "!" || c === "|" || c === ">" || c === "-" && s[i + 1] === " ") no("profile", "quote style, anchor, alias, tag or block syntax");
    const r = resolve(plain(depth > 0));
    if (r?.plainString !== undefined) no("profile", "unquoted string value");
    return r;
  };
  const marker = () => (i === 0 || s[i - 1] === "\n") && s.startsWith("---", i) && (i + 3 === s.length || s[i + 3] === "\n");
  const docs = [];
  gap();
  while (i < s.length) {
    if (marker()) {
      i += 3; gap();
      if (i === s.length || marker()) { docs.push(null); continue; }
    } else if (docs.length > 0) no("profile", "second document without ---");
    docs.push(val(0)); gap();
    if (i < s.length && !marker()) no("profile", "content after the document");
  }
  return docs;
}

const ESC = { '"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t" };
const quote = (t) => `"${t.replace(/["\\\u0000-\u001f]/g, (c) => ESC[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}"`;
/** RFC 8785 serialisation, written from the RFC (UTF-16 key order, ES numbers). */
export function jcs(v) {
  if (v === null || v === true || v === false) return String(v);
  if (typeof v === "number") return Object.is(v, -0) ? "0" : String(v);
  if (typeof v === "string") return quote(v);
  if (Array.isArray(v)) return `[${v.map(jcs).join(",")}]`;
  return `{${[...v.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((k) => `${quote(k)}:${jcs(v.get(k))}`).join(",")}}`;
}
/** Structural equality on the data model; numbers as doubles (so -0 = 0). */
export function sameValue(a, b, path = "") {
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) return a.forEach((x, k) => sameValue(x, b[k], `${path}/${k}`));
  if (a instanceof Map && b instanceof Map && a.size === b.size) {
    for (const [k, x] of a) { if (!b.has(k)) no("semantic", `missing key at ${path}/${k}`); sameValue(x, b.get(k), `${path}/${k}`); }
    return;
  }
  if (a !== b || typeof a === "object" && a !== null) no("semantic", `value differs at ${path || "/"}`);
}

/** The KYAML expected value: one document, or the stream as an array. */
function expectedYaml(input, array) {
  const docs = readKyamlFlow(input);
  if (docs.length === 0) no("domain", "empty stream");
  if (docs.length > 1 && !array) no("domain", "multi-document stream without --array");
  const v = docs.length === 1 ? docs[0] : docs;
  measure(v);
  return v;
}
/**
 * tv(in, out). Throws TvError on any detected fault. Returns
 * `{semantic: true, level: "semantic"}` when all of (i), (ii), (iii) ran, and
 * `{semantic: false, level: "cert"}` when only (i)+(ii) ran (block-style
 * KYAML): that is NOT the TV theorem and must not be reported as a pass of it.
 */
export function tv(input, output, format, { array = false } = {}) {
  const out = readJson(output, "output"); // (i)
  if (jcs(out) !== new TextDecoder().decode(output)) no("output", "bytes are not JCS-canonical"); // (ii)
  let expected;
  try { expected = format === "json" ? readJson(input, "domain") : expectedYaml(input, array); } catch (error) {
    if (error instanceof TvError && error.kind === "profile") return { semantic: false, level: "cert" };
    throw error;
  }
  sameValue(expected, out); // (iii)
  return { semantic: true, level: "semantic" };
}
/** For a refused input: "domain" when TV agrees in ∉ Dom, "profile" when TV cannot tell. Throws if in ∈ Dom. */
export function tvRefusal(input, format, { array = false } = {}) {
  try { format === "json" ? readJson(input, "domain") : expectedYaml(input, array); } catch (error) {
    if (error instanceof TvError && (error.kind === "domain" || error.kind === "profile")) return error.kind;
    throw error;
  }
  no("semantic", "the gate refused an input in Dom");
}
