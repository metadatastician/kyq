// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell
use kyq::{Format, Value};
use proptest::prelude::*;

fn text() -> impl Strategy<Value = String> {
    "[a-zA-Z0-9~:/ #\\n\\t'\"é😀]{0,40}"
}
fn values() -> impl Strategy<Value = Value> {
    prop_oneof![
        Just(Value::Null),
        any::<bool>().prop_map(Value::Bool),
        (-9_007_199_254_740_991i64..=9_007_199_254_740_991).prop_map(Value::from),
        // R3 excludes large integer-shaped floats; those refusals have
        // separate regression coverage in r3_numeric_closure.rs.
        (-1e15f64..1e15f64).prop_map(Value::from),
        text().prop_map(Value::String),
    ]
    .prop_recursive(4, 96, 8, |inner| {
        prop_oneof![
            prop::collection::vec(inner.clone(), 0..8).prop_map(Value::Array),
            prop::collection::btree_map(text(), inner, 0..8)
                .prop_map(|map| Value::Object(map.into_iter().collect())),
        ]
    })
}
proptest! {
    #![proptest_config(ProptestConfig::with_cases(1024))]
    #[test]
    fn nested_values_preserve_canonical_meaning_and_formatter_stability(value in values()) {
        let docs = vec![value];
        let expected = kyq::canonicalize_documents(&docs).unwrap();
        let yaml = kyq::format_documents(&docs).unwrap();
        let parsed = kyq::parse(&yaml, Format::Kyaml).unwrap();
        prop_assert_eq!(kyq::canonicalize_documents(&parsed).unwrap(), expected);
        prop_assert_eq!(kyq::format_documents(&parsed).unwrap(), yaml);
    }
    #[test]
    fn arbitrary_bounded_bytes_return_without_panicking(bytes in prop::collection::vec(any::<u8>(), 0..1024)) {
        let _ = kyq::parse(&bytes, Format::Kyaml);
        let _ = kyq::parse(&bytes, Format::Json);
    }
}
