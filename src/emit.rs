// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell
use crate::{Error, Value};

fn string(value: &str) -> String {
    let unsafe_plain = value.is_empty()
        || value != value.trim()
        || value.chars().any(|c| c.is_control())
        || value.contains(" #")
        || value.contains(": ")
        || value.ends_with(':')
        || value.starts_with([
            '-', '?', ':', ',', '[', ']', '{', '}', '#', '&', '*', '!', '|', '>', '\'', '"', '%',
            '@', '`',
        ])
        || ["y", "yes", "n", "no", "on", "off"].contains(&value.to_ascii_lowercase().as_str());
    if !unsafe_plain && crate::kyaml::plain_is_string(value) {
        value.to_owned()
    } else {
        serde_json::to_string(value).expect("a Rust string is valid JSON")
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
                if inline(value) {
                    lines.push(format!("{pad}{}: {}", string(key), scalar(value)?));
                } else {
                    lines.push(format!("{pad}{}:", string(key)));
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
