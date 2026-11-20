// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell
use crate::{Error, Value};

/// Characters written as `\\u` escapes inside a double-quoted string: every
/// character the reader rejects raw, plus line terminators and controls that
/// the reader would otherwise fold or strip (a leading U+FEFF is removed as a
/// byte-order mark).
fn must_escape(ch: char) -> bool {
    ch.is_control()
        || matches!(ch, '\u{2028}' | '\u{2029}')
        || crate::kyaml::forbidden_raw(ch).is_some()
}

fn string(value: &str) -> String {
    let unsafe_plain = value.is_empty()
        || value != value.trim()
        || value.chars().any(must_escape)
        || value == "-"
        || value.starts_with("- ")
        // A line beginning with a document marker followed by a blank is read
        // as that marker, so quote every string that starts with one.
        || value.starts_with("...")
        || value.starts_with("---")
        || value.contains(" #")
        || value.contains(": ")
        || value.ends_with(':')
        || value.starts_with([
            '?', ':', ',', '[', ']', '{', '}', '#', '&', '*', '!', '|', '>', '\'', '"', '%', '@',
            '`',
        ])
        || ["y", "yes", "n", "no", "on", "off"].contains(&value.to_ascii_lowercase().as_str());
    if !unsafe_plain && crate::kyaml::plain_is_string(value) {
        value.to_owned()
    } else {
        let mut quoted = String::from("\"");
        for ch in value.chars() {
            match ch {
                '\\' => quoted.push_str("\\\\"),
                '"' => quoted.push_str("\\\""),
                ch if must_escape(ch) => {
                    use std::fmt::Write;
                    write!(quoted, "\\u{:04x}", ch as u32).unwrap();
                }
                ch => quoted.push(ch),
            }
        }
        quoted.push('"');
        quoted
    }
}
fn inline(value: &Value) -> bool {
    match value {
        Value::Array(v) => v.is_empty(),
        Value::Object(v) => v.is_empty(),
        _ => true,
    }
}
fn scalar(value: &Value) -> Result<String, Error> {
    if let Value::String(value) = value {
        return Ok(string(value));
    }
    let mut rendered =
        ijson_jcs::to_jcs_string(value).map_err(|e| Error::new("INVALID_IJSON", e.to_string()))?;
    // Large integral binary64 values must retain float syntax in KYAML:
    // decimal integer tokens outside the safe range are intentionally rejected.
    if let Value::Number(n) = value
        && n.is_f64()
        && !rendered.contains(['.', 'e'])
        && n.as_f64()
            .is_some_and(|v| v.abs() > 9_007_199_254_740_991.0)
    {
        rendered.push_str(".0");
    }
    Ok(rendered)
}
fn node(value: &Value, indent: usize, lines: &mut Vec<String>) -> Result<(), Error> {
    let pad = " ".repeat(indent);
    match value {
        Value::Object(map) if !map.is_empty() => {
            for (key, value) in map {
                if key == "<<" {
                    return Err(Error::new(
                        "UNSUPPORTED_MERGE_KEY",
                        "merge keys are outside KYAML",
                    ));
                }
                let key = string(key);
                if key.chars().count() > 1024 {
                    return Err(Error::new(
                        "KEY_TOO_LONG",
                        "an implicit key is limited to 1024 characters",
                    ));
                }
                if inline(value) {
                    lines.push(format!("{pad}{}: {}", key, scalar(value)?));
                } else {
                    lines.push(format!("{pad}{key}:"));
                    node(value, indent + 2, lines)?;
                }
            }
        }
        Value::Array(items) if !items.is_empty() => {
            for item in items {
                if inline(item) {
                    lines.push(format!("{pad}- {}", scalar(item)?));
                } else {
                    let mut child = Vec::new();
                    node(item, indent + 2, &mut child)?;
                    child[0] = format!("{pad}- {}", &child[0][indent + 2..]);
                    lines.extend(child);
                }
            }
        }
        _ => lines.push(format!("{pad}{}", scalar(value)?)),
    }
    Ok(())
}
pub(crate) fn format(docs: &[Value]) -> Result<Vec<u8>, Error> {
    let mut lines = Vec::new();
    for (index, doc) in docs.iter().enumerate() {
        ijson_jcs::validate_canonicalizable(doc)
            .map_err(|e| Error::new("INVALID_IJSON", e.to_string()))?;
        if index > 0 {
            lines.push("---".into());
        }
        node(doc, 0, &mut lines)?;
    }
    if lines.is_empty() {
        Ok(vec![])
    } else {
        Ok((lines.join("\n") + "\n").into_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Exhaustive over every Unicode scalar value: nothing the reader rejects
    /// raw can be emitted raw.
    #[test]
    fn every_character_the_reader_rejects_is_escaped() {
        for ch in (0..=0x10ffff).filter_map(char::from_u32) {
            if crate::kyaml::forbidden_raw(ch).is_some() || ch == '\r' {
                assert!(must_escape(ch), "U+{:04X}", ch as u32);
            }
        }
    }
}
