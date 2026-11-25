// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell
use kyq::{Format, canonicalize, parse};
use proptest::prelude::*;

#[test]
fn committed_kyaml_verdicts() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("conformance/fixtures/kyaml");
    let cases: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join("cases.json")).unwrap()).unwrap();
    let mut failures = Vec::new();
    for case in cases["cases"].as_array().unwrap() {
        let name = case["file"].as_str().unwrap();
        let result = parse(&std::fs::read(root.join(name)).unwrap(), Format::Kyaml);
        if case["expect"] == "valid" {
            match result {
                Ok(docs) => assert_eq!(
                    docs.len() as u64,
                    case["documents"].as_u64().unwrap(),
                    "{name}"
                ),
                Err(error) => failures.push(format!("{name}: {error}")),
            }
        } else if result.is_ok() {
            failures.push(format!("{name}: incorrectly accepted"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn json_and_yaml_share_canonicalizer() {
    assert_eq!(
        canonicalize(b"b: 1\na: [true, null]\n", Format::Kyaml).unwrap(),
        canonicalize(br#"{"b":1,"a":[true,null]}"#, Format::Json).unwrap()
    );
}
#[test]
fn dhall_is_typed_and_imports_are_disabled() {
    assert_eq!(
        canonicalize(b"let x = 1 in { a = x + 1, b = True }", Format::Dhall).unwrap(),
        br#"{"a":2,"b":true}"#
    );
    for input in [
        "./Cargo.toml",
        "env:HOME",
        "https://example.com/data",
        "1 + True",
    ] {
        assert!(parse(input.as_bytes(), Format::Dhall).is_err(), "{input}");
    }
}
#[test]
fn reject_duplicates_before_map_construction() {
    for input in [r#"{"a":1,"a":2}"#, r#"{"a":1,"\u0061":2}"#] {
        assert!(parse(input.as_bytes(), Format::Json).is_err());
        assert!(parse(input.as_bytes(), Format::Kyaml).is_err());
    }
}
#[test]
fn depth_and_alias_bombs_fail_closed() {
    let deep = format!("{}0{}", "[".repeat(100), "]".repeat(100));
    assert!(parse(deep.as_bytes(), Format::Kyaml).is_err());
    let mut bomb = String::from("a: &a [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]\n");
    let mut previous = "a".to_string();
    for n in 0..7 {
        let name = format!("n{n}");
        bomb += &format!(
            "{name}: &{name} [{}]\n",
            vec![format!("*{previous}"); 10].join(", ")
        );
        previous = name;
    }
    assert!(parse(bomb.as_bytes(), Format::Kyaml).is_err());
}
proptest! {
    #[test]
    fn canonicalization_and_format_are_idempotent(values in prop::collection::vec(-100000i64..100000, 0..50)) {
        let input = serde_json::to_vec(&values).unwrap();
        let bytes = canonicalize(&input, Format::Json).unwrap();
        prop_assert_eq!(&bytes, &canonicalize(&bytes, Format::Json).unwrap());
        let docs = parse(&input, Format::Json).unwrap();
        let yaml = kyq::format_documents(&docs).unwrap();
        prop_assert_eq!(kyq::format_documents(&parse(&yaml, Format::Kyaml).unwrap()).unwrap(), yaml);
    }
}

#[test]
fn jcs_reader_round_trips_integral_doubles_without_relaxing_json() {
    for (input, format) in [("1e16", Format::Jcs), ("1.0e16", Format::Dhall)] {
        let canonical = canonicalize(input.as_bytes(), format).unwrap();
        assert!(parse(&canonical, Format::Json).is_err());
        assert_eq!(canonicalize(&canonical, Format::Jcs).unwrap(), canonical);
        let values = parse(&canonical, Format::Jcs).unwrap();
        assert_eq!(
            kyq::format_documents(&values).unwrap_err().code,
            "UNSAFE_FLOAT_INTEGER"
        );
    }
    for (input, format) in [
        ("1e16", Format::Json),
        ("!!float 9007199254740993", Format::Kyaml),
    ] {
        assert_eq!(
            canonicalize(input.as_bytes(), format).unwrap_err().code,
            "UNSAFE_FLOAT_INTEGER"
        );
    }
    for input in [r#"{"a":1,"a":2}"#, r#""\ud800""#, "1e400", "0 1"] {
        assert!(parse(input.as_bytes(), Format::Jcs).is_err());
    }
}

#[test]
fn kyaml_container_depth_boundary_counts_empty_collections() {
    for (leaf, leaf_depth) in [("0", 0), ("[]", 1), ("{}", 1)] {
        for depth in [kyq::MAX_DEPTH, kyq::MAX_DEPTH + 1] {
            let outer = depth - leaf_depth;
            let input = format!("{}{leaf}{}", "[".repeat(outer), "]".repeat(outer));
            let result = canonicalize(input.as_bytes(), Format::Kyaml);
            if depth == kyq::MAX_DEPTH {
                assert_eq!(result.unwrap(), input.as_bytes());
            } else {
                assert_eq!(result.unwrap_err().code, "DEPTH_LIMIT");
            }
        }
    }
}

#[test]
fn kyaml_container_depth_boundary_counts_alias_targets_at_the_use_site() {
    // The root map, these sequences and the empty map reach the limit exactly.
    let outer = kyq::MAX_DEPTH - 2;
    let anchor = format!(
        "base: &base {}{{}}{}\n",
        "[".repeat(outer),
        "]".repeat(outer)
    );
    let exact = format!("{anchor}copy: *base\n");
    let canonical = canonicalize(exact.as_bytes(), Format::Kyaml).unwrap();
    assert_eq!(canonicalize(&canonical, Format::Kyaml).unwrap(), canonical);

    let over = format!("{anchor}copy: [*base]\n");
    let error = parse(over.as_bytes(), Format::Kyaml).unwrap_err();
    assert_eq!(error.code, "DEPTH_LIMIT");
    assert_eq!(error.path, "copy/0");
}
