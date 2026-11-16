// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell
use proven_evidence::parser_contract::benchmark;
fn main() {
    let input = include_bytes!("../conformance/fixtures/kyaml/valid/deployment.yaml");
    let count = 1000;
    let sample = benchmark(input, count, |bytes| {
        kyq::parse(bytes, kyq::Format::Kyaml).map_err(|e| e.to_string())
    })
    .expect("benchmark fixture must parse");
    println!(
        "kyaml_deployment iterations={count} elapsed_ns={} input_bytes={}",
        sample.elapsed.as_nanos(),
        input.len()
    );
}
