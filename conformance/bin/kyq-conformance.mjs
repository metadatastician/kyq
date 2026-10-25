#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell (hyperpolymath) <j.d.a.jewell@open.ac.uk>
//
// Entry point of the pinned conformance CLI. No dependencies, no build step:
// `node bin/kyq-conformance.mjs …` is the whole install story.

import { run } from "../src/cli.js";

process.exitCode = run(process.argv.slice(2));
