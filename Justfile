# SPDX-License-Identifier: MPL-2.0
# SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell
set shell := ["bash", "-cu"]
set windows-shell := ["bash", "-cu"]
mod provision 'build/just/provision.just'

# Show tasks and provisioning commands
default:
    @just --list --list-submodules

# Install the declared toolchain and run diagnostics
setup: provision::setup
doctor: provision::doctor
heal: provision::heal
dev-shell: provision::dev-shell
toolchain-refresh: provision::toolchain-refresh
config-show: provision::config-show
ai-setup: provision::ai-setup
opsm: provision::opsm
langs: provision::langs
eval: provision::eval
deps: provision::deps
search pattern:
    @just provision::search {{quote(pattern)}}

# Read an audience-specific AI warm-up
ai-warmup who="user":
    #!/usr/bin/env bash
    set -euo pipefail
    case {{quote(who)}} in
      user|dev|maintainer|theorist) cat "docs/onboarding/llm-warmup-{{who}}.adoc" ;;
      *) echo "audience must be user, dev, maintainer or theorist" >&2; exit 2 ;;
    esac

# Build the portable default package set
build:
    cargo build --locked
build-release:
    cargo build --locked --release

# Execute tests, benchmark smoke tests and documentation examples
test:
    cargo test --locked --all-targets
    cargo test --locked --doc

# Measure release builds; retain host/compiler information with the result
bench:
    cargo bench --locked
lint:
    cargo clippy --locked --all-targets -- -D warnings
fmt:
    cargo fmt --all
fmt-check:
    cargo fmt --all --check
doc:
    cargo doc --locked --no-deps

# The same local acceptance sequence used before review
check: fmt-check lint test doc

# Run the native CLI
[positional-arguments]
run *args:
    cargo run --locked --bin kyq -- "$@"

# Print the package version
version:
    cargo run --locked --bin kyq -- --version

# Build the Wolfi image with Podman
container-build:
    podman build --file Containerfile --tag localhost/kyq:dev .

# Run without network access, capabilities or a writable root filesystem
[positional-arguments]
container-run *args:
    podman run --rm -i --network=none --read-only --cap-drop=ALL --memory=256m --cpus=1 --pids-limit=64 --security-opt=no-new-privileges localhost/kyq:dev "$@"

# A container smoke test; absence of Podman is a failure
container-test:
    podman run --rm --network=none --read-only --cap-drop=ALL localhost/kyq:dev --version

# ═══════════════════════════════════════════════════════════════════════════════
# PROOFS  (verification/proofs/README.adoc, docs/status/PROOF-STATUS.adoc)
# ═══════════════════════════════════════════════════════════════════════════════
#
# Every leg asserts its toolchain version and fails on a mismatch; another
# version must be named (KYQ_AGDA_VERSION, KYQ_COQ_VERSION) and recorded as a
# deviation in PROOF-STATUS. Exit 2 = toolchain, 1 = proof or control failed,
# 3 = a leg is OPEN. A missing leg is never a pass.

# Every proof leg and every negative control; red while any leg is OPEN
proofs:
    bash verification/proofs/run-proofs.sh all

# Agda spine (--safe --without-K --cubical-compatible --no-libraries), coverage, scans, controls
proofs-agda:
    bash verification/proofs/run-proofs.sh agda

# Rocq recheck leg (re-proved, BRIDGE-PENDING; prints DEVIATION DEV-2) and its controls
proofs-rocq:
    bash verification/proofs/run-proofs.sh rocq

# Lean recheck leg (OPEN: exits 3 until a Lean leg exists)
proofs-lean:
    bash verification/proofs/run-proofs.sh lean

# Install the locked native binary into Cargo's user bin directory
install:
    cargo install --locked --path .

# Independent legacy conformance oracle (not the native implementation)
conformance:
    node --test conformance/test/*.test.js
conformance-oracle:
    node conformance/tools/ijson-jcs-diff.mjs
conformance-package:
    bash conformance/tools/package.sh
repo-map:
    bash scripts/gen-repo-map.sh .

# Check production budget boundaries with the normal Rust compiler
bounds-test:
    cargo test --locked --manifest-path verification/bounds/Cargo.toml

# Replay the production Pearlite contract using the installed Creusot toolchain
proof-creusot:
    cd verification/bounds && cargo +nightly-2026-08-03 creusot

# Verify the separate arithmetic model; does not prove production refinement
proof-verus:
    verus --no-cheating --crate-type lib verification/verus/budget.rs

# Show exactly which first-party obligations are proven, assumed or open
proof-status:
    cat verification/PROOF-STATUS.adoc

# Remove Cargo build output using Cargo's own target-directory rules
clean:
    cargo clean
