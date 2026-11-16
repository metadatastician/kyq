// SPDX-License-Identifier: MPL-2.0
use kyq::{Format, Value, canonicalize, format_documents, parse};

#[test]
fn formatter_preserves_large_integral_floats() {
    for input in ["x: 1e20", "x: 1.23456789e19", "x: -1e20", "x: 1e-7"] {
        let value = parse(input.as_bytes(), Format::Kyaml).unwrap();
        let first = format_documents(&value).unwrap();
        let again = parse(&first, Format::Kyaml).unwrap();
        assert_eq!(
            canonicalize(input.as_bytes(), Format::Kyaml).unwrap(),
            canonicalize(&first, Format::Kyaml).unwrap()
        );
        assert_eq!(first, format_documents(&again).unwrap());
    }
}
#[test]
fn scalar_strings_are_not_retyped() {
    for value in [
        "yes",
        "On",
        "0o7",
        "0x1f",
        "+1",
        ".inf",
        ".NaN",
        "null",
        "~",
        "1_000",
        "2026-11-07",
        "x: y",
        "x # y",
        "é😀",
        "hello\nworld",
    ] {
        let docs = vec![Value::String(value.into())];
        assert_eq!(
            parse(&format_documents(&docs).unwrap(), Format::Kyaml).unwrap(),
            docs,
            "{value}"
        );
    }
}
#[test]
fn directive_text_inside_block_scalar_is_data() {
    let input = b"text: |\n  %TAG !e! tag:example.com,2000:\n  %YAML 1.1\n";
    assert!(
        parse(input, Format::Kyaml).unwrap()[0]["text"]
            .as_str()
            .unwrap()
            .contains("%YAML")
    );
}
#[test]
fn byte_encoding_and_numeric_boundaries() {
    for input in [
        b"\xff".as_slice(),
        b"a: 9007199254740992",
        b"a: -9007199254740992",
        b"a: 184467440737095516160000000",
        b"a: 1e999",
        b"a: 1\r",
        b"a: 1\r\rb: 2",
    ] {
        assert!(parse(input, Format::Kyaml).is_err());
    }
    for input in [b"a: 9007199254740991".as_slice(), b"a: -9007199254740991"] {
        assert!(parse(input, Format::Kyaml).is_ok());
    }
}
#[test]
fn aliases_cannot_cross_document_boundaries() {
    assert!(parse(b"a: &a value\n---\nb: *a\n", Format::Kyaml).is_err());
}

#[test]
fn escaped_single_quote_does_not_hide_a_multiline_scalar() {
    assert!(parse(b"x: 'a''b\n  c'", Format::Kyaml).is_err());
    assert_eq!(parse(b"x: 'a''b'", Format::Kyaml).unwrap()[0]["x"], "a'b");
}

#[test]
fn non_specific_tag_forces_a_plain_scalar_to_string() {
    assert_eq!(parse(b"a: ! true", Format::Kyaml).unwrap()[0]["a"], "true");
}

#[test]
fn large_scalar_aliases_cannot_bypass_the_storage_budget() {
    let mut input = format!("a: &a \"{}\"\n", "x".repeat(1024 * 1024));
    for n in 0..70 {
        input += &format!("copy{n}: *a\n");
    }
    let error = parse(input.as_bytes(), Format::Kyaml).unwrap_err();
    assert_eq!(error.code, "EXPANSION_LIMIT");
}

#[test]
fn explicit_tags_resolve_before_json_numeric_limits() {
    for (input, expected) in [
        ("!!float 9007199254740993", "9007199254740992"),
        ("!!float -9007199254740993", "-9007199254740992"),
        ("!!float 1", "1"),
        ("!!float \"1\"", "1"),
        ("!!str 9007199254740993", "\"9007199254740993\""),
    ] {
        assert_eq!(
            canonicalize(input.as_bytes(), Format::Kyaml).unwrap(),
            expected.as_bytes(),
            "{input}"
        );
    }
    for input in [
        "!!float 0xff",
        "!!float 0o17",
        "!!bool 9007199254740993",
        "!!null 9007199254740993",
        "!!int 1e400",
        "!!bool .inf",
    ] {
        let error = parse(input.as_bytes(), Format::Kyaml).unwrap_err();
        assert_eq!(error.code, "TAG_VALUE_MISMATCH", "{input}");
        assert_eq!((error.line, error.column), (1, 1), "{input}");
    }
    assert_eq!(
        parse(b"!!int 9007199254740993", Format::Kyaml)
            .unwrap_err()
            .code,
        "UNSAFE_INTEGER"
    );
    assert_eq!(
        parse(b"!!float 1e400", Format::Kyaml).unwrap_err().code,
        "NON_FINITE_NUMBER"
    );
}

#[test]
fn nonfinite_spellings_follow_core_schema_exactly() {
    for input in [".iNf", "+.iNf", "-.inF", ".nAn", ".NAn", "+.nan"] {
        assert_eq!(
            parse(input.as_bytes(), Format::Kyaml).unwrap(),
            vec![Value::String(input.into())]
        );
    }
    for input in [
        ".inf", ".Inf", ".INF", "+.Inf", "-.INF", ".nan", ".NaN", ".NAN",
    ] {
        assert_eq!(
            parse(input.as_bytes(), Format::Kyaml).unwrap_err().code,
            "NON_FINITE_NUMBER",
            "{input}"
        );
    }
}
