# SPDX-License-Identifier: CC-BY-SA-4.0
# Copyright (c) 2026 Jonathan D.A. Jewell (hyperpolymath) <j.d.a.jewell@open.ac.uk>
#
# kyq Justfile — Kubernetes YAML Query
# RSR-compliant build system for AffineScript KYAML processor

set shell := ["bash", "-uc"]

# Project metadata
project := "kyq"
OWNER := "metadatastician" 
REPO := "kyq"
version := "0.1.0"
tier := "2"

# Directories
BIN_DIR := "bin"
DIST_DIR := "dist"

# ═══════════════════════════════════════════════════════════════════════════════
# DEFAULT & HELP
# ═══════════════════════════════════════════════════════════════════════════════

default:
	@echo "kyq v{{version}} — Kubernetes YAML Query"
	@echo "AffineScript KYAML Processor"
	@echo "License: MPL-2.0 (code) / CC-BY-SA-4.0 (docs)"
	@echo ""
	@just --list --unsorted

# Show project info
info:
	@echo "Project: {{project}}"
	@echo "Version: {{version}}"
	@echo "RSR Tier: {{tier}}"
	@echo "Owner: {{OWNER}}"
	@echo "Repository: {{OWNER}}/{{REPO}}"

# ═══════════════════════════════════════════════════════════════════════════════
# BUILD & COMPILE
# ═══════════════════════════════════════════════════════════════════════════════

# AffineScript 0.1.1 does not parse the sources under src/, so nothing can be
# built, tested or benchmarked yet. These recipes fail instead of producing a
# placeholder binary or reporting tests that never ran
# (docs/status/ROADMAP.adoc, Blockers).
not_implemented := "not implemented: AffineScript 0.1.1 does not parse src/ (see docs/status/ROADMAP.adoc, Blockers)"

# Build kyq (debug mode) — not implemented yet
build *args:
	@echo "{{not_implemented}}" >&2
	@exit 1

# Build in release mode — not implemented yet
build-release *args:
	@echo "{{not_implemented}}" >&2
	@exit 1

# Build WASM version — not implemented yet
wasm *args:
	@echo "{{not_implemented}}" >&2
	@exit 1

# Clean build artifacts
clean:
	rm -rf {{BIN_DIR}} {{DIST_DIR}}
	@echo "Clean complete"

# ═══════════════════════════════════════════════════════════════════════════════
# TEST & QUALITY
# ═══════════════════════════════════════════════════════════════════════════════

# Run all tests — not implemented yet
test *args:
	@echo "{{not_implemented}}" >&2
	@exit 1

# Run benchmarks — not implemented yet
bench:
	@echo "{{not_implemented}}" >&2
	@exit 1

# ═══════════════════════════════════════════════════════════════════════════════
# VALIDATION & COMPLIANCE
# ═══════════════════════════════════════════════════════════════════════════════

# DEED_LINT=<standards>/1-formats/deed/tools/deed_lint.js also checks the deed grammar.
# Validate repository layout and the repo deed (fail-closed)
validate:
	#!/usr/bin/env bash
	set -euo pipefail
	fail=0
	for d in src tests benches templates gradings; do
	  if [ -d "$d" ]; then echo "✓ $d/ exists"; else echo "✗ $d/ missing"; fail=1; fi
	done
	for f in LICENSE LICENSES/MPL-2.0.txt LICENSES/CC-BY-SA-4.0.txt coordination.k9; do
	  if [ -f "$f" ]; then echo "✓ $f exists"; else echo "✗ $f missing"; fail=1; fi
	done
	mapfile -t deeds < <(find . -maxdepth 1 -name '*_chora.deed' -type f)
	if [ "${#deeds[@]}" -ne 1 ]; then
	  echo "✗ expected exactly one *_chora.deed, found ${#deeds[@]}"
	  exit 1
	fi
	deed="${deeds[0]}"
	grep -q ':schema-version "' "$deed" || { echo "✗ $deed: no :schema-version"; fail=1; }
	grep -q '(status' "$deed" || { echo "✗ $deed: no (status ...) clause"; fail=1; }
	if grep -q '#u7"' "$deed"; then echo "✗ $deed: #u7 literal (illegal, D305)"; fail=1; fi
	a2ml="$(git ls-files '*.a2ml' 2>/dev/null || find . -name '*.a2ml' -not -path './.git/*')"
	if [ -n "$a2ml" ]; then echo "✗ A2ML is retired; remove: $a2ml"; fail=1; fi
	if [ -n "${DEED_LINT:-}" ]; then
	  bun "$DEED_LINT" "$deed" || fail=1
	else
	  echo "note: deed grammar NOT checked (DEED_LINT unset)"
	fi
	if [ "$fail" -ne 0 ]; then echo "validation FAILED"; exit 1; fi
	echo "✓ $deed"
	echo "validation passed"

# Check every tracked AffineScript file. Missing tools and source failures are
# both hard failures: this recipe never skips a strict check or prints a
# placeholder PASS. Set AFFINESCRIPT to a pinned executable when it is not on
# PATH (see docs/AFFINESCRIPT_STRICT_PORT.adoc A1).
affine-check:
    #!/usr/bin/env bash
    set -euo pipefail
    compiler="${AFFINESCRIPT:-affinescript}"
    if ! command -v "$compiler" >/dev/null 2>&1; then
      echo "MISSING_TOOLCHAIN: AffineScript compiler not found: $compiler" >&2
      echo "Set AFFINESCRIPT to a pinned affinescript executable." >&2
      exit 2
    fi
    compiler="$(command -v "$compiler")"
    if [[ "$compiler" != /* ]]; then
      compiler="$(cd "$(dirname "$compiler")" && pwd)/$(basename "$compiler")"
    fi
    stdlib="${AFFINESCRIPT_STDLIB:-./stdlib}"
    if [ ! -f "$stdlib/prelude.affine" ]; then
      echo "MISSING_TOOLCHAIN: AffineScript standard library not found: $stdlib" >&2
      echo "Set AFFINESCRIPT_STDLIB to the pinned v0.1.1 stdlib directory." >&2
      exit 2
    fi
    export AFFINESCRIPT_STDLIB="$(cd "$stdlib" && pwd)"
    "$compiler" --version
    failed=0
    while IFS= read -r file; do
      if [[ "$file" == src/* ]]; then
        source_path="${file#src/}"
      else
        source_path="../$file"
      fi
      if ! (cd src && "$compiler" check "$source_path"); then
        echo "AFFINE_CHECK_FAILED: $file" >&2
        failed=$((failed + 1))
      fi
    done < <(git ls-files '*.affine' | LC_ALL=C sort)
    if [ "$failed" -ne 0 ]; then
      echo "affine check failed for $failed tracked file(s)" >&2
      exit 1
    fi
    echo "✓ affine checks passed for every tracked .affine file"

# Run the non-gating A1 grammar census (same MISSING_TOOLCHAIN contract).
affine-a1:
    #!/usr/bin/env bash
    set -euo pipefail
    export AFFINESCRIPT="${AFFINESCRIPT:-affinescript}"
    bash scripts/affine-a1-probe.sh

# Check that every workflow `uses:` is locked/pinned (requires yq + gh)
lock-check:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Checking action pinning..."
    node scripts/check-action-pinning.js
    if command -v gawk >/dev/null 2>&1; then \
      bash scripts/check-lock-sync.sh; \
    else \
      echo "note: gawk not installed, skipping check-lock-sync (install with apt-get install gawk)"; \
    fi
    echo "Running invisible-character scan..."
    tmp="$(mktemp -d)"; \
    bash scripts/check-invisible-characters.sh "." "$tmp/results" "$tmp/blocking" || true; \
    if [ -s "$tmp/results" ]; then echo "invisible-char findings:"; cat "$tmp/results"; else echo "no invisible-char findings"; fi; \
    rm -rf "$tmp"

# ═══════════════════════════════════════════════════════════════════════════════
# INSTALL
# ═══════════════════════════════════════════════════════════════════════════════

# Install kyq system-wide — not implemented yet (there is no binary to install)
install:
	@echo "{{not_implemented}}" >&2
	@exit 1

# ═══════════════════════════════════════════════════════════════════════════════
# DOCUMENTATION
# ═══════════════════════════════════════════════════════════════════════════════

# Generate just cookbook
docs:
	@echo "Generating documentation..."
	@mkdir -p docs
	@echo "# kyq Justfile Cookbook" > docs/just-cookbook.adoc
	@echo "Generated: $(date)" >> docs/just-cookbook.adoc
	@echo "" >> docs/just-cookbook.adoc
	@echo "== Available Recipes" >> docs/just-cookbook.adoc
	@just --list --unsorted >> docs/just-cookbook.adoc
	@echo "Documentation generated in docs/"