#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
# SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell
# Hand-maintained tool launcher, sourcing the canonical provisioning engine.
# No GNU readlink -f dependency: supported by Bash on Linux, macOS and Git Bash.
set -uo pipefail
REPO_DIR="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [ ! -r "$REPO_DIR/build/just/provision-modes.sh" ]; then
  printf '%s\n' 'Incomplete checkout: restore build/just/provision-modes.sh.' >&2
  exit 2
fi
# shellcheck source=build/just/provision-modes.sh
. "$REPO_DIR/build/just/provision-modes.sh"
case "${1:---help}" in
  --run)
    shift
    command -v cargo >/dev/null 2>&1 || { printf '%s\n' 'Install Rust using ./launcher.sh --setup.' >&2; exit 2; }
    (cd "$REPO_DIR" && cargo build --locked --bin kyq) || exit $?
    binary=$(cd "$REPO_DIR" && cargo metadata --locked --no-deps --format-version 1 | sed -n 's/.*"target_directory":"\([^"]*\)".*/\1/p')
    [ -n "$binary" ] || exit 2
    exec "$binary/debug/kyq" "$@"
    ;;
  --help)
    hp_help
    printf '\n  --run ARGS  Run the native kyq command, forwarding arguments unchanged.\n'
    ;;
  *) hp_launcher_main "$@" ;;
esac
