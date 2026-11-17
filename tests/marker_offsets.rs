// SPDX-License-Identifier: MPL-2.0
//! Property: block-scalar content width in UTF-8 bytes never changes how a
//! KYAML stream is read, and never panics.
use kyq::{Format, canonicalize, parse};
use proptest::prelude::*;

fn outcome(text: &str) -> Result<String, (&'static str, usize, usize, String)> {
    canonicalize(text.as_bytes(), Format::Kyaml)
        .map(|bytes| String::from_utf8(bytes).unwrap())
        .map_err(|e| (e.code, e.line, e.column, e.path))
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]
    #[test]
    fn block_scalar_width_is_invisible_to_later_tokens(
        content in "[a-zé日🦀ﻷ]{1,40}",
        tail in prop::sample::select(vec![
            "b: cd\n", "b: c\n d\n", "b: {x\n  : 1}\n", "b: \"q\n", "b: !!str 1\n",
            "- x\n", "b: [1,\n", "8", "",
        ]),
    ) {
        let ascii: String = content.chars().map(|_| 'z').collect();
        let wide = outcome(&format!("a: |\n  {content}\n{tail}"));
        let narrow = outcome(&format!("a: |\n  {ascii}\n{tail}"));
        match (wide, narrow) {
            (Ok(w), Ok(n)) => prop_assert_eq!(w, n.replace(&ascii, &content)),
            (Err(w), Err(n)) => prop_assert_eq!(w, n),
            (w, n) => prop_assert!(false, "{:?} vs ASCII {:?}", w, n),
        }
    }
}

/// yaml-rust2 advances `Marker::index` by UTF-8 bytes across block-scalar
/// content. A ClusterFuzzLite AddressSanitizer run (via docmatrix) found a
/// stream whose later marker pointed past the input and panicked in
/// `lexical_checks`.
#[test]
fn fuzz_crash_block_scalar_marker_overshoot_is_handled() {
    let input =
        include_bytes!("fixtures/regressions/kyaml-crash-5d852488d72c6abfe71fdfc935ab70d80948e3ce");
    // Either outcome is acceptable; reaching it without a panic is the property.
    let _ = parse(input, Format::Kyaml);
    let _ = canonicalize(input, Format::Kyaml);
}

/// Multi-byte block-scalar content must not move any later diagnostic: each
/// document behaves exactly as it does with ASCII content of equal length.
#[test]
fn multibyte_block_scalars_keep_later_positions() {
    let templates = [
        "a: |\n  {}\nb: cd\n",
        "a: >\n  {}\n  more\nb: 'x'\n",
        "a: |\n  {}\nb: !!str 1\n",
        "a: |\n  {}\nb: &x 1\nc: *x\n",
        "a: |\n  {}\nb: c\n d\n",
        "a: |\n  {}\nb: {{x\n  : 1}}\n",
        "a: |\n  {}\nb: \"q\n",
        "- |\n  {}\n- \"x\" y\n",
        "|\n {}\n8",
    ];
    for content in ["ﻷﻷﻷﻷ", "日本語のテキスト", "é", "🦀🦀", "aé🦀ﻷ"] {
        let ascii = "z".repeat(content.chars().count());
        for template in templates {
            let wide = template
                .replace("{}", content)
                .replace("{{", "{")
                .replace("}}", "}");
            let narrow = template
                .replace("{}", &ascii)
                .replace("{{", "{")
                .replace("}}", "}");
            match (
                canonicalize(wide.as_bytes(), Format::Kyaml),
                canonicalize(narrow.as_bytes(), Format::Kyaml),
            ) {
                (Ok(w), Ok(n)) => assert_eq!(
                    String::from_utf8(w).unwrap(),
                    String::from_utf8(n).unwrap().replace(&ascii, content),
                    "{wide:?}"
                ),
                (Err(w), Err(n)) => assert_eq!(
                    (w.code, w.line, w.column, w.path),
                    (n.code, n.line, n.column, n.path),
                    "{wide:?}"
                ),
                (w, n) => panic!("{wide:?}: {w:?} but ASCII gives {n:?}"),
            }
        }
    }
}
