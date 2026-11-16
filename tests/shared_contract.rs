// SPDX-License-Identifier: MPL-2.0
use kyq::Format;
use proven_evidence::parser_contract::{self, Case, Expected};

#[test]
fn reusable_positive_and_negative_parser_contract() {
    for (format, valid, invalid) in [
        (Format::Json, r#"{"b":true,"a":2}"#, r#"{"a":1,"a":2}"#),
        (Format::Kyaml, "b: true\na: 2", "a: 1\na: 2"),
        (Format::Dhall, "{ b = True, a = 1 + 1 }", "1 + True"),
    ] {
        let cases = [
            Case {
                id: "canonical-order".into(),
                input: valid.as_bytes().to_vec(),
                expected: Expected::Canonical(br#"{"a":2,"b":true}"#.to_vec()),
            },
            Case {
                id: "invalid-data".into(),
                input: invalid.as_bytes().to_vec(),
                expected: Expected::Reject,
            },
        ];
        let observed = parser_contract::run(&cases, |input| {
            kyq::canonicalize(input, format).map_err(|e| e.to_string())
        })
        .unwrap();
        parser_contract::require_pass(&observed).unwrap();
    }
}
