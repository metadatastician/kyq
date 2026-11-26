// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell
//! Native `fix` (ULTRAPLAN W5, owner ruling A-06: fail closed, keep SPDX).
//!
//! The expected bytes and refusal positions are the oracle's own, from
//! `conformance/test/fix-comments.test.js`, on the same committed fixtures.
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
};

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/conformance/fixtures/kyaml");

fn kyq(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_kyq"))
        .args(args)
        .output()
        .unwrap()
}

/// A fresh scratch directory, removed when dropped.
struct Scratch(PathBuf);

impl Scratch {
    fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("kyq-fix-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
    fn write(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let path = self.0.join(name);
        fs::write(&path, bytes).unwrap();
        path
    }
    fn entries(&self) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(&self.0)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn fixture(name: &str) -> Vec<u8> {
    fs::read(Path::new(FIXTURES).join(name)).unwrap()
}

fn path(p: &Path) -> &str {
    p.to_str().unwrap()
}

const ACCEPTED: [(&str, &str); 4] = [
    (
        "spdx-header.yaml",
        "# SPDX-License-Identifier: MPL-2.0\n# SPDX-FileCopyrightText: 2026 Example\n\n# Free-form header note.\napiVersion: v1\nkind: Namespace\nmetadata:\n  name: demo\n  labels:\n    tier: web\n",
    ),
    (
        "spdx-header-crlf.yaml",
        "# SPDX-License-Identifier: MPL-2.0\r\n\r\nmetadata:\n  name: demo\n",
    ),
    (
        "header-only.yaml",
        "# SPDX-License-Identifier: MPL-2.0\n# nothing else\n",
    ),
    ("no-header.yaml", "a:\n  b: 1\n"),
];

const REFUSED: [(&str, usize, usize); 4] = [
    ("interior-comment.yaml", 4, 1),
    ("trailing-comment.yaml", 2, 16),
    ("eof-comment.yaml", 3, 1),
    ("directive-comment.yaml", 1, 11),
];

#[test]
fn every_oracle_fix_fixture_is_covered() {
    let mut files: Vec<String> = fs::read_dir(Path::new(FIXTURES).join("fix"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    files.sort();
    let mut expected: Vec<String> = ACCEPTED
        .iter()
        .map(|(n, _)| n.to_string())
        .chain(REFUSED.iter().map(|(n, _, _)| n.to_string()))
        .collect();
    expected.sort();
    assert_eq!(files, expected);
}

#[test]
fn fix_keeps_the_header_and_is_idempotent_with_check() {
    for (name, expected) in ACCEPTED {
        let dir = Scratch::new(&format!("ok-{name}"));
        let file = dir.write("case.yaml", &fixture(&format!("fix/{name}")));
        let first = kyq(&["fix", path(&file)]);
        assert_eq!(first.status.code(), Some(0), "{name}: {first:?}");
        assert_eq!(fs::read_to_string(&file).unwrap(), expected, "{name}");
        // check(fix x) succeeds, and a second fix is a no-op that says OK.
        assert_eq!(
            kyq(&["check", path(&file)]).status.code(),
            Some(0),
            "{name}"
        );
        let second = kyq(&["fix", path(&file)]);
        assert_eq!(second.status.code(), Some(0), "{name}");
        assert_eq!(
            String::from_utf8_lossy(&second.stdout),
            format!("OK {}\n", file.display())
        );
        assert_eq!(fs::read_to_string(&file).unwrap(), expected, "{name}");
        assert_eq!(
            dir.entries(),
            ["case.yaml"],
            "{name}: no temporary file left"
        );
    }
}

#[test]
fn fix_refuses_a_lost_comment_and_leaves_the_file_untouched() {
    for (name, line, column) in REFUSED {
        let dir = Scratch::new(&format!("refuse-{name}"));
        let input = fixture(&format!("fix/{name}"));
        let file = dir.write("case.yaml", &input);
        let out = kyq(&["fix", path(&file)]);
        assert_eq!(out.status.code(), Some(2), "{name}");
        assert!(out.stdout.is_empty(), "{name}");
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(
            stderr.contains("COMMENTS_WOULD_BE_LOST: formatting would drop this comment")
                && stderr.contains(&format!("(line {line}, column {column},")),
            "{name}: {stderr}"
        );
        assert_eq!(fs::read(&file).unwrap(), input, "{name}: file modified");
        assert_eq!(dir.entries(), ["case.yaml"], "{name}");
    }
}

#[test]
fn fix_never_modifies_an_invalid_file() {
    let dir = Scratch::new("invalid");
    for input in [
        b"a: 1\na: 2\n".as_slice(),
        b"a: [1, 2\n",
        b"a: \xff\n",
        b"{\"a\":1,\"a\":2}",
    ] {
        let file = dir.write("bad.yaml", input);
        let out = kyq(&["fix", path(&file)]);
        assert_eq!(out.status.code(), Some(2), "{input:?}");
        assert!(out.stdout.is_empty());
        assert_eq!(fs::read(&file).unwrap(), input);
    }
    assert_eq!(dir.entries(), ["bad.yaml"]);
}

#[test]
fn the_spdx_line_survives_fix_on_every_valid_corpus_fixture() {
    let corpus: serde_json::Value = serde_json::from_slice(&fixture("cases.json")).unwrap();
    let spdx = b"# SPDX-License-Identifier: MPL-2.0\n";
    let mut fixed = 0;
    for case in corpus["cases"].as_array().unwrap() {
        if case["expect"] != "valid" {
            continue;
        }
        let name = case["file"].as_str().unwrap();
        let dir = Scratch::new("spdx");
        let mut input = spdx.to_vec();
        input.extend(fixture(name));
        let file = dir.write("case.yaml", &input);
        let out = kyq(&["fix", path(&file)]);
        let after = fs::read(&file).unwrap();
        match out.status.code() {
            Some(0) => {
                fixed += 1;
                assert!(after.starts_with(spdx), "{name}: SPDX line lost");
                assert_eq!(
                    kyq(&["check", path(&file)]).status.code(),
                    Some(0),
                    "{name}"
                );
                assert_eq!(kyq(&["fix", path(&file)]).status.code(), Some(0), "{name}");
                assert_eq!(fs::read(&file).unwrap(), after, "{name}: not idempotent");
            }
            Some(2) => assert_eq!(after, input, "{name}: refused but modified"),
            other => panic!("{name}: unexpected exit {other:?}"),
        }
    }
    assert!(fixed > 10, "only {fixed} fixtures were fixed");
}

#[test]
fn scalar_text_that_looks_like_a_comment_is_kept() {
    let dir = Scratch::new("scalars");
    for (input, expected) in [
        ("a: |\n  x # y\nb: 1\n", "a: \"x # y\\u000a\"\nb: 1\n"),
        (
            "a: >\n  folded # not\n  more\n",
            "a: \"folded # not more\\u000a\"\n",
        ),
        ("a: 'x # y'\nb: \"p # q\"\n", "a: \"x # y\"\nb: \"p # q\"\n"),
        ("a:\n  |\n  x # y\n", "a: \"x # y\\u000a\"\n"),
    ] {
        let file = dir.write("s.yaml", input.as_bytes());
        let out = kyq(&["fix", path(&file)]);
        assert_eq!(out.status.code(), Some(0), "{input:?}: {out:?}");
        assert_eq!(fs::read_to_string(&file).unwrap(), expected, "{input:?}");
    }
}

#[test]
fn comments_around_block_scalars_are_refused() {
    let dir = Scratch::new("blocks");
    for (input, line, column) in [
        ("a: |\n  x\n# c\nb: 1\n", 3, 1),
        ("a: |+\n  x\n\n# c\nb: 1\n", 4, 1),
        ("a: |\n# c\nb: 1\n", 2, 1),
        ("a: | # c\n  x\n", 1, 6),
        ("- a: |\n    x\n  # c\n  b: 1\n", 3, 3),
        ("a: |\n  # content\n # c\nb: 1\n", 3, 2),
        ("a: |\n\n  # x\n\n  y\n# c\n", 6, 1),
        ("a: [1, # c\n  2]\n", 1, 8),
        ("--- # c\na: 1\n", 1, 5),
        // Conservative: with an explicit indentation indicator a `#` line is
        // refused even when YAML reads it as content. The oracle accepts it.
        ("a: |2\n    # four\n  # two\nb: 1\n", 3, 3),
    ] {
        let file = dir.write("b.yaml", input.as_bytes());
        let out = kyq(&["fix", path(&file)]);
        assert_eq!(out.status.code(), Some(2), "{input:?}");
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(
            stderr.contains("COMMENTS_WOULD_BE_LOST")
                && stderr.contains(&format!("(line {line}, column {column},")),
            "{input:?}: {stderr}"
        );
        assert_eq!(fs::read_to_string(&file).unwrap(), input);
    }
}

#[test]
fn fix_writes_json_and_jcs_as_canonical_bytes_plus_newline() {
    let dir = Scratch::new("json");
    let file = dir.write("a.json", b"{ \"b\": true, \"a\": 2 }");
    let out = kyq(&["fix", "--from", "json", path(&file)]);
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    assert_eq!(fs::read(&file).unwrap(), b"{\"a\":2,\"b\":true}\n");
    assert_eq!(
        kyq(&["check", "--from", "json", path(&file)]).status.code(),
        Some(0)
    );
    let file = dir.write("b.json", b"[1.50]");
    assert_eq!(
        kyq(&["fix", "--from", "jcs", path(&file)]).status.code(),
        Some(0)
    );
    assert_eq!(fs::read(&file).unwrap(), b"[1.5]\n");
}

#[test]
fn fix_refuses_stdin_dhall_toml_and_non_regular_files() {
    let dir = Scratch::new("refusals");
    for args in [vec!["fix"], vec!["fix", "-"]] {
        let out = kyq(&args);
        assert_eq!(out.status.code(), Some(2));
        assert!(String::from_utf8_lossy(&out.stderr).contains("requires a FILE"));
    }
    let dhall = dir.write("a.dhall", b"{ x = 1 }");
    let toml = dir.write("a.toml", b"x = 1\n");
    for (format, file) in [("dhall", &dhall), ("toml", &toml)] {
        let before = fs::read(file).unwrap();
        let out = kyq(&["fix", "--from", format, path(file)]);
        assert_eq!(out.status.code(), Some(2), "{format}");
        assert!(String::from_utf8_lossy(&out.stderr).contains("UNSUPPORTED_OPERATION"));
        assert_eq!(fs::read(file).unwrap(), before);
    }
    let out = kyq(&["fix", path(&dir.0)]);
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("regular file"));
}

#[cfg(unix)]
#[test]
fn fix_refuses_a_symlink_and_keeps_permissions() {
    use std::os::unix::fs::PermissionsExt;
    let dir = Scratch::new("unix");
    let target = dir.write("target.yaml", b"a: {b: 1}\n");
    let link = dir.0.join("link.yaml");
    std::os::unix::fs::symlink(&target, &link).unwrap();
    let out = kyq(&["fix", path(&link)]);
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("symbolic link"));
    assert_eq!(fs::read(&target).unwrap(), b"a: {b: 1}\n");
    assert!(
        fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink()
    );

    fs::set_permissions(&target, fs::Permissions::from_mode(0o640)).unwrap();
    assert_eq!(kyq(&["fix", path(&target)]).status.code(), Some(0));
    assert_eq!(fs::read(&target).unwrap(), b"a:\n  b: 1\n");
    let mode = fs::metadata(&target).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o640);
}

#[test]
fn check_accepts_a_header_and_rejects_a_lost_comment() {
    let dir = Scratch::new("check");
    let good = dir.write("g.yaml", b"# SPDX-License-Identifier: MPL-2.0\na: 1\n");
    assert_eq!(kyq(&["check", path(&good)]).status.code(), Some(0));
    let drift = dir.write("d.yaml", b"# SPDX-License-Identifier: MPL-2.0\na: 1 # c\n");
    assert_eq!(kyq(&["check", path(&drift)]).status.code(), Some(1));
}
