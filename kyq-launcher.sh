#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
# SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell
# Compatibility entrypoint; launcher.sh owns provisioning and native execution.
set -euo pipefail
REPO_DIR="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
case "${1:---help}" in
  -h|--help|help) exec bash "$REPO_DIR/launcher.sh" --help ;;
  -v|--version) exec bash "$REPO_DIR/launcher.sh" --run --version ;;
  build|build-release|test|bench|clean|install)
    cd "$REPO_DIR"
    exec just "$@"
    ;;
  just)
    shift
    cd "$REPO_DIR"
    exec just "$@"
    ;;
  --*) exec bash "$REPO_DIR/launcher.sh" "$@" ;;
  *) exec bash "$REPO_DIR/launcher.sh" --run "$@" ;;
esac
