// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell
//! Regression contracts for owner ruling R3 on the estate-strict input path.
use kyq::{Format, canonicalize, parse};

#[test]
fn strict_json_rejects_integer_shaped_floats_outside_safe_range() {
    for input in [
        "1e18",
        "-1e18",
        "1e20",
        "9007199254740992.0",
        "9007199254740993.0",
        "18446744073709551616.0",
    ] {
        let error = parse(input.as_bytes(), Format::Json).unwrap_err();
        assert_eq!(error.code, "UNSAFE_FLOAT_INTEGER", "{input}: {error}");
        assert!(
            canonicalize(input.as_bytes(), Format::Json).is_err(),
            "{input}"
        );
    }
}

#[test]
fn strict_kyaml_rejects_unsafe_float_values_at_any_depth() {
    for input in [
        "a: !!float 1e18\n",
        "a: [!!float 1e18]\n",
        "a:\n  b: !!float -1e18\n",
    ] {
        let error = parse(input.as_bytes(), Format::Kyaml).unwrap_err();
        assert_eq!(error.code, "UNSAFE_FLOAT_INTEGER", "{input}: {error}");
    }
}

#[test]
fn strict_canon_outputs_are_valid_strict_inputs() {
    for (input, format) in [
        ("1e15", Format::Json),
        ("1e21", Format::Json),
        ("-0.0", Format::Json),
        ("a: !!float 1e15\n", Format::Kyaml),
    ] {
        let bytes = canonicalize(input.as_bytes(), format).unwrap();
        assert!(parse(&bytes, Format::Json).is_ok(), "{input}");
        assert_eq!(
            canonicalize(&bytes, Format::Json).unwrap(),
            bytes,
            "{input}"
        );
    }
}

#[test]
fn explicit_jcs_mode_remains_a_separate_binary64_contract() {
    let bytes = canonicalize(b"1e18", Format::Jcs).unwrap();
    assert_eq!(bytes, b"1000000000000000000");
    assert!(parse(&bytes, Format::Jcs).is_ok());
    assert!(parse(&bytes, Format::Json).is_err());
}
