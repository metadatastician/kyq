// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell
//! TOML is a validity gate, not a JSON or KYAML projection.
use std::{
    io::Write,
    process::{Command, Output, Stdio},
};

fn run(args: &[&str], input: &[u8]) -> Output {
    let mut process = Command::new(env!("CARGO_BIN_EXE_kyq"))
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    if let Err(error) = process.stdin.take().unwrap().write_all(input) {
        assert_eq!(error.kind(), std::io::ErrorKind::BrokenPipe, "{error}");
    }
    process.wait_with_output().unwrap()
}

#[test]
fn toml_10_typed_documents_are_valid_without_projection() {
    for bytes in [
        &b"# SPDX-License-Identifier: CC0-1.0\r\ntitle = \"example\"\r\nwhen = 2026-11-23T12:30:45Z\r\nwhere = 2026-11-23T14:30:45+02:00\r\ndate = 2026-11-23\r\ntime = 12:30:45\r\nlarge = 9_007_199_254_740_993\r\nnonfinite = +inf\r\n[[samples]]\r\nname = 'first'\r\n[[samples]]\r\nname = 'second'\r\n"[..],
        &b"array = [1, 2, 3]\ninline = { a = 1, b = true }\n"[..],
        &b"# a comment-only TOML document\n"[..],
        &b""[..],
    ] {
        kyq::validate_toml(bytes).unwrap();
        let output = run(&["validate", "--from", "toml", "-"], bytes);
        assert_eq!(output.status.code(), Some(0), "{}", String::from_utf8_lossy(&output.stderr));
        assert!(output.stdout.is_empty());
        assert!(output.stderr.is_empty());
    }
}

#[test]
fn toml_10_rejects_duplicates_and_invalid_utf8() {
    for bytes in [
        &b"a = 1\na = 2\n"[..],
        &b"a.b = 1\n[a]\nb = 2\n"[..],
        &b"date = 2026-13-01\n"[..],
        &b"n = 9223372036854775808\n"[..],
        &b"n = 01\n"[..],
        &b"bad = \"unclosed\n"[..],
        &b"\xff\n"[..],
    ] {
        assert!(kyq::validate_toml(bytes).is_err(), "{:?}", bytes);
        let output = run(&["validate", "--from", "toml"], bytes);
        assert_eq!(output.status.code(), Some(2));
        assert!(output.stdout.is_empty());
        assert!(!output.stderr.is_empty());
    }
}

#[test]
fn toml_11_only_syntax_is_not_accepted_as_toml_10() {
    for bytes in [
        &b"escape = \"\\e\"\n"[..],
        &b"escape = \"\\x41\"\n"[..],
        &b"shorttime = 12:34\n"[..],
        &b"inline = { a = 1, }\n"[..],
        &b"inline = {\n  a = 1\n}\n"[..],
    ] {
        let error = kyq::validate_toml(bytes).unwrap_err();
        assert_eq!(error.code, "INVALID_TOML", "{:?}: {error}", bytes);
    }
}

#[test]
fn toml_only_supports_validate_and_keeps_existing_files_identical() {
    let before = b"# SPDX-License-Identifier: MPL-2.0\r\nwhen = 2026-11-23T12:30:45Z\r\n";
    let dir = std::env::temp_dir();
    let path = dir.join(format!(
        "kyq-toml-{}-{}.toml",
        std::process::id(),
        "validate"
    ));
    std::fs::write(&path, before).unwrap();
    let argument = path.to_str().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_kyq"))
        .args(["validate", "--from", "toml", argument])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(std::fs::read(&path).unwrap(), before);
    for operation in ["canon", "fmt", "to-json", "get", "check"] {
        let output = Command::new(env!("CARGO_BIN_EXE_kyq"))
            .args([operation, "--from", "toml", argument])
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2), "{operation}");
        assert!(output.stdout.is_empty(), "{operation}");
        assert!(String::from_utf8_lossy(&output.stderr).contains("UNSUPPORTED_OPERATION"));
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }
    std::fs::remove_file(path).unwrap();
}

#[test]
fn toml_input_budget_and_diagnostics_are_bounded() {
    let over = vec![b' '; kyq::MAX_INPUT_BYTES + 1];
    let error = kyq::validate_toml(&over).unwrap_err();
    assert_eq!(error.code, "INPUT_LIMIT");
    let error = kyq::validate_toml(b"\xff").unwrap_err();
    assert_eq!(error.code, "INVALID_UTF8");
    let error = kyq::validate_toml(b"good = 1\nbad = [\n").unwrap_err();
    assert_eq!(error.code, "INVALID_TOML");
    assert!(error.line >= 2, "{error}");
}
