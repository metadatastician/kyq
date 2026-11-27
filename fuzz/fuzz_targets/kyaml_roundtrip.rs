// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell
//! W8 part 2: arbitrary bytes through the KYAML reader.
//!
//! kyq must never panic. When it reads a stream, its own formatter must give a
//! stream it reads back to the same documents, and formatting must be stable.
//! The same holds for `canonical_file`, the bytes `fmt` and `fix` write.
//! "The same" is per-document RFC 8785 text: the canonical form writes numbers
//! as JCS does (KYAML_SPEC, canonical form), so `1.0` becomes `1`.
#![no_main]
use kyq::{Error, Format, Value};
use libfuzzer_sys::fuzz_target;

/// Built with `--cfg kyq_fuzz_plant`, the reader drops the last element of
/// every sequence it re-reads. The fuzzer must find this planted fault.
fn reread(bytes: &[u8]) -> Vec<Value> {
    let docs = kyq::parse(bytes, Format::Kyaml).expect("kyq refused its own output");
    if cfg!(kyq_fuzz_plant) {
        return docs.into_iter().map(plant).collect();
    }
    docs
}

/// Each document as RFC 8785 text, the identity the canonical form keeps.
fn jcs(docs: &[Value]) -> Vec<Result<Vec<u8>, Error>> {
    docs.iter()
        .map(|d| kyq::canonicalize_documents(std::slice::from_ref(d)))
        .collect()
}

fn plant(value: Value) -> Value {
    match value {
        Value::Array(mut items) => {
            items.pop();
            Value::Array(items.into_iter().map(plant).collect())
        }
        Value::Object(map) => Value::Object(map.into_iter().map(|(k, v)| (k, plant(v))).collect()),
        other => other,
    }
}

fuzz_target!(|data: &[u8]| {
    let Ok(docs) = kyq::parse(data, Format::Kyaml) else {
        return;
    };
    if let Ok(text) = kyq::format_documents(&docs) {
        assert_eq!(
            jcs(&reread(&text)),
            jcs(&docs),
            "formatted output reads differently"
        );
        assert_eq!(
            kyq::format_documents(&reread(&text)).ok().as_deref(),
            Some(&text[..]),
            "formatting is not stable"
        );
    }
    if let Ok(file) = kyq::canonical_file(data, Format::Kyaml) {
        assert_eq!(
            jcs(&reread(&file)),
            jcs(&docs),
            "canonical file reads differently"
        );
        assert_eq!(
            kyq::canonical_file(&file, Format::Kyaml).ok().as_deref(),
            Some(&file[..]),
            "canonical file is not a fixed point"
        );
    }
});
