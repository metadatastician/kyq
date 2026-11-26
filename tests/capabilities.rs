// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell
//! Independent CLI probe: advertised capabilities match implemented dispatch.
use std::io::Write;
use std::process::{Command, Stdio};

fn invoke(args: &[&str], input: &[u8]) -> std::process::Output {
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

fn report() -> serde_json::Value {
    let output = invoke(&["--capabilities"], b"");
    assert_eq!(output.status.code(), Some(0));
    assert!(output.stderr.is_empty());
    assert_eq!(output.stdout.last(), Some(&b'\n'));
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn advertised_version_profiles_and_boundaries_are_truthful() {
    let report = report();
    assert_eq!(report["schema_version"], "0.2.0");
    assert_eq!(report["contract_status"], "preview");
    assert_eq!(report["implementation"]["name"], "kyq");
    assert_eq!(
        report["implementation"]["version"],
        env!("CARGO_PKG_VERSION")
    );
    assert_eq!(
        report["resource_limits"]["raw_input_max_bytes"],
        kyq::MAX_INPUT_BYTES
    );
    assert_eq!(
        report["resource_limits"]["kyaml_nodes_max"],
        kyq::NODE_BUDGET
    );
    assert_eq!(
        report["resource_limits"]["kyaml_expanded_storage_max_bytes"],
        kyq::MAX_EXPANDED_BYTES
    );
    assert_eq!(
        report["resource_limits"]["kyaml_container_depth_max"],
        kyq::MAX_DEPTH
    );
    assert!(report["resource_limits"]["dhall_process_time_limit_ms"].is_null());
    assert!(report["resource_limits"]["dhall_process_memory_limit_bytes"].is_null());
    assert_eq!(report["safety"]["dhall_imports_enabled"], false);
    assert_eq!(report["safety"]["atomic_fix_implemented"], true);
    assert_eq!(report["safety"]["fix_keeps_header_comment_block"], true);
    assert_eq!(report["safety"]["fix_refuses_lost_comments"], true);
    assert_eq!(report["safety"]["fix_follows_symlinks"], false);
    assert_eq!(report["safety"]["toml_projects_types_into_json"], false);
    assert_eq!(report["safety"]["fmt_preserves_comments"], false);
    assert_eq!(report["output_contract"]["writes_input_files"], true);
    assert_eq!(
        report["output_contract"]["writing_operations"],
        serde_json::json!(["fix"])
    );
    assert_eq!(report["diagnostics"]["machine_readable"], false);
}

#[test]
fn advertised_operations_match_the_installed_binary() {
    let report = report();
    let formats = report["formats"].as_object().unwrap();
    assert_eq!(formats.len(), 5);
    let known = ["validate", "canon", "to-json", "fmt", "get", "check", "fix"];
    let cases = [
        ("kyaml", b"x: 1\n".as_slice()),
        ("json", b"{\"x\":1}".as_slice()),
        ("jcs", b"{\"x\":1}".as_slice()),
        ("dhall", b"{ x = 1 }".as_slice()),
        ("toml", b"x = 1\n".as_slice()),
    ];

    for (format, fixture) in cases {
        let advertised = formats[format]["operations"].as_array().unwrap();
        assert!(!advertised.is_empty(), "{format}");
        for operation in known {
            // fix never reads stdin: give it a scratch file holding the fixture.
            let scratch = std::env::temp_dir()
                .join(format!("kyq-capabilities-{}-{format}", std::process::id()));
            let output = if operation == "fix" {
                std::fs::write(&scratch, fixture).unwrap();
                let path = scratch.to_str().unwrap();
                let output = invoke(&[operation, "--from", format, path], b"");
                std::fs::remove_file(&scratch).unwrap();
                output
            } else {
                invoke(&[operation, "--from", format], fixture)
            };
            let is_advertised = advertised.iter().any(|x| x.as_str() == Some(operation));
            if is_advertised {
                assert!(
                    matches!(output.status.code(), Some(0 | 1)),
                    "{format} {operation} incorrectly refused: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            } else {
                assert_eq!(output.status.code(), Some(2), "{format} {operation}");
                assert!(output.stdout.is_empty(), "{format} {operation}");
            }
        }
    }
}

#[test]
fn capabilities_are_standalone_and_reject_extra_arguments() {
    let first = invoke(&["--capabilities"], b"");
    let second = invoke(&["--capabilities"], b"");
    assert_eq!(first.stdout, second.stdout);
    let bad = invoke(&["--capabilities", "manifest.toml"], b"");
    assert_eq!(bad.status.code(), Some(2));
    assert!(bad.stdout.is_empty());
    assert!(String::from_utf8_lossy(&bad.stderr).contains("takes no arguments"));
}
