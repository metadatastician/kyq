// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell
use std::{
    io::Write,
    process::{Command, Output, Stdio},
};

fn invoke(args: &[&str], input: &[u8]) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_kyq"))
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(input).unwrap();
    child.wait_with_output().unwrap()
}

#[test]
fn canonical_bytes_agree_across_three_frontends() {
    for (format, input) in [
        ("kyaml", "b: true\na: 2\n"),
        ("json", "{\"b\":true,\"a\":2}"),
        ("dhall", "{ b = True, a = 2 }"),
    ] {
        let out = invoke(&["canon", "--from", format, "-"], input.as_bytes());
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert_eq!(out.stdout, br#"{"a":2,"b":true}"#);
        assert!(out.stderr.is_empty());
    }
}

#[test]
fn check_distinguishes_drift_from_invalid_input_without_output() {
    for (input, status) in [("a: 1\n", 0), ("a:  1\n", 1), ("a: 1\na: 2\n", 2)] {
        let out = invoke(&["check"], input.as_bytes());
        assert_eq!(out.status.code(), Some(status));
        assert!(out.stdout.is_empty());
    }
}

#[test]
fn invalid_command_or_pointer_and_multi_document_canon_fail_closed() {
    for (args, input) in [
        (vec!["unknown"], "a: 1\n"),
        (vec!["get", "--pointer", "/missing"], "a: 1\n"),
        (vec!["canon"], "a: 1\n---\na: 2\n"),
        (vec!["validate", "--from", "dhall"], "env:HOME as Text"),
    ] {
        let out = invoke(&args, input.as_bytes());
        assert_eq!(out.status.code(), Some(2));
        assert!(out.stdout.is_empty());
        assert!(!out.stderr.is_empty());
    }
}

#[test]
fn filenames_with_spaces_and_escaped_pointer_tokens_are_supported() {
    let path = std::env::temp_dir().join(format!("kyq CLI {}.yaml", std::process::id()));
    std::fs::write(&path, b"a/b:\n  '~key': 42\n").unwrap();
    let out = invoke(
        &["get", "--pointer", "/a~1b/~0key", path.to_str().unwrap()],
        b"",
    );
    std::fs::remove_file(path).unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(out.stdout, b"42\n");
}

#[test]
fn malformed_pointer_escapes_are_rejected_even_when_a_literal_key_exists() {
    for pointer in ["/a~2", "/a~", "a"] {
        let out = invoke(&["get", "--pointer", pointer], b"a~2: 1\na~: 2\na: 3\n");
        assert_eq!(out.status.code(), Some(2));
        assert!(out.stdout.is_empty());
        assert!(String::from_utf8_lossy(&out.stderr).contains("INVALID_POINTER"));
    }
}

#[cfg(unix)]
#[test]
fn non_utf8_arguments_are_errors_not_panics() {
    use std::os::unix::ffi::OsStringExt;
    let out = Command::new(env!("CARGO_BIN_EXE_kyq"))
        .arg("validate")
        .arg(std::ffi::OsString::from_vec(vec![0xff]))
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(out.stdout.is_empty());
    assert!(!String::from_utf8_lossy(&out.stderr).contains("panicked"));
}

#[test]
fn explicit_jcs_input_preserves_the_numeric_wire_format() {
    let canonical = invoke(&["canon", "--from", "json"], b"1e16");
    assert!(canonical.status.success());
    assert_eq!(canonical.stdout, b"10000000000000000");
    let strict = invoke(&["canon", "--from", "json"], &canonical.stdout);
    assert_eq!(strict.status.code(), Some(2));
    let wire = invoke(&["canon", "--from", "jcs"], &canonical.stdout);
    assert!(wire.status.success());
    assert_eq!(wire.stdout, canonical.stdout);
    let checked = invoke(&["check", "--from", "jcs"], b"10000000000000000\n");
    assert_eq!(checked.status.code(), Some(0));
    assert!(checked.stdout.is_empty());
}
