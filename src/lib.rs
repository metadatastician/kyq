// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell
//! Native, bounded structured-data processing. Canonical bytes come from ijson-jcs.
#![forbid(unsafe_code)]
#![deny(missing_docs)]

mod emit;
mod kyaml;
pub use ijson_jcs::Value;

/// Maximum source size, before parsing or evaluating any format.
pub const MAX_INPUT_BYTES: usize = 8 * 1024 * 1024;
/// Maximum expanded YAML nodes.
pub const NODE_BUDGET: usize = 100_000;
/// Conservative storage budget for expanded YAML values and anchor copies.
pub const MAX_EXPANDED_BYTES: usize = 64 * 1024 * 1024;
/// Maximum nested containers.
pub const MAX_DEPTH: usize = 64;
/// Wall-clock limit for one confined Dhall evaluation by the CLI.
pub const DHALL_TIME_LIMIT_MS: u64 = 2_000;
/// Heap limit for the CLI's confined Dhall worker process.
pub const DHALL_MEMORY_LIMIT_BYTES: usize = 256 * 1024 * 1024;
/// Largest evaluated Dhall result the CLI accepts back from its worker.
pub const DHALL_OUTPUT_MAX_BYTES: usize = MAX_EXPANDED_BYTES;

/// Explicit input format; extensions alone never establish content validity.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    /// The repository's restricted YAML profile.
    Kyaml,
    /// Strict I-JSON, including duplicate and integer-token checks.
    Json,
    /// JSON with explicit RFC 8785 binary64 number semantics, including rounding.
    Jcs,
    /// Dhall expressions with imports disabled.
    Dhall,
}

/// A diagnostic with a stable class and one-based source position.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error {
    /// Machine-readable diagnostic class.
    pub code: &'static str,
    /// Human-readable reason.
    pub message: String,
    /// One-based source line.
    pub line: usize,
    /// One-based source column.
    pub column: usize,
    /// JSON Pointer path without its initial slash.
    pub path: String,
}

impl Error {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            line: 1,
            column: 1,
            path: String::new(),
        }
    }
    pub(crate) fn at(mut self, line: usize, column: usize, path: &str) -> Self {
        self.line = line;
        self.column = column;
        self.path = path.to_owned();
        self
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}: {} (line {}, column {}, path /{})",
            self.code, self.message, self.line, self.column, self.path
        )
    }
}
impl std::error::Error for Error {}

/// Enforce the estate R3 restriction on floating-point values whose JCS
/// representation would be an integer token outside the strict safe range.
///
/// Explicit `Format::Jcs` is intentionally excluded: that mode exposes the
/// RFC 8785 binary64 acceptance domain, which differs from estate-strict input.
fn reject_unsafe_float_integer(value: &Value) -> Result<(), Error> {
    match value {
        Value::Number(number) if number.is_f64() => {
            if let Some(number) = number.as_f64() {
                // ECMAScript / RFC 8785 prints integral doubles below 1e21
                // without an exponent. Beyond 2^53-1 those bytes would be
                // rejected by the strict I-JSON reader.
                if number.is_finite()
                    && number.fract() == 0.0
                    && number.abs() >= 9_007_199_254_740_992.0
                    && number.abs() < 1e21
                {
                    return Err(Error::new(
                        "UNSAFE_FLOAT_INTEGER",
                        "integer-shaped floating-point JCS output exceeds the safe integer range",
                    ));
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                reject_unsafe_float_integer(item)?;
            }
        }
        Value::Object(items) => {
            for item in items.values() {
                reject_unsafe_float_integer(item)?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// Validate a TOML 1.0 document without converting its values to JSON.
///
/// This is a *validity-only* operation: datetime, offset, special floating-point
/// values, comments, ordering and the original bytes are never projected or
/// rewritten. Unsupported conversion and querying must be explicitly refused
/// by the CLI rather than silently changing the TOML type domain.
///
/// The parser's syntax profile is pinned to TOML 1.0.0 in Cargo.toml.
pub fn validate_toml(input: &[u8]) -> Result<(), Error> {
    if input.len() > MAX_INPUT_BYTES {
        return Err(Error::new("INPUT_LIMIT", "input exceeds 8 MiB"));
    }
    let text = std::str::from_utf8(input).map_err(|e| Error::new("INVALID_UTF8", e.to_string()))?;
    let _: toml_edit::DocumentMut = text.parse().map_err(|error: toml_edit::TomlError| {
        let mut diagnostic = Error::new("INVALID_TOML", error.to_string());
        if let Some(span) = error.span()
            && let Some(before) = text.get(..span.start)
        {
            let line = before.bytes().filter(|&byte| byte == b'\n').count() + 1;
            let column = before.rsplit('\n').next().unwrap_or("").chars().count() + 1;
            diagnostic = diagnostic.at(line, column, "");
        }
        diagnostic
    })?;
    Ok(())
}

/// Parse a bounded UTF-8 input. JSON/Dhall produce exactly one document.
///
/// Dhall imports (local, environment and remote) are disabled. Evaluation is
/// performed in-process by serde_dhall, which has no time or memory bound.
/// The `kyq` CLI confines it in a worker process (`DHALL_TIME_LIMIT_MS`,
/// `DHALL_MEMORY_LIMIT_BYTES`); a library caller processing untrusted Dhall
/// must impose its own process time/memory limit.
pub fn parse(input: &[u8], format: Format) -> Result<Vec<Value>, Error> {
    if input.len() > MAX_INPUT_BYTES {
        return Err(Error::new("INPUT_LIMIT", "input exceeds 8 MiB"));
    }
    let text = std::str::from_utf8(input).map_err(|e| Error::new("INVALID_UTF8", e.to_string()))?;
    match format {
        Format::Kyaml => {
            let docs = kyaml::parse(text)?;
            for value in &docs {
                reject_unsafe_float_integer(value)?;
            }
            Ok(docs)
        }
        Format::Json => {
            let value = ijson_jcs::parse_json(text, ijson_jcs::JsonMode::Canonical)
                .map_err(|e| Error::new("INVALID_IJSON", e.to_string()))?;
            reject_unsafe_float_integer(&value)?;
            Ok(vec![value])
        }
        Format::Jcs => {
            let value =
                ijson_jcs::parse_jcs(text).map_err(|e| Error::new("INVALID_JCS", e.to_string()))?;
            Ok(vec![value])
        }
        Format::Dhall => {
            let value: Value = serde_dhall::from_str(text)
                .imports(false)
                .parse()
                .map_err(|e| Error::new("INVALID_DHALL", e.to_string()))?;
            ijson_jcs::validate_canonicalizable(&value)
                .map_err(|e| Error::new("INVALID_IJSON", e.to_string()))?;
            Ok(vec![value])
        }
    }
}

/// Return RFC 8785 bytes for exactly one document, without a final LF.
///
/// ```
/// use kyq::{canonicalize, Format};
/// assert_eq!(canonicalize(b"b: true\na: 2\n", Format::Kyaml)?,
///            br#"{"a":2,"b":true}"#);
/// # Ok::<(), kyq::Error>(())
/// ```
pub fn canonicalize(input: &[u8], format: Format) -> Result<Vec<u8>, Error> {
    let docs = parse(input, format)?;
    canonicalize_documents(&docs)
}

/// Canonicalize an already parsed stream, requiring exactly one document.
/// This avoids repeating Dhall evaluation when a caller also inspects values.
pub fn canonicalize_documents(docs: &[Value]) -> Result<Vec<u8>, Error> {
    if docs.is_empty() {
        return Err(Error::new(
            "EMPTY_STREAM",
            "canonicalization requires a document",
        ));
    }
    if docs.len() != 1 {
        return Err(Error::new(
            "MULTI_DOC_STREAM",
            "canonicalization requires exactly one document",
        ));
    }
    ijson_jcs::to_jcs(&docs[0]).map_err(|e| Error::new("INVALID_IJSON", e.to_string()))
}

/// Emit deterministic block-style KYAML, preserving mapping insertion order.
/// Comments, anchors and tags are omitted after semantic resolution.
/// Refuses R3-unsafe floating-point values rather than emitting a KYAML stream
/// that the strict reader would reject on re-ingestion.
pub fn format_documents(docs: &[Value]) -> Result<Vec<u8>, Error> {
    for value in docs {
        reject_unsafe_float_integer(value)?;
    }
    emit::format(docs)
}
/// Query every document with an RFC 6901 JSON Pointer.
pub fn query<'a>(docs: &'a [Value], pointer: &str) -> Result<Vec<&'a Value>, Error> {
    if !pointer.is_empty() && !pointer.starts_with('/') {
        return Err(Error::new(
            "INVALID_POINTER",
            "a nonempty pointer must start with /",
        ));
    }
    let mut characters = pointer.chars();
    while let Some(character) = characters.next() {
        if character == '~' && !matches!(characters.next(), Some('0' | '1')) {
            return Err(Error::new(
                "INVALID_POINTER",
                "pointer escapes must be ~0 or ~1",
            ));
        }
    }
    docs.iter()
        .map(|doc| {
            doc.pointer(pointer)
                .ok_or_else(|| Error::new("MISSING_PATH", format!("no value at {pointer:?}")))
        })
        .collect()
}

/// The leading header comment block of a KYAML stream (KYAML_SPEC §7.3):
/// every comment and blank line before the first content line, verbatim, and
/// the number of lines it spans. A prefix with no comment is not a header.
/// A leading BOM is not part of the header.
fn header_block(text: &str) -> (&str, usize) {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let (mut end, mut lines, mut saw_comment) = (0usize, 0usize, false);
    while end < text.len() {
        let rest = &text[end..];
        let line_len = rest.find('\n').map_or(rest.len(), |n| n + 1);
        let line = rest[..line_len].trim_end_matches(['\n', '\r']);
        let body = line.trim_start_matches([' ', '\t']);
        let comment = body.starts_with('#');
        if !comment && !body.is_empty() {
            break;
        }
        saw_comment |= comment;
        end += line_len;
        lines += 1;
    }
    if saw_comment {
        (&text[..end], lines)
    } else {
        ("", 0)
    }
}

/// The canonical file text of a KYAML input: the header comment block
/// verbatim (with a final LF if it has none), then the formatted body.
/// `check` accepts exactly these bytes and `fix` writes them, so
/// `check(fix(x))` succeeds by construction.
fn kyaml_file_text(input: &[u8], refuse_lost_comments: bool) -> Result<Vec<u8>, Error> {
    let docs = parse(input, Format::Kyaml)?;
    for doc in &docs {
        ijson_jcs::validate_canonicalizable(doc)
            .map_err(|e| Error::new("INVALID_IJSON", e.to_string()))?;
    }
    // parse() accepted the input, so it is UTF-8.
    let text = std::str::from_utf8(input).map_err(|e| Error::new("INVALID_UTF8", e.to_string()))?;
    let (header, header_lines) = header_block(text);
    if refuse_lost_comments
        && let Some((line, column)) = kyaml::first_lost_comment(text, header_lines)
    {
        return Err(Error::new(
            "COMMENTS_WOULD_BE_LOST",
            "formatting would drop this comment (only the leading header comment block is kept); move it into the header or remove it",
        )
        .at(line, column, ""));
    }
    let mut output = header.as_bytes().to_vec();
    if !output.is_empty() && !output.ends_with(b"\n") {
        output.push(b'\n');
    }
    output.extend(format_documents(&docs)?);
    Ok(output)
}

/// The exact bytes a canonical file holds for `format`: the KYAML header
/// block plus formatted body, or JCS plus one LF for JSON and JCS.
/// Dhall has no canonical file form here.
pub fn canonical_file(input: &[u8], format: Format) -> Result<Vec<u8>, Error> {
    match format {
        Format::Kyaml => kyaml_file_text(input, false),
        Format::Json | Format::Jcs => {
            let mut bytes = canonicalize(input, format)?;
            bytes.push(b'\n');
            Ok(bytes)
        }
        Format::Dhall => Err(Error::new(
            "UNSUPPORTED_OPERATION",
            "Dhall has no canonical file form; use validate",
        )),
    }
}

/// The bytes `fix` writes for `input`, or a typed refusal.
///
/// Like [`canonical_file`], but a KYAML comment outside the leading header
/// block is refused with `COMMENTS_WOULD_BE_LOST` instead of being dropped,
/// and a result over [`MAX_INPUT_BYTES`] is refused, so `fix` never writes a
/// file the gate would then reject.
pub fn fix_bytes(input: &[u8], format: Format) -> Result<Vec<u8>, Error> {
    let output = match format {
        Format::Kyaml => kyaml_file_text(input, true)?,
        _ => canonical_file(input, format)?,
    };
    if output.len() > MAX_INPUT_BYTES {
        return Err(Error::new(
            "INPUT_LIMIT",
            "the fixed file would exceed 8 MiB",
        ));
    }
    Ok(output)
}
