// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell
//! W8 part 2: arbitrary bytes through the strict JSON and JCS readers.
//!
//! kyq must never panic. When it reads a document, its RFC 8785 output must
//! read back and canonicalize to the same bytes. (RFC 8785 keeps no integer
//! and float distinction, so `9.0` and `9` are one value; bytes are compared.)
#![no_main]
use kyq::Format;
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    for format in [Format::Json, Format::Jcs] {
        let Ok(docs) = kyq::parse(data, format) else {
            continue;
        };
        let Ok(jcs) = kyq::canonicalize_documents(&docs) else {
            continue;
        };
        // Re-read in the same format: JCS mode reads every number as binary64.
        let again = kyq::parse(&jcs, format).expect("kyq refused its own JCS");
        assert_eq!(
            kyq::canonicalize_documents(&again).ok().as_deref(),
            Some(&jcs[..]),
            "JCS is not a fixed point"
        );
    }
});
