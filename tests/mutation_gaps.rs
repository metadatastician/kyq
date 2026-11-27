// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell
//! W8 part 3: tests for mutants that `cargo mutants` showed no test caught.
//!
//! Each test pins behaviour that KYAML_SPEC states and kyq already has. The
//! campaign and its remaining misses are recorded in `docs/ASSURANCE.adoc`.
use kyq::{Format, fix_bytes, format_documents, parse};

fn fmt(input: &str) -> String {
    String::from_utf8(format_documents(&parse(input.as_bytes(), Format::Kyaml).unwrap()).unwrap())
        .unwrap()
}

fn fix(input: &str) -> Result<String, (&'static str, usize, usize)> {
    fix_bytes(input.as_bytes(), Format::Kyaml)
        .map(|b| String::from_utf8(b).unwrap())
        .map_err(|e| (e.code, e.line, e.column))
}

fn located(input: &str) -> (&'static str, usize, usize) {
    let e = parse(input.as_bytes(), Format::Kyaml).unwrap_err();
    (e.code, e.line, e.column)
}

/// The anchor's own text and storage count towards the 64 MiB expansion
/// budget, as well as each alias copy: (2 + copies) x (1 MiB + 64) bytes.
#[test]
fn the_anchor_itself_counts_towards_the_expansion_budget() {
    let stream = |copies: usize| {
        let mut input = format!("a: &a \"{}\"\n", "x".repeat(1024 * 1024));
        for n in 0..copies {
            input += &format!("c{n}: *a\n");
        }
        parse(input.as_bytes(), Format::Kyaml).map_err(|e| e.code)
    };
    assert!(stream(61).is_ok());
    assert_eq!(stream(62).unwrap_err(), "EXPANSION_LIMIT");
}

/// KYAML_SPEC §resolution: `0o` octal and `0x` hex plain scalars are ints.
#[test]
fn octal_and_hex_plain_scalars_are_integers() {
    assert_eq!(fmt("a: 0x1F\nb: 0o17\nc: 10\n"), "a: 31\nb: 15\nc: 10\n");
    assert_eq!(fmt("a: !!int 0x1F\n"), "a: 31\n");
    assert_eq!(located("a: !!float 0x1F\n").0, "TAG_VALUE_MISMATCH");
}

/// The canonical form writes numbers as JCS does, with no `.0` below 2^53.
#[test]
fn the_formatter_writes_numbers_as_jcs_text() {
    assert_eq!(fmt("x: 1.0\n"), "x: 1\n");
    assert_eq!(fmt("x: -0.0\n"), "x: 0\n");
    assert_eq!(fmt("x: 9007199254740991.0\n"), "x: 9007199254740991\n");
    assert_eq!(fmt("x: 1e21\n"), "x: 1e+21\n");
}

#[test]
fn the_formatter_quotes_strings_that_read_as_sequence_entries() {
    assert_eq!(fmt("x: \"- a\"\n"), "x: \"- a\"\n");
    assert_eq!(fmt("x: \"-\"\n"), "x: \"-\"\n");
}

#[test]
fn nested_sequences_are_written_in_block_style() {
    assert_eq!(fmt("x: [[1], []]\n"), "x:\n  - - 1\n  - []\n");
}

#[test]
fn double_quoted_escapes_do_not_end_the_scalar() {
    assert_eq!(
        parse(br#"a: "x\"y""#, Format::Kyaml).unwrap()[0]["a"],
        "x\"y"
    );
    assert_eq!(parse(br#"a: "x\\""#, Format::Kyaml).unwrap()[0]["a"], "x\\");
    assert_eq!(parse(b"a: 'it''s'", Format::Kyaml).unwrap()[0]["a"], "it's");
}

/// `fix` refuses a stream whose comments it would drop, and only that: a `#`
/// inside a block scalar, a quoted scalar or a plain word is content.
#[test]
fn fix_keeps_hash_signs_that_are_content() {
    for input in [
        "a: |\n\n  x # in\n",
        "a: >\n\n\n  x # in\n",
        "a: |\n  one\n\n  two # in\n",
        "a: |\n  x\n  # in\nb: 2\n",
        "a: \"x\\\" # y\"\n",
        "a: 'it''s # y'\n",
        "a: b#c\n",
    ] {
        assert!(fix(input).is_ok(), "{input:?}: {:?}", fix(input));
    }
}

#[test]
fn fix_refuses_comments_it_would_drop() {
    assert_eq!(
        fix("a: |\n  x\n# real\nb: 1\n").unwrap_err(),
        ("COMMENTS_WOULD_BE_LOST", 3, 1)
    );
    assert_eq!(
        fix("a: \"x\" # real\n").unwrap_err(),
        ("COMMENTS_WOULD_BE_LOST", 1, 8)
    );
    assert_eq!(
        fix("a: \"x\\\\\"\nb: 1 # real\n").unwrap_err(),
        ("COMMENTS_WOULD_BE_LOST", 2, 6)
    );
}

/// Columns count code points, and a leading byte-order mark is not a column.
#[test]
fn diagnostic_columns_count_code_points_after_a_byte_order_mark() {
    assert_eq!(located("a: \"é\\q\"\n"), ("BAD_ESCAPE", 1, 4));
    assert_eq!(located("\u{feff}é: \"\\q\"\n"), ("BAD_ESCAPE", 1, 4));
    assert_eq!(located("é: 1\né: 2\n"), ("DUPLICATE_KEY", 2, 1));
    assert_eq!(located("k: {a: 1, a: 2}\n"), ("DUPLICATE_KEY", 1, 11));
    assert_eq!(located("a:\n  - 1\n  b: 2\n"), ("UNEXPECTED_CONTENT", 3, 3));
}
