// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell
#![forbid(unsafe_code)]
use kyq::{Format, MAX_INPUT_BYTES};
use std::{
    io::{self, Read, Write},
    path::Path,
};

fn run() -> Result<i32, Box<dyn std::error::Error>> {
    let mut args = std::env::args_os()
        .skip(1)
        .map(|arg| arg.into_string().map_err(|_| "arguments must be UTF-8"))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter();
    let command = args.next().unwrap_or_else(|| "--help".into());
    if command == "--version" {
        println!("kyq {}", env!("CARGO_PKG_VERSION"));
        return Ok(0);
    }
    if command == "--help" || command == "help" {
        println!(
            "kyq <validate|canon|to-json|fmt|get|check> [--from kyaml|json|dhall] [--pointer /path] [FILE|-]\n\nDefaults: KYAML, stdin. canon emits JCS without LF; to-json emits JCS plus LF.\nfmt emits deterministic block-style KYAML and discards comments.\nDhall imports are disabled. check compares formatted bytes without modifying files."
        );
        return Ok(0);
    }
    if !["validate", "canon", "to-json", "fmt", "get", "check"].contains(&command.as_str()) {
        return Err(format!("unknown command: {command}").into());
    }
    let mut format = Format::Kyaml;
    let mut file: Option<String> = None;
    let mut pointer = String::new();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--from" => {
                format = match args.next().as_deref() {
                    Some("kyaml" | "yaml") => Format::Kyaml,
                    Some("json" | "ijson" | "jcs") => Format::Json,
                    Some("dhall") => Format::Dhall,
                    _ => return Err("--from requires kyaml, json or dhall".into()),
                }
            }
            "--pointer" => {
                pointer = args
                    .next()
                    .ok_or("--pointer requires an RFC 6901 pointer")?
            }
            "-" => {
                if file.replace(arg).is_some() {
                    return Err("only one input is accepted".into());
                }
            }
            _ if arg.starts_with('-') => return Err(format!("unknown option: {arg}").into()),
            _ => {
                if file.replace(arg).is_some() {
                    return Err("only one input is accepted".into());
                }
            }
        }
    }
    let reader: Box<dyn Read> = match file.as_deref() {
        None | Some("-") => Box::new(io::stdin()),
        Some(path) => Box::new(std::fs::File::open(Path::new(path))?),
    };
    let mut input = Vec::new();
    reader
        .take(MAX_INPUT_BYTES as u64 + 1)
        .read_to_end(&mut input)?;
    let docs = kyq::parse(&input, format)?;
    let output = match command.as_str() {
        "validate" => Vec::new(),
        "canon" => kyq::canonicalize_documents(&docs)?,
        "to-json" => {
            let mut bytes = kyq::canonicalize_documents(&docs)?;
            bytes.push(b'\n');
            bytes
        }
        "fmt" => kyq::format_documents(&docs)?,
        "check" => {
            let expected = match format {
                Format::Kyaml => kyq::format_documents(&docs)?,
                Format::Json => {
                    let mut bytes = kyq::canonicalize_documents(&docs)?;
                    bytes.push(b'\n');
                    bytes
                }
                Format::Dhall => {
                    return Err("check supports KYAML and JSON; use validate for Dhall".into());
                }
            };
            if input != expected {
                eprintln!("kyq: input is valid but not in the selected canonical file format");
                return Ok(1);
            }
            Vec::new()
        }
        "get" => {
            let mut bytes = Vec::new();
            for value in kyq::query(&docs, &pointer)? {
                bytes.extend(ijson_jcs::to_jcs(value)?);
                bytes.push(b'\n');
            }
            bytes
        }
        _ => unreachable!(),
    };
    io::stdout().lock().write_all(&output)?;
    Ok(0)
}
fn main() {
    match run() {
        Ok(status) => std::process::exit(status),
        Err(error) => {
            eprintln!("kyq: {error}");
            std::process::exit(2);
        }
    }
}
