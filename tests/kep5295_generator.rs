// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell
//! W8 part 1b: KYAML generated from the KEP-5295 rules in standards
//! YAML-POLICY §3.1, by a writer that shares no code with kyq.
//!
//! The rules: `{}` for every map and `[]` for every list, every string value
//! double-quoted, keys unquoted where unambiguous, trailing commas, two-space
//! indentation, a `---` document header. Comments are allowed (KEP-5295).
//! kyq must read each generated document to the value it was written from.
//!
//! Cases per run: `KYQ_KEP5295_CASES` (default 1024). Seed: proptest's, so a
//! failure prints a reproducible seed.
use proptest::{
    prelude::*,
    test_runner::{Config, TestCaseError, TestRunner},
};
use serde_json::{Map, Number, Value as Json};

fn cases() -> u32 {
    std::env::var("KYQ_KEP5295_CASES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1024)
}

fn text() -> impl Strategy<Value = String> {
    prop_oneof![
        "[a-z0-9 _.:/-]{0,12}",
        // Words that YAML 1.1 or the core schema would read as non-strings.
        prop::sample::select(vec![
            "no", "yes", "on", "off", "true", "false", "null", "~", "1.0", "010", "0x1F", "1:20",
            ".inf", "-", "#", "&a", "*a", "!tag", "", " lead", "trail ",
        ])
        .prop_map(str::to_owned),
        any::<String>().prop_map(|s| s.chars().take(16).collect()),
    ]
}

fn key() -> impl Strategy<Value = String> {
    prop_oneof![3 => "[a-z][a-zA-Z0-9_-]{0,10}", 1 => text()]
}

fn scalar() -> impl Strategy<Value = Json> {
    prop_oneof![
        Just(Json::Null),
        any::<bool>().prop_map(Json::Bool),
        (-(1i64 << 53) + 1..(1i64 << 53)).prop_map(|n| Json::Number(n.into())),
        (prop::num::f64::NORMAL | prop::num::f64::SUBNORMAL | prop::num::f64::ZERO)
            .prop_map(|f| Json::Number(Number::from_f64(f).unwrap())),
        text().prop_map(Json::String),
    ]
}

fn value() -> impl Strategy<Value = Json> {
    let leaf = scalar();
    leaf.prop_recursive(5, 64, 6, |inner| {
        prop_oneof![
            prop::collection::vec(inner.clone(), 0..6).prop_map(Json::Array),
            prop::collection::vec((key(), inner), 0..6).prop_map(|pairs| {
                let mut map = Map::new();
                for (k, v) in pairs {
                    map.insert(k, v);
                }
                Json::Object(map)
            }),
        ]
    })
}

/// A key may be bare when it is a plain identifier YAML cannot read as
/// anything else.
fn bare_key(key: &str) -> bool {
    const RESERVED: &[&str] = &[
        "y", "Y", "n", "N", "yes", "Yes", "YES", "no", "No", "NO", "on", "On", "ON", "off", "Off",
        "OFF", "true", "True", "TRUE", "false", "False", "FALSE", "null", "Null", "NULL",
    ];
    let mut chars = key.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        && !RESERVED.contains(&key)
}

/// A YAML double-quoted scalar.
fn quote(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 || c == '\u{7f}' || ('\u{80}'..='\u{9f}').contains(&c) => {
                out.push_str(&format!("\\u{:04X}", c as u32));
            }
            '\u{2028}' | '\u{2029}' | '\u{feff}' => {
                out.push_str(&format!("\\u{:04X}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn write(value: &Json, indent: usize, comments: bool, out: &mut String) {
    let pad = "  ".repeat(indent + 1);
    match value {
        Json::Null => out.push_str("null"),
        Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Json::Number(n) => out.push_str(&n.to_string()),
        Json::String(s) => out.push_str(&quote(s)),
        Json::Array(items) if items.is_empty() => out.push_str("[]"),
        Json::Object(map) if map.is_empty() => out.push_str("{}"),
        Json::Array(items) => {
            out.push_str("[\n");
            for item in items {
                out.push_str(&pad);
                write(item, indent + 1, comments, out);
                out.push_str(",\n");
            }
            out.push_str(&"  ".repeat(indent));
            out.push(']');
        }
        Json::Object(map) => {
            out.push_str("{\n");
            for (k, v) in map {
                if comments {
                    // Debug escapes `\n` and `\r`, so the comment stays on one line.
                    out.push_str(&format!("{pad}# {k:?}\n"));
                }
                out.push_str(&pad);
                out.push_str(&if bare_key(k) { k.clone() } else { quote(k) });
                out.push_str(": ");
                write(v, indent + 1, comments, out);
                out.push_str(",\n");
            }
            out.push_str(&"  ".repeat(indent));
            out.push('}');
        }
    }
}

fn render(value: &Json, comments: bool) -> String {
    let mut out = String::from("---\n");
    write(value, 0, comments, &mut out);
    out.push('\n');
    out
}

type Parser = fn(&[u8]) -> Result<Json, String>;

fn kyq_parser(input: &[u8]) -> Result<Json, String> {
    match kyq::parse(input, kyq::Format::Kyaml) {
        Ok(docs) if docs.len() == 1 => Ok(serde_json::to_value(&docs[0]).unwrap()),
        Ok(docs) => Err(format!("{} documents", docs.len())),
        Err(e) => Err(format!("{}: {}", e.code, e.message)),
    }
}

/// KYAML_SPEC: a float whose canonical text is an integer outside ±(2^53−1)
/// (for example `1e18`) is refused as `UNSAFE_FLOAT_INTEGER`, so that canonical
/// output always checks. RFC 8785 prints an integral double without an
/// exponent only below 1e21, so the refusal covers 2^53 <= |x| < 1e21.
/// KYAML_SPEC also refuses the merge key as `UNSUPPORTED_MERGE_KEY`.
/// The model lists every refusal it expects; kyq reports whichever it meets
/// first, so any listed code passes.
fn expected_refusals(value: &Json, codes: &mut Vec<&'static str>) {
    match value {
        Json::Number(n) if n.is_f64() => {
            let f = n.as_f64().unwrap().abs();
            if f.fract() == 0.0 && (9_007_199_254_740_992.0..1e21).contains(&f) {
                codes.push("UNSAFE_FLOAT_INTEGER");
            }
        }
        Json::Array(items) => items.iter().for_each(|v| expected_refusals(v, codes)),
        Json::Object(map) => {
            // KYAML_SPEC refuses the merge key `<<`, quoted or not: yq
            // (go-yaml), the estate's own formatter, merges on `"<<"` too.
            if map.contains_key("<<") {
                codes.push("UNSUPPORTED_MERGE_KEY");
            }
            map.values().for_each(|v| expected_refusals(v, codes));
        }
        _ => {}
    }
}

fn run(parser: Parser, cases: u32) -> Result<(), String> {
    let config = Config {
        cases,
        failure_persistence: None,
        ..Config::default()
    };
    TestRunner::new(config)
        .run(&(value(), any::<bool>()), |(value, comments)| {
            let source = render(&value, comments);
            if std::env::var_os("KYQ_KEP5295_SHOW").is_some() {
                eprintln!("{source}");
            }
            let mut codes = Vec::new();
            expected_refusals(&value, &mut codes);
            match (parser(source.as_bytes()), codes.is_empty()) {
                (Ok(got), true) if got == value => Ok(()),
                (Err(e), false) if codes.iter().any(|c| e.starts_with(&format!("{c}:"))) => Ok(()),
                (Ok(got), _) => Err(TestCaseError::fail(format!("{source}\nread as {got}"))),
                (Err(e), _) => Err(TestCaseError::fail(format!("{source}\nrefused: {e}"))),
            }
        })
        .map_err(|e| e.to_string())
}

#[test]
fn kyq_reads_kep5295_documents_to_their_values() {
    if let Err(e) = run(kyq_parser, cases()) {
        panic!("{e}");
    }
}

/// Planted fault: a parser that trims string values.
fn trimming_parser(input: &[u8]) -> Result<Json, String> {
    fn trim(v: &mut Json) {
        match v {
            Json::String(s) => *s = s.trim().to_owned(),
            Json::Array(items) => items.iter_mut().for_each(trim),
            Json::Object(map) => map.values_mut().for_each(trim),
            _ => {}
        }
    }
    let mut value = kyq_parser(input)?;
    trim(&mut value);
    Ok(value)
}

#[test]
fn the_generator_finds_a_planted_parser_fault() {
    assert!(
        run(trimming_parser, cases()).is_err(),
        "missed the string-trimming fault"
    );
}
