// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell (hyperpolymath) <j.d.a.jewell@open.ac.uk>
//
// The single source of truth for the gate's version. `conformance/VERSION`
// repeats it for humans and for the packaging script; `conformance/test/
// version.test.js` asserts the two agree, so a release cannot drift.

/** Gate version. Bump with `conformance/VERSION` and the corpus schema. */
export const VERSION = "0.1.0";

/** Schema URI of the fixture/vector files under `conformance/fixtures`. */
export const CORPUS_SCHEMA = "kyq-conformance-corpus-v1";
