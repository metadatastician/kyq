// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell
//! W8 part 1: the estate KYAML corpus.
//!
//! `tests/corpus/estate-kyaml/` holds the real YAML files of the standards
//! repository at one pinned commit, rendered as KYAML by the pinned `yq`, the
//! estate's own formatter (`scripts/estate-kyaml-corpus.sh`). Each case's
//! `.json` is yq's reading of the source. kyq must read every KYAML case to the
//! same value, or refuse it with the code listed in `EXPECTED-REFUSALS.tsv`.
use serde_json::Value as Json;
use std::{collections::BTreeMap, fs, path::PathBuf};

fn corpus_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/corpus/estate-kyaml")
}

fn rows(file: &str) -> Vec<Vec<String>> {
    fs::read_to_string(corpus_dir().join(file))
        .unwrap()
        .lines()
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(|l| l.split('\t').map(str::to_owned).collect())
        .collect()
}

/// What a parser made of one case.
enum Outcome {
    Value(Json),
    Refused(&'static str),
}

type Parser = fn(&[u8]) -> Outcome;

fn kyq_parser(input: &[u8]) -> Outcome {
    match kyq::parse(input, kyq::Format::Kyaml) {
        Ok(docs) => Outcome::Value(serde_json::to_value(&docs).unwrap()),
        Err(e) => Outcome::Refused(e.code),
    }
}

/// Run the corpus through `parser`; return each disagreement.
fn disagreements(parser: Parser) -> Vec<String> {
    let refusals: BTreeMap<String, String> = rows("EXPECTED-REFUSALS.tsv")
        .into_iter()
        .map(|r| (r[0].clone(), r[1].clone()))
        .collect();
    let mut bad = Vec::new();
    for row in rows("MANIFEST.tsv") {
        let name = &row[0];
        let cases = corpus_dir().join("cases");
        let kyaml = fs::read(cases.join(format!("{name}.kyaml"))).unwrap();
        let expected: Json =
            serde_json::from_slice(&fs::read(cases.join(format!("{name}.json"))).unwrap()).unwrap();
        match (parser(&kyaml), refusals.get(name)) {
            (Outcome::Value(got), None) if got == expected => {}
            (Outcome::Refused(code), Some(want)) if code == want => {}
            (Outcome::Value(_), None) => bad.push(format!("{name}: value differs from yq")),
            (Outcome::Value(_), Some(want)) => bad.push(format!("{name}: accepted, want {want}")),
            (Outcome::Refused(code), want) => {
                bad.push(format!("{name}: refused {code}, want {want:?}"));
            }
        }
    }
    bad
}

#[test]
fn every_estate_case_matches_yq_or_is_a_listed_refusal() {
    let bad = disagreements(kyq_parser);
    assert!(
        bad.is_empty(),
        "{} disagreements:\n{}",
        bad.len(),
        bad.join("\n")
    );
}

#[test]
fn corpus_is_complete_and_every_refusal_is_a_case() {
    let names: Vec<String> = rows("MANIFEST.tsv")
        .into_iter()
        .map(|r| r[0].clone())
        .collect();
    assert!(names.len() >= 250, "corpus shrank to {}", names.len());
    for row in rows("EXPECTED-REFUSALS.tsv") {
        assert!(
            names.contains(&row[0]),
            "refusal for a missing case: {}",
            row[0]
        );
        assert_eq!(row.len(), 3, "refusal rows need name, code and reason");
    }
}

/// Planted fault: a parser that reads the last element of a sequence as null.
fn planted_parser(input: &[u8]) -> Outcome {
    fn plant(value: &mut Json) {
        match value {
            Json::Array(items) => {
                items.iter_mut().for_each(plant);
                if let Some(last) = items.last_mut() {
                    *last = Json::Null;
                }
            }
            Json::Object(map) => map.values_mut().for_each(plant),
            _ => {}
        }
    }
    match kyq_parser(input) {
        Outcome::Value(mut docs) => {
            if let Json::Array(items) = &mut docs {
                items.iter_mut().for_each(plant);
            }
            Outcome::Value(docs)
        }
        refused => refused,
    }
}

/// Planted fault: a parser that accepts what kyq refuses, as an empty map.
fn permissive_parser(input: &[u8]) -> Outcome {
    match kyq_parser(input) {
        Outcome::Refused(_) => Outcome::Value(Json::Array(vec![Json::Object(Default::default())])),
        value => value,
    }
}

#[test]
fn the_corpus_finds_planted_parser_faults() {
    assert!(
        !disagreements(planted_parser).is_empty(),
        "missed the dropped-element fault"
    );
    assert!(
        !disagreements(permissive_parser).is_empty(),
        "missed the permissive fault"
    );
}
