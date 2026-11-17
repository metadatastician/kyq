// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell
use crate::{Error, MAX_DEPTH, MAX_EXPANDED_BYTES, NODE_BUDGET, Value};
use regex::Regex;
use std::{collections::HashMap, sync::LazyLock};
use yaml_rust2::{
    parser::{Event, Parser, Tag},
    scanner::{Marker, ScanError, Scanner, TScalarStyle, TokenType},
};

static INTEGER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[-+]?[0-9]+$").unwrap());
static OCTAL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^0o[0-7]+$").unwrap());
static HEX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^0x[0-9a-fA-F]+$").unwrap());
static FLOAT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$").unwrap());

fn is_nonfinite(text: &str) -> bool {
    matches!(
        text,
        ".inf"
            | ".Inf"
            | ".INF"
            | "+.inf"
            | "+.Inf"
            | "+.INF"
            | "-.inf"
            | "-.Inf"
            | "-.INF"
            | ".nan"
            | ".NaN"
            | ".NAN"
    )
}

pub(crate) fn plain_is_string(text: &str) -> bool {
    ![
        "", "~", "null", "Null", "NULL", "true", "True", "TRUE", "false", "False", "FALSE",
    ]
    .contains(&text)
        && !INTEGER.is_match(text)
        && !OCTAL.is_match(text)
        && !HEX.is_match(text)
        && !FLOAT.is_match(text)
        && !is_nonfinite(text)
}

fn located(code: &'static str, message: impl Into<String>, m: Marker, path: &str) -> Error {
    Error::new(code, message).at(m.line(), m.col() + 1, path)
}
fn pointer(parent: &str, key: &str) -> String {
    let key = key.replace('~', "~0").replace('/', "~1");
    if parent.is_empty() {
        key
    } else {
        format!("{parent}/{key}")
    }
}

// A scanner can reject a second colon while looking ahead, before delivering
// even the enclosing mapping event. Replay only the complete prefix to recover
// its path; decoding keys through the same parser handles quotes and escapes.
// This pass builds no values and has the same depth/node bounds as the reader.
fn path_before(text: &str, index: usize) -> Option<String> {
    struct Frame {
        path: String,
        mapping: bool,
        key: Option<String>,
        next_index: usize,
    }
    let prefix: String = text.chars().take(index).collect();
    let mut parser = Parser::new_from_str(&prefix);
    let mut frames: Vec<Frame> = Vec::new();
    let mut last = String::new();
    for _ in 0..NODE_BUDGET {
        let (event, _) = parser.next_token().ok()?;
        match event {
            Event::StreamEnd => return Some(last),
            Event::StreamStart | Event::DocumentStart | Event::DocumentEnd => continue,
            Event::MappingEnd | Event::SequenceEnd => {
                frames.pop()?;
                continue;
            }
            _ => {}
        }
        let path = if let Some(frame) = frames.last_mut() {
            if frame.mapping {
                if let Some(key) = frame.key.take() {
                    pointer(&frame.path, &key)
                } else if let Event::Scalar(key, _, _, _) = event {
                    frame.key = Some(key);
                    continue;
                } else {
                    return None;
                }
            } else {
                let path = pointer(&frame.path, &frame.next_index.to_string());
                frame.next_index += 1;
                path
            }
        } else {
            String::new()
        };
        if matches!(
            event,
            Event::MappingStart(_, _) | Event::SequenceStart(_, _)
        ) {
            if frames.len() >= MAX_DEPTH {
                return None;
            }
            frames.push(Frame {
                path: path.clone(),
                mapping: matches!(event, Event::MappingStart(_, _)),
                key: None,
                next_index: 0,
            });
        }
        last = path;
    }
    None
}

/// Character offsets for yaml-rust2 markers.
///
/// yaml-rust2 (0.11.1 through at least 0.13.0) advances `Marker::index` and
/// `Marker::col` by UTF-8 *bytes* across block-scalar content lines but by
/// *chars* everywhere else, so `index` can overshoot the input. `line` is
/// exact. `col` is exact except after block-scalar content, where the true
/// position is the end of that line. Deriving the offset from `line` and
/// clamping `col` to the line end therefore recovers the exact character
/// offset, and the result is always `<= len`.
#[derive(Debug, Default)]
struct Positions {
    line_starts: Vec<usize>,
    len: usize,
}

impl Positions {
    fn new(chars: &[char]) -> Self {
        let line_starts = std::iter::once(0)
            .chain(
                chars
                    .iter()
                    .enumerate()
                    .filter(|(_, c)| **c == '\n')
                    .map(|(i, _)| i + 1),
            )
            .collect();
        Self {
            line_starts,
            len: chars.len(),
        }
    }

    /// Character offset of `m`, in `0..=len`.
    fn index(&self, m: Marker) -> usize {
        let Some(&start) = self.line_starts.get(m.line().saturating_sub(1)) else {
            return self.len;
        };
        let end = self
            .line_starts
            .get(m.line())
            .map_or(self.len, |next| next - 1);
        start.saturating_add(m.col()).min(end)
    }
}

fn syntax_error(error: ScanError, text: &str, path: &str) -> Error {
    let message = error.to_string();
    let m = *error.marker();
    let chars: Vec<char> = text.chars().collect();
    let at = Positions::new(&chars).index(m);
    let source = text.lines().nth(m.line() - 1).unwrap_or("");
    let indent = source.chars().take_while(|c| *c == ' ').count();
    if message.contains("tabs disallowed") {
        return Error::new("TAB_INDENT", message).at(m.line(), indent + 1, "");
    }
    if message.contains("while parsing a block mapping, did not find expected key") {
        let code = if source.trim_start_matches(' ').starts_with("- ") {
            "MIXED_COLLECTION"
        } else {
            "UNEXPECTED_INDENT"
        };
        return Error::new(code, message).at(m.line(), indent + 1, "");
    }
    if message.contains("simple key expect ':'")
        && let Some((line, source)) = text
            .lines()
            .enumerate()
            .take(m.line())
            .filter(|(_, s)| !s.trim().is_empty() && !s.trim_start().starts_with('#'))
            .last()
    {
        return Error::new("MISSING_COLON", message).at(
            line + 1,
            source.chars().take_while(|c| *c == ' ').count() + 1,
            "",
        );
    }
    if message.contains("mapping values are not allowed") {
        let prefix: String = source.chars().take(m.col()).collect();
        let key = prefix.trim_start_matches(' ').trim_end_matches([' ', '\t']);
        let mut key_tokens = Scanner::new(key.chars())
            .filter(|token| !matches!(token.1, TokenType::StreamStart(_) | TokenType::StreamEnd));
        let one_scalar = matches!(
            key_tokens.next(),
            Some(yaml_rust2::scanner::Token(_, TokenType::Scalar(_, _)))
        ) && key_tokens.next().is_none();
        if key.chars().count() > 1024 && one_scalar {
            return Error::new("KEY_TOO_LONG", message).at(m.line(), indent + 1, "");
        }
    }
    let code = if message.contains("unknown anchor") {
        "UNKNOWN_ANCHOR"
    } else if message.contains("comments must be separated") {
        "BAD_COMMENT"
    } else if message.contains("wrongly indented line in block scalar") {
        "BAD_BLOCK_SCALAR"
    } else if message.contains("duplicate version directive") {
        "DUPLICATE_DIRECTIVE"
    } else if message.contains("expected <document start>") {
        "MISSING_DOC_START"
    } else if message.contains("invalid indentation in flow") {
        "BAD_INDENT"
    } else if message.contains("tabs")
        || message.contains("must be followed by a valid YAML whitespace")
    {
        "TAB_INDENT"
    } else if message.contains("while scanning a tag") {
        let suffix = &chars[at..];
        if let Some(end) = suffix
            .iter()
            .position(|c| matches!(c, '[' | '{' | ',' | ' ' | '\t' | '\n'))
        {
            let code = if matches!(suffix[end], '[' | '{') {
                "PROPERTY_SEPARATION"
            } else {
                "PLAIN_INDICATOR"
            };
            return Error::new(code, message).at(m.line(), m.col() + end + 1, "");
        }
        "YAML_SYNTAX"
    } else if message.contains("invalid Unicode character escape") {
        // The dependency reports the opening quote. The public contract points
        // at the escape letter whose numeric value is not a Unicode scalar.
        let mut index = at + 1;
        while index < chars.len() && chars[index] != '\n' {
            if chars[index] == '\\' {
                let digits = match chars.get(index + 1) {
                    Some('u') => 4,
                    Some('U') => 8,
                    _ => 0,
                };
                let end = index + 2 + digits;
                if digits != 0 && end <= chars.len() {
                    let hex: String = chars[index + 2..end].iter().collect();
                    if u32::from_str_radix(&hex, 16).is_ok_and(|n| (0xd800..=0xdfff).contains(&n)) {
                        return Error::new("LONE_SURROGATE", message).at(
                            m.line(),
                            m.col() + index - at + 2,
                            "",
                        );
                    }
                }
                index += 1;
            }
            index += 1;
        }
        "BAD_ESCAPE"
    } else if message.contains("unknown escape") || message.contains("expected escape sequence") {
        "BAD_ESCAPE"
    } else if message.contains("unexpected character")
        || message.contains("block sequence entries are not allowed")
        || message.contains("mapping keys are not allowed")
        || message.contains("only valid inside a block")
    {
        "PLAIN_INDICATOR"
    } else if message.contains("expected ',' or") {
        if at >= chars.len() {
            "UNTERMINATED_FLOW"
        } else {
            "FLOW_SEPARATOR"
        }
    } else if chars
        .get(at..at.saturating_add(3))
        .is_some_and(|s| s == ['-', '-', '-'] || s == ['.', '.', '.'])
    {
        "UNTERMINATED_FLOW"
    } else if chars.get(at) == Some(&',') {
        "EMPTY_VALUE"
    } else if message.contains("mapping values are not allowed") {
        "MAPPING_IN_VALUE"
    } else if message.contains("expected '-' indicator") {
        "UNEXPECTED_CONTENT"
    } else {
        "YAML_SYNTAX"
    };
    let lexical = matches!(
        code,
        "BAD_COMMENT"
            | "BAD_BLOCK_SCALAR"
            | "DUPLICATE_DIRECTIVE"
            | "MISSING_DOC_START"
            | "BAD_INDENT"
            | "TAB_INDENT"
            | "BAD_ESCAPE"
            | "PLAIN_INDICATOR"
            | "UNEXPECTED_CONTENT"
    );
    let recovered = if code == "MAPPING_IN_VALUE" {
        path_before(text, at)
    } else {
        None
    };
    located(
        code,
        message,
        m,
        if lexical {
            ""
        } else {
            recovered.as_deref().unwrap_or(path)
        },
    )
}
fn check_tag(tag: &Option<Tag>, expected: &str, m: Marker, path: &str) -> Result<(), Error> {
    if let Some(tag) = tag {
        if tag.handle.is_empty() && tag.suffix == "!" && expected.is_empty() {
            return Ok(());
        }
        if tag.handle != "tag:yaml.org,2002:" && tag.handle != "!!" {
            return Err(located(
                "UNSUPPORTED_TAG",
                "application tags are not KYAML",
                m,
                path,
            ));
        }
        if !["str", "int", "float", "null", "bool", "map", "seq"].contains(&tag.suffix.as_str()) {
            return Err(located("UNSUPPORTED_TAG", "unknown core tag", m, path));
        }
        if !expected.is_empty() && tag.suffix != expected {
            return Err(located(
                "TAG_KIND_MISMATCH",
                "tag does not match collection",
                m,
                path,
            ));
        }
    }
    Ok(())
}
fn scalar(
    text: &str,
    style: TScalarStyle,
    tag: &Option<Tag>,
    m: Marker,
    tag_mark: Marker,
    path: &str,
) -> Result<Value, Error> {
    check_tag(tag, "", tag_mark, path)?;
    let forced = tag.as_ref().map(|t| {
        if t.handle.is_empty() && t.suffix == "!" {
            "str"
        } else {
            t.suffix.as_str()
        }
    });
    if forced == Some("map") || forced == Some("seq") {
        return Err(located(
            "TAG_KIND_MISMATCH",
            "collection tag on scalar",
            tag_mark,
            path,
        ));
    }
    // Resolve explicit tags before applying the I-JSON representation limits.
    // Core float accepts decimal integers, but not octal/hexadecimal integers.
    let decimal_float = forced == Some("float") && FLOAT.is_match(text);
    if let Some(expected) = forced.filter(|tag| *tag != "str") {
        let resolved = if ["", "~", "null", "Null", "NULL"].contains(&text) {
            "null"
        } else if ["true", "True", "TRUE", "false", "False", "FALSE"].contains(&text) {
            "bool"
        } else if INTEGER.is_match(text) || OCTAL.is_match(text) || HEX.is_match(text) {
            "int"
        } else if FLOAT.is_match(text) || is_nonfinite(text) {
            "float"
        } else {
            "str"
        };
        if expected != resolved && !decimal_float {
            return Err(located(
                "TAG_VALUE_MISMATCH",
                "scalar does not match its tag",
                tag_mark,
                path,
            ));
        }
    }
    let value = if forced == Some("str") || (forced.is_none() && style != TScalarStyle::Plain) {
        Value::String(text.to_owned())
    } else if ["", "~", "null", "Null", "NULL"].contains(&text) {
        Value::Null
    } else if ["true", "True", "TRUE", "false", "False", "FALSE"].contains(&text) {
        Value::Bool(text.eq_ignore_ascii_case("true"))
    } else if (INTEGER.is_match(text) || OCTAL.is_match(text) || HEX.is_match(text))
        && !decimal_float
    {
        let parsed = if let Some(digits) = text.strip_prefix("0o") {
            i128::from_str_radix(digits, 8)
        } else if let Some(digits) = text.strip_prefix("0x") {
            i128::from_str_radix(digits, 16)
        } else {
            text.parse::<i128>()
        };
        let number = parsed.map_err(|_| {
            located(
                "UNSAFE_INTEGER",
                "integer exceeds the I-JSON safe range",
                m,
                path,
            )
        })?;
        if !(-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&number) {
            return Err(located(
                "UNSAFE_INTEGER",
                "integer exceeds the I-JSON safe range",
                m,
                path,
            ));
        }
        Value::from(number as i64)
    } else if FLOAT.is_match(text) {
        let number = text
            .parse::<f64>()
            .map_err(|_| located("NON_FINITE_NUMBER", "invalid float", m, path))?;
        Value::Number(
            serde_json::Number::from_f64(number)
                .ok_or_else(|| located("NON_FINITE_NUMBER", "non-finite number", m, path))?,
        )
    } else if is_nonfinite(text) {
        return Err(located("NON_FINITE_NUMBER", "non-finite number", m, path));
    } else {
        Value::String(text.to_owned())
    };
    ijson_jcs::validate_canonicalizable(&value)
        .map_err(|e| located("INVALID_IJSON", e.to_string(), m, path))?;
    Ok(value)
}

#[derive(Default)]
struct Lexical {
    positions: Positions,
    tags: HashMap<usize, Marker>,
    key_errors: HashMap<usize, Error>,
}

fn lexical_checks(text: &str) -> Result<Lexical, Error> {
    let mut lexical = Lexical::default();
    for (line, source) in text.split('\n').enumerate() {
        let trimmed = source.trim();
        let directive = trimmed
            .split_once(" #")
            .map_or(trimmed, |(head, _)| head)
            .trim_end_matches([' ', '\t']);
        if source.starts_with("%YAML ") && directive != "%YAML 1.2" {
            return Err(
                Error::new("UNSUPPORTED_VERSION", "only YAML 1.2 is supported").at(line + 1, 1, ""),
            );
        }
        if source.starts_with('%') && !trimmed.starts_with("%YAML ") {
            return Err(
                Error::new("UNSUPPORTED_DIRECTIVE", "unsupported directive").at(line + 1, 1, ""),
            );
        }
    }
    let source_lines: Vec<&str> = text.lines().collect();
    let chars: Vec<char> = text.chars().collect();
    lexical.positions = Positions::new(&chars);
    let mut scanner = Scanner::new(text.chars());
    let mut previous_scalar: Option<(Marker, TScalarStyle)> = None;
    let mut key_pending = false;
    let mut property_start = None;
    let mut has_anchor = false;
    let mut has_tag = false;
    let mut tag_mark = None;
    let mut flow_depth = 0usize;
    let mut key_mark = None;
    for token in scanner.by_ref() {
        let m = token.0;
        match &token.1 {
            TokenType::DocumentStart | TokenType::DocumentEnd => {
                if flow_depth != 0 {
                    return Err(located(
                        "UNTERMINATED_FLOW",
                        "document marker inside a flow collection",
                        m,
                        "",
                    ));
                }
                let line = source_lines.get(m.line() - 1).copied().unwrap_or("");
                let rest = line.get(3..).unwrap_or("").trim_matches([' ', '\t', '\r']);
                if !rest.is_empty() && !rest.starts_with('#') {
                    return Err(Error::new(
                        "DOC_MARKER_CONTENT",
                        "marker must occupy its own line",
                    )
                    .at(m.line(), 5, ""));
                }
            }
            TokenType::FlowSequenceStart | TokenType::FlowMappingStart => flow_depth += 1,
            TokenType::FlowSequenceEnd | TokenType::FlowMappingEnd => {
                flow_depth = flow_depth.saturating_sub(1)
            }
            TokenType::Key => key_mark = Some(m),
            TokenType::Value => {
                if let Some(key) = key_mark.take()
                    && flow_depth != 0
                    && key.line() != m.line()
                {
                    lexical.key_errors.insert(
                        lexical.positions.index(key),
                        located(
                            "MULTILINE_KEY",
                            "a flow mapping key must end on its first line",
                            key,
                            "",
                        ),
                    );
                }
            }
            TokenType::Scalar(style, value) if key_pending => {
                let length = if matches!(
                    style,
                    TScalarStyle::SingleQuoted | TScalarStyle::DoubleQuoted
                ) {
                    // Find the closing quote in the source; decoded escapes do
                    // not shorten the grammar's implicit-key length.
                    quoted_length(&chars[lexical.positions.index(m)..], *style)
                } else {
                    value.chars().count()
                };
                if length > 1024 {
                    return Err(located(
                        "KEY_TOO_LONG",
                        "an implicit key is limited to 1024 characters",
                        m,
                        "",
                    ));
                }
            }
            _ => {}
        }
        match &token.1 {
            TokenType::Key => key_pending = true,
            TokenType::Anchor(_) | TokenType::Tag(_, _) | TokenType::Alias(_) if key_pending => {
                return Err(located(
                    "KEY_PROPERTY",
                    "mapping keys cannot carry properties or aliases",
                    m,
                    "",
                ));
            }
            TokenType::Value | TokenType::Scalar(_, _) => key_pending = false,
            _ => {}
        }
        match &token.1 {
            TokenType::Anchor(name) => {
                if has_anchor {
                    return Err(located(
                        "DUPLICATE_PROPERTY",
                        "a node can carry only one anchor",
                        m,
                        "",
                    ));
                }
                has_anchor = true;
                property_start.get_or_insert(m);
                let end = lexical.positions.index(m) + 1 + name.chars().count();
                if matches!(chars.get(end), Some('[' | '{')) {
                    return Err(Error::new(
                        "PROPERTY_SEPARATION",
                        "a property must be separated from its node",
                    )
                    .at(m.line(), m.col() + 2 + name.chars().count(), ""));
                }
            }
            TokenType::Tag(handle, suffix) => {
                if has_tag {
                    return Err(located(
                        "DUPLICATE_PROPERTY",
                        "a node can carry only one tag",
                        m,
                        "",
                    ));
                }
                has_tag = true;
                check_tag(
                    &Some(Tag {
                        handle: handle.clone(),
                        suffix: suffix.clone(),
                    }),
                    "",
                    m,
                    "",
                )?;
                tag_mark = Some(m);
                property_start.get_or_insert(m);
            }
            TokenType::Alias(_) if property_start.is_some() => {
                return Err(located(
                    "ALIAS_DECORATED",
                    "an alias cannot carry a tag or anchor",
                    property_start.unwrap(),
                    "",
                ));
            }
            _ => {
                if let Some(tag) = tag_mark.take() {
                    lexical.tags.insert(lexical.positions.index(m), tag);
                }
                property_start = None;
                has_anchor = false;
                has_tag = false;
            }
        }
        match token.1 {
            TokenType::Key if chars.get(lexical.positions.index(m)) == Some(&'?') => {
                return Err(located(
                    "UNSUPPORTED_COMPLEX_KEY",
                    "explicit keys are outside KYAML",
                    m,
                    "",
                ));
            }
            _ => {}
        }
        // The scanner folds multiline scalars. Check their source span before
        // accepting that lossy normalization. Block scalars are intentionally exempt.
        if let Some((start, style)) = previous_scalar.take() {
            let end = lexical
                .positions
                .index(m)
                .min(chars.len())
                .max(lexical.positions.index(start));
            let source: String = chars[lexical.positions.index(start)..end].iter().collect();
            if matches!(
                style,
                TScalarStyle::SingleQuoted | TScalarStyle::DoubleQuoted
            ) {
                let quote = if style == TScalarStyle::SingleQuoted {
                    '\''
                } else {
                    '"'
                };
                let mut escaped = false;
                let mut quoted = source.chars().skip(1).peekable();
                while let Some(ch) = quoted.next() {
                    if ch == '\n' {
                        return Err(located(
                            "UNTERMINATED_QUOTE",
                            "quoted scalars must be single-line",
                            start,
                            "",
                        ));
                    }
                    if ch == quote && !escaped {
                        if style == TScalarStyle::SingleQuoted && quoted.peek() == Some(&quote) {
                            quoted.next();
                            continue;
                        }
                        break;
                    }
                    escaped = style == TScalarStyle::DoubleQuoted && ch == '\\' && !escaped;
                }
            }
        }
        if let TokenType::Scalar(style, ref value) = token.1 {
            if value
                .chars()
                .any(|c| (0xfdd0..=0xfdef).contains(&(c as u32)) || c as u32 & 0xfffe == 0xfffe)
            {
                return Err(located(
                    "NONCHARACTER",
                    "string contains a Unicode noncharacter",
                    m,
                    "",
                ));
            }
            if style == TScalarStyle::Plain {
                // A plain scalar containing embedded whitespace from a later
                // source line is rejected in the event pass using its token span.
                let source_prefix: String = chars[lexical.positions.index(m)..]
                    .iter()
                    .take(value.chars().count())
                    .collect();
                if source_prefix != *value || value.contains(['\n', '\r']) {
                    let continuation = chars[lexical.positions.index(m)..]
                        .iter()
                        .position(|c| *c == '\n')
                        .map(|n| lexical.positions.index(m) + n + 1);
                    if let Some(start) = continuation {
                        let indent = chars[start..].iter().take_while(|c| **c == ' ').count();
                        return Err(
                            Error::new("UNEXPECTED_INDENT", "multiline plain scalar").at(
                                m.line() + 1,
                                indent + 1,
                                "",
                            ),
                        );
                    }
                }
            }
            previous_scalar = Some((m, style));
        }
    }
    if let Some(e) = scanner.get_error() {
        let error = syntax_error(e, text, "");
        // Contextual syntax errors are emitted by Reader, which knows the path.
        if !matches!(
            error.code,
            "YAML_SYNTAX"
                | "MAPPING_IN_VALUE"
                | "FLOW_SEPARATOR"
                | "EMPTY_VALUE"
                | "UNTERMINATED_FLOW"
                | "UNKNOWN_ANCHOR"
        ) {
            return Err(error);
        }
    }
    Ok(lexical)
}

fn quoted_length(chars: &[char], style: TScalarStyle) -> usize {
    let quote = if style == TScalarStyle::SingleQuoted {
        '\''
    } else {
        '"'
    };
    let mut i = 1;
    while i < chars.len() {
        if chars[i] == '\\' && style == TScalarStyle::DoubleQuoted {
            i += 2;
            continue;
        }
        if chars[i] == quote {
            if style == TScalarStyle::SingleQuoted && chars.get(i + 1) == Some(&quote) {
                i += 2;
                continue;
            }
            return i + 1;
        }
        i += 1;
    }
    i
}

struct Reader<'a> {
    text: &'a str,
    lexical: Lexical,
    parser: Parser<std::str::Chars<'a>>,
    anchors: HashMap<usize, (Value, usize)>,
    nodes: usize,
    bytes: usize,
}
fn storage_cost(value: &Value) -> usize {
    let mut pending = vec![(value, 0)];
    let mut cost: usize = 0;
    while let Some((value, depth)) = pending.pop() {
        if depth > MAX_DEPTH {
            return usize::MAX;
        }
        cost = cost.saturating_add(64);
        match value {
            Value::String(s) => cost = cost.saturating_add(s.len()),
            Value::Array(values) => pending.extend(values.iter().map(|v| (v, depth + 1))),
            Value::Object(map) => {
                for (key, value) in map {
                    cost = cost.saturating_add(key.len()).saturating_add(64);
                    pending.push((value, depth + 1));
                }
            }
            _ => {}
        }
    }
    cost
}
impl Reader<'_> {
    fn charge(&mut self, bytes: usize, m: Marker, path: &str) -> Result<(), Error> {
        self.bytes =
            kyq_bounds::consume(self.bytes, bytes, MAX_EXPANDED_BYTES).ok_or_else(|| {
                located(
                    "EXPANSION_LIMIT",
                    "expanded storage or alias depth exceeds limit",
                    m,
                    path,
                )
            })?;
        Ok(())
    }
    fn next(&mut self, path: &str) -> Result<(Event, Marker), Error> {
        self.parser
            .next_token()
            .map_err(|e| syntax_error(e, self.text, path))
    }
    fn node(
        &mut self,
        event: Event,
        m: Marker,
        path: &str,
        depth: usize,
    ) -> Result<(Value, usize), Error> {
        if depth > MAX_DEPTH {
            return Err(located("DEPTH_LIMIT", "maximum nesting exceeded", m, path));
        }
        self.nodes = kyq_bounds::consume(self.nodes, 1, NODE_BUDGET).ok_or_else(|| {
            located(
                "NODE_BUDGET_EXCEEDED",
                "expanded tree exceeds budget",
                m,
                path,
            )
        })?;
        let (value, size, anchor) = match event {
            Event::Scalar(text, style, anchor, tag) => {
                self.charge(text.len().saturating_add(64), m, path)?;
                let tag_mark = self
                    .lexical
                    .tags
                    .get(&self.lexical.positions.index(m))
                    .copied()
                    .unwrap_or(m);
                (scalar(&text, style, &tag, m, tag_mark, path)?, 1, anchor)
            }
            Event::Alias(id) => {
                let (value, size) = self.anchors.get(&id).ok_or_else(|| {
                    located(
                        "UNKNOWN_ANCHOR",
                        "alias must refer to a completed node",
                        m,
                        path,
                    )
                })?;
                self.nodes = kyq_bounds::consume(self.nodes, size.saturating_sub(1), NODE_BUDGET)
                    .ok_or_else(|| {
                    located(
                        "NODE_BUDGET_EXCEEDED",
                        "alias expansion exceeds budget",
                        m,
                        path,
                    )
                })?;
                self.bytes =
                    kyq_bounds::consume(self.bytes, storage_cost(value), MAX_EXPANDED_BYTES)
                        .ok_or_else(|| {
                            located(
                                "EXPANSION_LIMIT",
                                "alias copy exceeds storage budget",
                                m,
                                path,
                            )
                        })?;
                (value.clone(), *size, 0)
            }
            Event::SequenceStart(anchor, tag) => {
                check_tag(
                    &tag,
                    "seq",
                    self.lexical
                        .tags
                        .get(&self.lexical.positions.index(m))
                        .copied()
                        .unwrap_or(m),
                    path,
                )?;
                self.charge(64, m, path)?;
                let mut values = Vec::new();
                let mut size = 1;
                loop {
                    let child_path = pointer(path, &values.len().to_string());
                    let (event, m) = self.next(&child_path).map_err(|mut error| {
                        if matches!(
                            error.code,
                            "EMPTY_VALUE" | "FLOW_SEPARATOR" | "UNTERMINATED_FLOW"
                        ) {
                            error.path = path.to_owned();
                        }
                        if error.code == "UNTERMINATED_FLOW"
                            && error.line > self.text.lines().count()
                        {
                            error.line = m.line();
                            error.column = m.col() + 1;
                        }
                        error
                    })?;
                    if event == Event::SequenceEnd {
                        break;
                    }
                    let (value, child_size) = self.node(event, m, &child_path, depth + 1)?;
                    size += child_size;
                    values.push(value);
                }
                (Value::Array(values), size, anchor)
            }
            Event::MappingStart(anchor, tag) => {
                check_tag(
                    &tag,
                    "map",
                    self.lexical
                        .tags
                        .get(&self.lexical.positions.index(m))
                        .copied()
                        .unwrap_or(m),
                    path,
                )?;
                self.charge(64, m, path)?;
                let mut values = serde_json::Map::new();
                let mut size = 1;
                loop {
                    let (event, m) = self.next(path)?;
                    if event == Event::MappingEnd {
                        break;
                    }
                    if let Some(mut error) = self
                        .lexical
                        .key_errors
                        .remove(&self.lexical.positions.index(m))
                    {
                        error.path = path.to_owned();
                        return Err(error);
                    }
                    if matches!(
                        event,
                        Event::SequenceStart(_, _) | Event::MappingStart(_, _)
                    ) {
                        return Err(located(
                            "PLAIN_INDICATOR",
                            "collection indicators cannot start an implicit key",
                            m,
                            "",
                        ));
                    }
                    let (key, _) = self.node(event, m, path, depth + 1)?;
                    let key = key.as_str().ok_or_else(|| {
                        located("NON_STRING_KEY", "mapping keys must be strings", m, path)
                    })?;
                    if key == "<<" {
                        return Err(located(
                            "UNSUPPORTED_MERGE_KEY",
                            "merge keys are outside KYAML",
                            m,
                            path,
                        ));
                    }
                    let child_path = pointer(path, key);
                    if values.contains_key(key) {
                        return Err(located(
                            "DUPLICATE_KEY",
                            "duplicate mapping key",
                            m,
                            &child_path,
                        ));
                    }
                    let (event, value_mark) = self.next(&child_path)?;
                    let (value, child_size) =
                        self.node(event, value_mark, &child_path, depth + 1)?;
                    size += 1 + child_size;
                    values.insert(key.to_owned(), value);
                }
                (Value::Object(values), size, anchor)
            }
            _ => return Err(located("YAML_SYNTAX", "expected a value", m, path)),
        };
        if anchor != 0 {
            self.charge(storage_cost(&value), m, path)?;
            self.anchors.insert(anchor, (value.clone(), size));
        }
        Ok((value, size))
    }
}
pub(crate) fn parse(text: &str) -> Result<Vec<Value>, Error> {
    // Validate the original stream before stripping its optional BOM. Positions
    // count Unicode scalar values, including astral characters, rather than bytes.
    let mut chars = text.chars().peekable();
    let (mut line, mut column, mut index) = (1, 1, 0);
    while let Some(ch) = chars.next() {
        let code = match ch {
            '\r' if chars.peek() != Some(&'\n') => Some("INVALID_NEWLINE"),
            '\u{feff}' if index != 0 => Some("BOM_MIDSTREAM"),
            '\u{fffe}' | '\u{ffff}' => Some("NONCHARACTER"),
            '\0'..='\u{8}'
            | '\u{b}'..='\u{c}'
            | '\u{e}'..='\u{1f}'
            | '\u{7f}'..='\u{84}'
            | '\u{86}'..='\u{9f}' => Some("CONTROL_CHARACTER"),
            _ => None,
        };
        if let Some(code) = code {
            return Err(
                Error::new(code, "character is outside the KYAML stream grammar")
                    .at(line, column, ""),
            );
        }
        if ch == '\n' {
            line += 1;
            column = 1;
        } else if index != 0 || ch != '\u{feff}' {
            column += 1;
        }
        index += 1;
    }
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let lexical = lexical_checks(text)?;
    let mut reader = Reader {
        text,
        lexical,
        parser: Parser::new_from_str(text),
        anchors: HashMap::new(),
        nodes: 0,
        bytes: 0,
    };
    let mut docs = Vec::new();
    loop {
        let (event, m) = reader.next("")?;
        match event {
            Event::StreamStart | Event::DocumentEnd => {}
            Event::StreamEnd => break,
            Event::DocumentStart => {
                reader.anchors.clear();
                reader.nodes = 0;
                let (event, mark) = reader.next("")?;
                let value = reader.node(event, mark, "", 0)?.0;
                if storage_cost(&value) == usize::MAX {
                    return Err(located(
                        "DEPTH_LIMIT",
                        "expanded alias nesting exceeds limit",
                        mark,
                        "",
                    ));
                }
                docs.push(value);
            }
            _ => return Err(located("YAML_SYNTAX", "expected a document", m, "")),
        }
    }
    Ok(docs)
}

#[cfg(test)]
mod position_tests {
    use super::*;

    fn markers(text: &str) -> Vec<Marker> {
        Scanner::new(text.chars()).map(|token| token.0).collect()
    }

    #[test]
    fn offsets_never_exceed_the_input() {
        for text in [
            "|\n 2\u{fef7}",
            "|\n 2\u{fef7}\n8",
            "a: |\n  日本\nb: c\n",
            "",
            "\n\n",
        ] {
            let chars: Vec<char> = text.chars().collect();
            let positions = Positions::new(&chars);
            for m in markers(text) {
                assert!(positions.index(m) <= chars.len(), "{text:?} {m:?}");
            }
        }
    }

    #[test]
    fn offsets_after_block_scalars_match_ascii_content() {
        for (wide, narrow) in [("é", "z"), ("日本", "zz"), ("🦀\u{fef7}", "zz")] {
            let index = |content: &str| {
                let text = format!("|\n {content}\n8");
                let chars: Vec<char> = text.chars().collect();
                let positions = Positions::new(&chars);
                markers(&text)
                    .into_iter()
                    .map(|m| positions.index(m))
                    .collect::<Vec<_>>()
            };
            assert_eq!(index(wide), index(narrow));
        }
        // The raw yaml-rust2 index drifts; the derived offset does not. The
        // first content character is buffered and counted correctly; later
        // ones are counted in bytes.
        let text = "|\n zé\n8";
        let chars: Vec<char> = text.chars().collect();
        let plain = markers(text)[2];
        assert_eq!(
            plain.index(),
            7,
            "yaml-rust2 behaviour changed; revisit Positions"
        );
        assert_eq!(Positions::new(&chars).index(plain), 6);
        assert_eq!(chars[6], '8');
    }
}
