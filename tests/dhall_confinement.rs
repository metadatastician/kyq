// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell
//! W7: the CLI evaluates Dhall in a confined worker. A costly input ends
//! with a typed refusal (exit 2) inside the stated limits, and ordinary
//! input gives the same bytes as the in-process library.
use std::{
    io::Write,
    process::{Command, Output, Stdio},
    sync::{Mutex, MutexGuard},
    time::{Duration, Instant},
};

fn invoke(args: &[&str], input: &[u8]) -> (Output, Duration) {
    let start = Instant::now();
    let mut child = Command::new(env!("CARGO_BIN_EXE_kyq"))
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    if let Err(error) = child.stdin.take().unwrap().write_all(input) {
        assert_eq!(error.kind(), std::io::ErrorKind::BrokenPipe, "{error}");
    }
    let output = child.wait_with_output().unwrap();
    (output, start.elapsed())
}

/// The costly tests race each other for CPU and memory. On a small CI
/// runner the memory and stack tests then hit the wall-clock limit first.
/// They take this lock so they run one at a time.
fn costly() -> MutexGuard<'static, ()> {
    static COSTLY: Mutex<()> = Mutex::new(());
    COSTLY
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Assert a refusal with `code` on stderr, exit 2 and nothing on stdout.
fn assert_refused(source: &str, code: &str) -> Duration {
    let (out, elapsed) = invoke(&["validate", "--from", "dhall", "-"], source.as_bytes());
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert_eq!(out.status.code(), Some(2), "{stderr}");
    assert!(stderr.starts_with(&format!("kyq: {code}: ")), "{stderr}");
    assert!(out.stdout.is_empty());
    elapsed
}

/// Six nested 40-step folds: about 4e9 steps, shallow recursion.
fn slow_source() -> String {
    let mut step = String::from(r"(\(x: Natural) -> x + 1)");
    for _ in 0..6 {
        step = format!(r"(\(x: Natural) -> Natural/fold 40 Natural {step} x)");
    }
    format!("{step} 0")
}

/// Thirty let-bound doublings of 64 bytes of Text: 64 GiB if unbounded.
fn large_source() -> String {
    let mut source = String::from(
        "let a0 = \"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\" in ",
    );
    for i in 1..=30 {
        source.push_str(&format!("let a{i} = a{p} ++ a{p} in ", p = i - 1));
    }
    source.push_str("a30");
    source
}

#[test]
fn costly_time_ends_with_dhall_time_limit() {
    let _one_at_a_time = costly();
    let elapsed = assert_refused(&slow_source(), "DHALL_TIME_LIMIT");
    let limit = Duration::from_millis(kyq::DHALL_TIME_LIMIT_MS);
    assert!(elapsed >= limit, "refused before the limit: {elapsed:?}");
    // The kill is prompt: generous slack for slow CI runners.
    assert!(elapsed < limit * 5, "kill took too long: {elapsed:?}");
}

#[test]
fn costly_memory_ends_with_dhall_memory_limit() {
    let _one_at_a_time = costly();
    let elapsed = assert_refused(&large_source(), "DHALL_MEMORY_LIMIT");
    assert!(
        elapsed < Duration::from_millis(kyq::DHALL_TIME_LIMIT_MS),
        "memory refusal should come before the time limit: {elapsed:?}"
    );
}

#[test]
fn deep_evaluation_ends_with_dhall_stack_limit() {
    let _one_at_a_time = costly();
    // Before W7 this aborted the kyq process itself (SIGABRT, exit 134).
    assert_refused(
        r"Natural/fold 1000000 Natural (\(x: Natural) -> x + 1) 0",
        "DHALL_STACK_LIMIT",
    );
}

#[test]
fn worker_keeps_existing_refusals() {
    assert_refused("env:HOME as Text", "INVALID_DHALL");
    assert_refused("{ a = ", "INVALID_DHALL");
    assert_refused("{ a = 9007199254740993 }", "INVALID_IJSON");
}

#[test]
fn confined_output_matches_the_library() {
    let sources = [
        "{ b = True, a = 2 }",
        "{ n = -3, d = 1.5, z = 0.0, big = 9007199254740991, t = \"caf\\u00E9 \\n\" }",
        "{ xs = [1, 2, 3], ys = [] : List Natural, nested = { k = [{ v = 2.0 }] } }",
        "[ { a = 1 }, { a = 2 } ]",
        "Some 4",
        "\"plain\"",
    ];
    for source in sources {
        let docs = kyq::parse(source.as_bytes(), kyq::Format::Dhall).unwrap();
        let expected_canon = kyq::canonicalize_documents(&docs).unwrap();
        let expected_fmt = kyq::format_documents(&docs).unwrap();
        for (command, expected) in [("canon", &expected_canon), ("fmt", &expected_fmt)] {
            let (out, _) = invoke(&[command, "--from", "dhall", "-"], source.as_bytes());
            assert!(
                out.status.success(),
                "{command} {source}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
            assert_eq!(&out.stdout, expected, "{command} {source}");
        }
    }
}

#[test]
fn worker_mode_takes_no_arguments() {
    let (out, _) = invoke(&["--dhall-worker", "extra"], b"1");
    assert_eq!(out.status.code(), Some(2));
}

/// Owner ruling 2026-11-27: Dhall `NaN` and `±Infinity` are refused, as KYAML
/// `.nan` and `.inf` are, instead of becoming `null`.
#[test]
fn non_finite_doubles_are_refused_not_nulled() {
    for source in [
        "{ a = NaN }",
        "{ b = { c = [ 1.0, -Infinity ] } }",
        "Some Infinity",
    ] {
        assert_refused(source, "NON_FINITE_NUMBER");
        let error = kyq::parse(source.as_bytes(), kyq::Format::Dhall).unwrap_err();
        assert_eq!(error.code, "NON_FINITE_NUMBER", "{source}");
    }
    let (out, _) = invoke(
        &["validate", "--from", "dhall", "-"],
        b"{ b = { c = [ 1.0, -Infinity ] } }",
    );
    assert!(
        String::from_utf8_lossy(&out.stderr)
            .contains("Dhall -Infinity has no JSON form (at /b/c/1)")
    );
    let (out, _) = invoke(
        &["to-json", "--from", "dhall", "-"],
        b"{ d = 1.5, e = Some 2.0 }",
    );
    assert_eq!(out.stdout, b"{\"d\":1.5,\"e\":2}\n");
}
