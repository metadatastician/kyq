// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell
//! Truthful, versioned *preview* of executable capabilities, not release claims.
use kyq::{MAX_DEPTH, MAX_EXPANDED_BYTES, MAX_INPUT_BYTES, NODE_BUDGET};
use serde_json::{json, to_vec};

pub(crate) fn bytes() -> Result<Vec<u8>, serde_json::Error> {
    // Keep this table aligned with main.rs dispatch. Unsupported operations
    // must never be advertised as implemented merely because a parser exists.
    let document = json!({
        "schema_version": "0.2.0",
        "contract_status": "preview",
        "implementation": { "name": "kyq", "version": env!("CARGO_PKG_VERSION") },
        "formats": {
            "kyaml": {
                "profile": "kyaml-restricted-legacy-block-v0",
                "operations": ["validate", "canon", "to-json", "fmt", "get", "check", "fix"]
            },
            "json": {
                "profile": "estate-strict-ijson-r3",
                "operations": ["validate", "canon", "to-json", "fmt", "get", "check", "fix"]
            },
            "jcs": {
                "profile": "rfc8785-explicit-binary64",
                "operations": ["validate", "canon", "to-json", "fmt", "get", "check", "fix"]
            },
            "dhall": {
                "profile": "import-free-typed-dhall",
                "operations": ["validate", "canon", "to-json", "fmt", "get"]
            },
            "toml": {
                "profile": "toml-1.0-validity-only",
                "operations": ["validate"]
            }
        },
        "output_contract": {
            "canon": "RFC8785-JCS-bytes-no-final-newline",
            "to-json": "RFC8785-JCS-bytes-one-final-newline",
            "fmt": "kyaml-restricted-legacy-block-v0",
            "get": "RFC8785-JCS-one-newline-per-document",
            "check": "canonical-file-byte-comparison",
            "fix": "canonical-file-atomic-replace",
            "writes_input_files": true,
            "writing_operations": ["fix"]
        },
        "resource_limits": {
            "raw_input_max_bytes": MAX_INPUT_BYTES,
            "kyaml_nodes_max": NODE_BUDGET,
            "kyaml_expanded_storage_max_bytes": MAX_EXPANDED_BYTES,
            "kyaml_container_depth_max": MAX_DEPTH,
            "dhall_process_time_limit_ms": null,
            "dhall_process_memory_limit_bytes": null
        },
        "safety": {
            "dhall_imports_enabled": false,
            "toml_projects_types_into_json": false,
            "fmt_preserves_comments": false,
            "atomic_fix_implemented": true,
            "fix_keeps_header_comment_block": true,
            "fix_refuses_lost_comments": true,
            "fix_follows_symlinks": false
        },
        "diagnostics": {
            "success_exit": 0,
            "noncanonical_exit": 1,
            "invalid_or_unsupported_exit": 2,
            "channel": "stderr",
            "machine_readable": false
        }
    });
    let mut output = to_vec(&document)?;
    output.push(b'\n');
    Ok(output)
}
