// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell
//! Confined Dhall evaluation (ULTRAPLAN W7).
//!
//! serde_dhall has no fuel or memory bound of its own, so the CLI never
//! evaluates Dhall in its own process. It re-runs its own executable as a
//! hidden worker (`kyq --dhall-worker`), sends the source on stdin and waits.
//!
//! * Time: the parent kills the worker once `DHALL_TIME_LIMIT_MS` of wall
//!   clock has passed and reports `DHALL_TIME_LIMIT`.
//! * Memory: the worker caps its own heap at `DHALL_MEMORY_LIMIT_BYTES`
//!   through the counting global allocator in `main.rs`. An allocation past
//!   the cap aborts the worker. The parent kills it as soon as it says so on
//!   stderr, without waiting for a crash dump, and reports `DHALL_MEMORY_LIMIT`.
//! * Output: the parent keeps at most `DHALL_OUTPUT_MAX_BYTES` of the
//!   worker's result and reports `DHALL_OUTPUT_LIMIT` beyond that.
//!
//! * Stack: deep evaluation (for example a long `Natural/fold`) overflows the
//!   worker's evaluation thread, whose stack is `DHALL_STACK_BYTES` on every
//!   OS. That used to abort kyq itself; the parent now reports
//!   `DHALL_STACK_LIMIT`.
//!
//! Any other abnormal end is `DHALL_WORKER_FAILED`.
//! Every refusal is a typed `kyq::Error`, so the CLI exits 2.

use kyq::{
    DHALL_MEMORY_LIMIT_BYTES, DHALL_OUTPUT_MAX_BYTES, DHALL_STACK_BYTES, DHALL_TIME_LIMIT_MS,
    Error, Format, MAX_INPUT_BYTES, Value,
};
use std::{
    io::{self, Read, Write},
    process::{Command, ExitStatus, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

/// The hidden argument that selects worker mode.
pub const WORKER_ARG: &str = "--dhall-worker";
/// The worker's exit status for a typed evaluation refusal.
const REFUSED_EXIT: i32 = 3;
/// The standard library's message when the global allocator returns null.
const ALLOC_FAILURE: &str = "memory allocation of";
/// The standard library's message when a thread overflows its stack.
const STACK_OVERFLOW: &str = "has overflowed its stack";
/// The most worker stderr the parent keeps.
const STDERR_MAX_BYTES: usize = 64 * 1024;
const POLL: Duration = Duration::from_millis(5);

fn refusal(code: &'static str, message: impl Into<String>) -> Error {
    Error {
        code,
        message: message.into(),
        line: 1,
        column: 1,
        path: String::new(),
    }
}

/// Worker side. The caller has already capped the heap.
///
/// stdin: Dhall source. stdout on success (exit 0): one serde_json document,
/// which keeps the integer/double distinction exactly. On a typed refusal
/// (exit 3), stderr holds the code on the first line and the message after.
pub fn worker() -> i32 {
    let mut input = Vec::new();
    if io::stdin()
        .lock()
        .take(MAX_INPUT_BYTES as u64 + 1)
        .read_to_end(&mut input)
        .is_err()
    {
        return REFUSED_EXIT;
    }
    // Evaluate on a thread with an explicit stack, so the stack limit is the
    // same on every OS (a Windows main thread has 1 MiB, Linux 8 MiB).
    let evaluation = thread::Builder::new()
        .name("dhall".into())
        .stack_size(DHALL_STACK_BYTES)
        .spawn(move || {
            kyq::parse(&input, Format::Dhall).and_then(|docs| match docs.as_slice() {
                [value] => {
                    serde_json::to_vec(value).map_err(|e| refusal("INVALID_IJSON", e.to_string()))
                }
                _ => Err(refusal(
                    "DHALL_WORKER_FAILED",
                    "Dhall produced no single document",
                )),
            })
        });
    let result = match evaluation {
        Ok(handle) => handle
            .join()
            .unwrap_or_else(|_| Err(refusal("DHALL_WORKER_FAILED", "Dhall evaluation panicked"))),
        Err(e) => Err(refusal(
            "DHALL_WORKER_FAILED",
            format!("cannot start the evaluation thread: {e}"),
        )),
    };
    match result {
        Ok(bytes) => {
            let mut out = io::stdout().lock();
            if out.write_all(&bytes).and_then(|()| out.flush()).is_err() {
                return REFUSED_EXIT;
            }
            0
        }
        Err(error) => {
            let _ = write!(io::stderr().lock(), "{}\n{}", error.code, error.message);
            REFUSED_EXIT
        }
    }
}

/// Read a pipe to its end, keeping at most `max + 1` bytes so that the
/// writer never blocks and an overflow stays visible. If `alarm` is given,
/// set it as soon as the kept bytes start with the allocation-failure line.
fn drain(mut pipe: impl Read, max: usize, alarm: Option<&AtomicBool>) -> Vec<u8> {
    let mut kept = Vec::new();
    let mut chunk = [0u8; 64 * 1024];
    loop {
        match pipe.read(&mut chunk) {
            Ok(0) | Err(_) => return kept,
            Ok(n) => {
                let room = (max + 1).saturating_sub(kept.len());
                kept.extend_from_slice(&chunk[..n.min(room)]);
                if let Some(alarm) = alarm
                    && kept.starts_with(ALLOC_FAILURE.as_bytes())
                {
                    alarm.store(true, Ordering::Release);
                }
            }
        }
    }
}

fn memory_limit() -> Error {
    refusal(
        "DHALL_MEMORY_LIMIT",
        format!("Dhall evaluation exceeded {DHALL_MEMORY_LIMIT_BYTES} bytes of heap"),
    )
}

/// Map a worker's refusal code back to the library's static codes.
fn known_code(code: &str) -> &'static str {
    match code {
        "INVALID_DHALL" => "INVALID_DHALL",
        "INVALID_IJSON" => "INVALID_IJSON",
        "NON_FINITE_NUMBER" => "NON_FINITE_NUMBER",
        "INVALID_UTF8" => "INVALID_UTF8",
        "INPUT_LIMIT" => "INPUT_LIMIT",
        _ => "DHALL_WORKER_FAILED",
    }
}

fn describe(status: ExitStatus) -> String {
    match status.code() {
        Some(code) => format!("exit status {code}"),
        None => "ended by a signal".into(),
    }
}

/// Parent side: evaluate `input` as Dhall in a confined worker.
pub fn evaluate(input: &[u8]) -> Result<Vec<Value>, Error> {
    if input.len() > MAX_INPUT_BYTES {
        return Err(refusal("INPUT_LIMIT", "input exceeds 8 MiB"));
    }
    let exe = std::env::current_exe()
        .map_err(|e| refusal("DHALL_WORKER_FAILED", format!("cannot locate kyq: {e}")))?;
    let mut child = Command::new(exe)
        .arg(WORKER_ARG)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| refusal("DHALL_WORKER_FAILED", format!("cannot start worker: {e}")))?;
    let start = Instant::now();
    let limit = Duration::from_millis(DHALL_TIME_LIMIT_MS);

    let (Some(mut stdin), Some(stdout), Some(stderr)) =
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(refusal("DHALL_WORKER_FAILED", "worker pipes unavailable"));
    };
    let source = input.to_vec();
    // A worker that ends early closes its stdin; the write error is expected then.
    let writer = thread::spawn(move || {
        let _ = stdin.write_all(&source);
    });
    let out_reader = thread::spawn(move || drain(stdout, DHALL_OUTPUT_MAX_BYTES, None));
    // The worker reports a failed allocation on stderr and then aborts. Where
    // the OS pipes crash dumps to a handler (systemd-coredump on Linux), the
    // aborting worker can take seconds to end while its heap is written out.
    // Waiting for that would turn a memory refusal into a time refusal, so
    // the parent watches stderr and kills the worker once the line appears.
    let out_of_memory = Arc::new(AtomicBool::new(false));
    let alarm = Arc::clone(&out_of_memory);
    let err_reader = thread::spawn(move || drain(stderr, STDERR_MAX_BYTES, Some(alarm.as_ref())));

    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if out_of_memory.load(Ordering::Acquire) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = writer.join();
                let _ = out_reader.join();
                let _ = err_reader.join();
                return Err(memory_limit());
            }
            Ok(None) if start.elapsed() >= limit => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Ok(None) => thread::sleep(POLL),
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(refusal("DHALL_WORKER_FAILED", e.to_string()));
            }
        }
    };
    let _ = writer.join();
    let out = out_reader.join().unwrap_or_default();
    let err = err_reader.join().unwrap_or_default();
    let err = String::from_utf8_lossy(&err);

    let Some(status) = status else {
        return Err(refusal(
            "DHALL_TIME_LIMIT",
            format!("Dhall evaluation exceeded {DHALL_TIME_LIMIT_MS} ms"),
        ));
    };
    if status.success() {
        if out.len() > DHALL_OUTPUT_MAX_BYTES {
            return Err(refusal(
                "DHALL_OUTPUT_LIMIT",
                format!("Dhall result exceeds {DHALL_OUTPUT_MAX_BYTES} bytes"),
            ));
        }
        // serde_json's recursion limit (128) applies here, as for JSON input.
        let value: Value =
            serde_json::from_slice(&out).map_err(|e| refusal("INVALID_IJSON", e.to_string()))?;
        ijson_jcs::validate_canonicalizable(&value)
            .map_err(|e| refusal("INVALID_IJSON", e.to_string()))?;
        return Ok(vec![value]);
    }
    if status.code() == Some(REFUSED_EXIT) {
        let (code, message) = err.split_once('\n').unwrap_or((&err, ""));
        return Err(refusal(known_code(code), message.to_owned()));
    }
    if err.contains(ALLOC_FAILURE) {
        return Err(memory_limit());
    }
    if err.contains(STACK_OVERFLOW) {
        return Err(refusal(
            "DHALL_STACK_LIMIT",
            "Dhall evaluation exceeded the worker's stack",
        ));
    }
    Err(refusal(
        "DHALL_WORKER_FAILED",
        format!("Dhall worker {}", describe(status)),
    ))
}
