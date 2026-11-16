// SPDX-License-Identifier: MPL-2.0
//! Exercise the versioned public corpus, including diagnostic contracts.
use kyq::{Error, Format, canonicalize, parse};
use serde_json::Value;
use std::collections::HashSet;

fn diagnostic(error: &Error, expected: &Value) -> bool {
    expected["code"] == error.code
        && expected["line"]
            .as_u64()
            .is_none_or(|n| n == error.line as u64)
        && expected["column"]
            .as_u64()
            .is_none_or(|n| n == error.column as u64)
        && expected["path"].as_str().is_none_or(|p| p == error.path)
}

#[test]
fn bridge_vectors_match_canonical_bytes_and_diagnostics() {
    let vectors: Value =
        serde_json::from_str(include_str!("../conformance/fixtures/bridge/vectors.json")).unwrap();
    let vectors = vectors["vectors"].as_array().unwrap();
    assert!(
        !vectors.is_empty(),
        "an empty corpus cannot qualify a parser"
    );
    let mut names = HashSet::new();
    let mut failures = Vec::new();
    for vector in vectors {
        let name = vector["name"].as_str().unwrap();
        assert!(names.insert(name), "duplicate vector: {name}");
        let input = vector["yaml"].as_str().unwrap().as_bytes();
        let actual = if vector["array"] == true {
            parse(input, Format::Kyaml)
                .and_then(|docs| kyq::canonicalize_documents(&[Value::Array(docs)]))
        } else {
            canonicalize(input, Format::Kyaml)
        };
        let conforms = match &actual {
            Ok(bytes) => vector["jcs"]
                .as_str()
                .is_some_and(|s| bytes == s.as_bytes()),
            Err(error) => diagnostic(error, &vector["error"]),
        };
        if !conforms {
            let observed = match actual {
                Ok(bytes) => format!("accepted {} bytes", bytes.len()),
                Err(error) => format!("{error:?}"),
            };
            failures.push(format!(
                "{name}: expected {}, actual {observed}",
                vector.get("error").unwrap_or(&vector["jcs"])
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} vectors failed:\n{}",
        failures.len(),
        vectors.len(),
        failures.join("\n")
    );
}

#[test]
fn committed_fixtures_match_diagnostic_contract_and_inventory() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("conformance/fixtures/kyaml");
    let corpus: Value =
        serde_json::from_slice(&std::fs::read(root.join("cases.json")).unwrap()).unwrap();
    let cases = corpus["cases"].as_array().unwrap();
    assert!(!cases.is_empty());
    let mut listed = HashSet::new();
    let mut failures = Vec::new();
    for case in cases {
        let file = case["file"].as_str().unwrap();
        assert!(listed.insert(file.to_owned()), "duplicate fixture: {file}");
        let actual = parse(&std::fs::read(root.join(file)).unwrap(), Format::Kyaml);
        let conforms = match &actual {
            Ok(docs) => case["expect"] == "valid" && case["documents"] == docs.len(),
            Err(error) => case["expect"] == "invalid" && diagnostic(error, case),
        };
        if !conforms {
            failures.push(format!("{file}: expected {case}, actual {actual:?}"));
        }
    }
    let files: HashSet<_> = ["valid", "invalid"]
        .into_iter()
        .flat_map(|dir| {
            std::fs::read_dir(root.join(dir))
                .unwrap()
                .map(move |entry| format!("{dir}/{}", entry.unwrap().file_name().to_str().unwrap()))
        })
        .collect();
    assert_eq!(listed, files, "every fixture needs exactly one expectation");
    assert!(
        failures.is_empty(),
        "{} of {} fixtures failed:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
}

#[test]
fn every_forbidden_raw_control_is_located_and_escaped_controls_remain_data() {
    for codepoint in (0..=0x1f).chain(0x7f..=0x9f) {
        if [9, 10, 13, 0x85].contains(&codepoint) {
            continue;
        }
        let character = char::from_u32(codepoint).unwrap();
        let raw = format!("emoji: 😀\nvalue: before{character}after\n");
        let error = parse(raw.as_bytes(), Format::Kyaml).unwrap_err();
        assert_eq!(
            (error.code, error.line, error.column, error.path.as_str()),
            ("CONTROL_CHARACTER", 2, 14, ""),
            "U+{codepoint:04X}"
        );
        let escaped = format!("value: \"\\u{codepoint:04x}\"\n");
        let docs = parse(escaped.as_bytes(), Format::Kyaml).unwrap();
        assert_eq!(docs[0]["value"], character.to_string());
    }
}

#[test]
fn lookahead_errors_recover_nested_and_escaped_paths() {
    for (input, path) in [
        ("outer:\n  a/b: name: wrong\n", "outer/a~1b"),
        ("items:\n  - metadata: name: wrong\n", "items/0/metadata"),
        ("\"a: b\": name: wrong\n", "a: b"),
        ("\"a~b\": name: wrong\n", "a~0b"),
    ] {
        let error = parse(input.as_bytes(), Format::Kyaml).unwrap_err();
        assert_eq!(error.code, "MAPPING_IN_VALUE", "{input}");
        assert_eq!(error.path, path, "{input}");
    }
}

#[test]
fn implicit_key_limit_counts_source_characters_in_both_collection_styles() {
    for flow in [false, true] {
        for quoted in [false, true] {
            for length in [1024, 1025] {
                let key = if quoted {
                    format!("\"{}\"", "a".repeat(length - 2))
                } else {
                    "a".repeat(length)
                };
                let text = if flow {
                    format!("{{{key}: 1}}")
                } else {
                    format!("{key}: 1")
                };
                let result = parse(text.as_bytes(), Format::Kyaml);
                if length == 1024 {
                    assert!(result.is_ok(), "{flow}/{quoted}: {result:?}");
                } else {
                    assert_eq!(result.unwrap_err().code, "KEY_TOO_LONG", "{flow}/{quoted}");
                }
            }
        }
    }
}
