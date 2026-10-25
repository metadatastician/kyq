// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell (hyperpolymath) <j.d.a.jewell@open.ac.uk>
//
// `kyq-conformance` — the executable KYAML / I-JSON / JCS gate.
//
// The surface deliberately mirrors `hyperpolymath/ijson-jcs` so a consumer that
// already gates JSON can add KYAML without learning a second contract:
//
//   check FILE...   OK | NOT CANONICAL | INVALID, exit 0 / 1 / 2
//   fix FILE...     OK | FIXED | INVALID,         exit 0 / 2
//   canon           stdin -> JCS bytes on stdout (no trailing newline), exit 0/2
//   validate FILE...  "is this KYAML?" (parse + JSON bridge), exit 0 / 2
//
// Canonical form per format:
//   JSON  — RFC 8785 bytes, optionally followed by exactly one `\n`.
//   KYAML — the formatter's output (which always ends in exactly one `\n`),
//           optionally followed by no newline, i.e. the same rule applied to
//           the formatter's single trailing newline.

import { readFileSync, writeFileSync } from "node:fs";

import { formatStream } from "./emit.js";
import { ConformanceError } from "./errors.js";
import { toJcs } from "./jcs.js";
import { parseIJson } from "./json.js";
import { bridgeDocument, bridgeStream } from "./bridge.js";
import { parseKyaml } from "./kyaml.js";
import { VERSION } from "./version.js";

/** Exit status: every input valid and canonical (or fixed). */
export const EXIT_OK = 0;
/** Exit status: `check` found a valid but non-canonical file. */
export const EXIT_NOT_CANONICAL = 1;
/** Exit status: invalid input, an I/O failure, or a usage error. */
export const EXIT_INVALID = 2;

const USAGE = `kyq-conformance ${VERSION} — KYAML / I-JSON / JCS conformance gate

USAGE:
    kyq-conformance check [OPTIONS] FILE...       Report whether each FILE is canonical
    kyq-conformance fix   [OPTIONS] FILE...       Rewrite each valid FILE in canonical form
    kyq-conformance canon [OPTIONS]               Canonicalise stdin to stdout (JCS bytes)
    kyq-conformance validate [OPTIONS] FILE...    Parse FILE as KYAML and bridge it to JSON
    kyq-conformance --help                        Show this help
    kyq-conformance --version                     Show the version

FORMAT:
    --format yaml|json   Force the input format. Without it, *.json is read as
                         strict I-JSON and *.yaml / *.yml as KYAML; any other
                         extension is an error, and stdin defaults to KYAML.
    --array              canon only: bridge a multi-document KYAML stream as one
                         JSON array instead of refusing it.

REPORTING:
    --report text|json   text (default) prints one line per file; json prints one
                         JSON object per file with the diagnostic code, line,
                         column and JSON Pointer path.

CANONICAL FORM:
    JSON   RFC 8785 (JCS) bytes, optionally followed by exactly one newline.
    KYAML  The canonical KYAML form produced by \`fix\`, optionally with its single
           trailing newline removed.

    \`fix\` always writes the canonical form plus exactly one newline. \`canon\`
    writes no trailing newline, because its output is the byte string to hash or
    sign.

EXIT STATUS:
    0  all inputs valid and canonical (check), or all valid/fixed (fix, canon, validate)
    1  check: some input valid but not canonical (and none invalid)
    2  some input invalid or unreadable, a write failed, or a usage error

Use \`--\` before file names that begin with \`-\`.
`;

/**
 * A usage error: printed with a hint and reported as exit 2.
 */
class UsageError extends Error {}

/**
 * Parse the command line (without `node` and the script path).
 *
 * @param {string[]} argv
 * @returns {{command: string, files: string[], format: "yaml"|"json"|null,
 *            report: "text"|"json", array: boolean}}
 */
function parseArgs(argv) {
  if (argv.includes("-h") || argv.includes("--help")) {
    return { command: "help", files: [], format: null, report: "text", array: false };
  }
  if (argv.includes("-V") || argv.includes("--version")) {
    return { command: "version", files: [], format: null, report: "text", array: false };
  }
  const [command, ...rest] = argv;
  if (!command) throw new UsageError("missing command");
  const files = [];
  let format = null;
  let report = "text";
  let array = false;
  let endOfOptions = false;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!endOfOptions && arg === "--") {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && arg.startsWith("--format=")) {
      format = arg.slice("--format=".length);
      continue;
    }
    if (!endOfOptions && arg === "--format") {
      format = rest[index + 1];
      index += 1;
      continue;
    }
    if (!endOfOptions && arg.startsWith("--report=")) {
      report = arg.slice("--report=".length);
      continue;
    }
    if (!endOfOptions && arg === "--report") {
      report = rest[index + 1];
      index += 1;
      continue;
    }
    if (!endOfOptions && arg === "--array") {
      array = true;
      continue;
    }
    if (!endOfOptions && arg.startsWith("-") && arg.length > 1) {
      throw new UsageError(`unknown option '${arg}'`);
    }
    files.push(arg);
  }

  if (format !== null && format !== "yaml" && format !== "json") {
    throw new UsageError(`--format must be 'yaml' or 'json', got '${format}'`);
  }
  if (report !== "text" && report !== "json") {
    throw new UsageError(`--report must be 'text' or 'json', got '${report}'`);
  }
  return { command, files, format, report, array };
}

/**
 * Decide the input format for one file.
 *
 * @param {string} file
 * @param {"yaml"|"json"|null} forced
 * @returns {"yaml"|"json"}
 */
function formatOf(file, forced) {
  if (forced) return forced;
  if (file.endsWith(".json")) return "json";
  if (file.endsWith(".yaml") || file.endsWith(".yml")) return "yaml";
  throw new UsageError(
    `cannot tell the format of '${file}' from its extension; pass --format yaml or --format json`,
  );
}

/**
 * Canonical text of a JSON input, or a diagnostic.
 *
 * @param {Uint8Array} bytes
 * @returns {{text: string, body: string}} `text` includes the canonical body;
 *   `body` is the canonical JCS bytes as text (no trailing newline).
 */
function canonicalJson(bytes) {
  const value = parseIJson(bytes);
  const body = new TextDecoder().decode(toJcs(value));
  return { text: `${body}\n`, body, format: "json" };
}

/**
 * Canonical text of a KYAML input, or a diagnostic.
 *
 * Every document is bridged even when the caller only wants the formatted text:
 * KYAML conformance includes JSON-model compatibility (spec §2), so `check` and
 * `fix` must refuse a document that `to-json` would have to reject.
 *
 * @param {Uint8Array} bytes
 * @returns {{text: string, documents: unknown[], format: "yaml"}}
 */
function canonicalYaml(bytes) {
  const documents = parseKyaml(bytes);
  for (const document of documents) bridgeDocument(document);
  return { text: formatStream(documents), documents, format: "yaml" };
}

/**
 * Build the canonical form for one buffer.
 *
 * @param {Uint8Array} bytes
 * @param {"yaml"|"json"} format
 * @returns {{text: string, format: "yaml"|"json"}}
 */
function canonicalForm(bytes, format) {
  if (format === "json") {
    const { text, body } = canonicalJson(bytes);
    return { text, body, format };
  }
  const { text, documents } = canonicalYaml(bytes);
  return { text, documents, format };
}

/**
 * Whether `bytes` are the canonical form, allowing exactly one final newline.
 *
 * @param {Uint8Array} bytes
 * @param {string} canonicalText  Canonical form; either ends with one `\n` or is empty.
 * @param {"yaml"|"json"} format
 * @returns {boolean}
 */
function isCanonical(bytes, canonicalText, format) {
  const input = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(bytes);
  if (format === "json") {
    // JSON canonical body has no trailing newline: accept `b` or `b\n`.
    const body = canonicalText.endsWith("\n")
      ? canonicalText.slice(0, -1)
      : canonicalText;
    const stripped = input.endsWith("\n") ? input.slice(0, -1) : input;
    return stripped === body;
  }
  // KYAML canonical text ends with exactly one newline: accept it, or the same
  // text without that newline.
  return input === canonicalText || input === canonicalText.replace(/\n$/, "");
}

/**
 * Emit one result line (text or JSON report).
 *
 * @param {{file: string, format: string, status: string,
 *          error: ConformanceError|null}} result
 * @param {"text"|"json"} report
 * @returns {void}
 */
function emitResult(result, report) {
  if (report === "json") {
    const payload = {
      file: result.file,
      format: result.format,
      status: result.status,
      error: result.error ? result.error.toJSON() : null,
    };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  switch (result.status) {
    case "ok":
      process.stdout.write(`OK ${result.file}\n`);
      break;
    case "not-canonical":
      process.stdout.write(`NOT CANONICAL ${result.file}\n`);
      break;
    case "fixed":
      process.stdout.write(`FIXED ${result.file}\n`);
      break;
    default:
      process.stdout.write(`INVALID ${result.file}: ${result.error.reason}\n`);
  }
}

/**
 * Read one file, converting an I/O failure into a diagnostic result.
 *
 * @param {string} file
 * @returns {Uint8Array|null}
 */
function readInput(file) {
  try {
    return readFileSync(file);
  } catch (error) {
    return null;
  }
}

/**
 * Wrap an arbitrary exception as a `ConformanceError`.
 *
 * @param {unknown} error
 * @returns {ConformanceError}
 */
function asConformanceError(error) {
  if (error instanceof ConformanceError) return error;
  return new ConformanceError({
    code: "INTERNAL_ERROR",
    kind: "kyaml",
    message: error instanceof Error ? error.message : String(error),
  });
}

/**
 * `check`: report each file's canonical status.
 *
 * @param {string[]} files
 * @param {"yaml"|"json"|null} forcedFormat
 * @param {"text"|"json"} report
 * @returns {number} Exit status.
 */
function commandCheck(files, forcedFormat, report) {
  let code = EXIT_OK;
  for (const file of files) {
    const format = formatOf(file, forcedFormat);
    const bytes = readInput(file);
    if (bytes === null) {
      emitResult(
        {
          file,
          format,
          status: "invalid",
          error: new ConformanceError({
            code: "IO_ERROR",
            kind: format,
            message: "cannot read: file is missing or unreadable",
          }),
        },
        report,
      );
      code = EXIT_INVALID;
      continue;
    }
    try {
      const { text } = canonicalForm(bytes, format);
      if (isCanonical(bytes, text, format)) {
        emitResult({ file, format, status: "ok", error: null }, report);
      } else {
        emitResult({ file, format, status: "not-canonical", error: null }, report);
        code = Math.max(code, EXIT_NOT_CANONICAL);
      }
    } catch (error) {
      emitResult(
        { file, format, status: "invalid", error: asConformanceError(error) },
        report,
      );
      code = EXIT_INVALID;
    }
  }
  return code;
}

/**
 * `fix`: rewrite each valid file in canonical form.
 *
 * @param {string[]} files
 * @param {"yaml"|"json"|null} forcedFormat
 * @param {"text"|"json"} report
 * @returns {number} Exit status.
 */
function commandFix(files, forcedFormat, report) {
  let code = EXIT_OK;
  for (const file of files) {
    const format = formatOf(file, forcedFormat);
    const bytes = readInput(file);
    if (bytes === null) {
      emitResult(
        {
          file,
          format,
          status: "invalid",
          error: new ConformanceError({
            code: "IO_ERROR",
            kind: format,
            message: "cannot read: file is missing or unreadable",
          }),
        },
        report,
      );
      code = EXIT_INVALID;
      continue;
    }
    let canonicalText;
    try {
      canonicalText = canonicalForm(bytes, format).text;
    } catch (error) {
      emitResult(
        { file, format, status: "invalid", error: asConformanceError(error) },
        report,
      );
      code = EXIT_INVALID;
      continue;
    }
    // `fix` rewrites whenever the bytes are not exactly the canonical text,
    // so a bare canonical file gains its single trailing newline (ijson-jcs
    // `fix_adds_newline_to_bare_canonical_form`).
    if (Buffer.from(bytes).toString("utf8") === canonicalText) {
      emitResult({ file, format, status: "ok", error: null }, report);
      continue;
    }
    try {
      writeFileSync(file, canonicalText);
    } catch (error) {
      emitResult(
        {
          file,
          format,
          status: "invalid",
          error: new ConformanceError({
            code: "IO_ERROR",
            kind: format,
            message: `cannot write: ${error instanceof Error ? error.message : String(error)}`,
          }),
        },
        report,
      );
      code = EXIT_INVALID;
      continue;
    }
    emitResult({ file, format, status: "fixed", error: null }, report);
  }
  return code;
}

/**
 * `canon`: canonicalise stdin to stdout.
 *
 * @param {"yaml"|"json"|null} forcedFormat
 * @param {boolean} array
 * @returns {number} Exit status.
 */
function commandCanon(forcedFormat, array) {
  const format = forcedFormat ?? "yaml";
  let bytes;
  try {
    bytes = readFileSync(0);
  } catch (error) {
    process.stderr.write(
      `INVALID <stdin>: cannot read: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return EXIT_INVALID;
  }
  try {
    let value;
    if (format === "json") {
      value = parseIJson(bytes);
    } else {
      const documents = parseKyaml(bytes);
      value = bridgeStream(documents, { array });
    }
    const canonical = toJcs(value);
    process.stdout.write(Buffer.from(canonical));
    return EXIT_OK;
  } catch (error) {
    process.stderr.write(`INVALID <stdin>: ${asConformanceError(error).reason}\n`);
    return EXIT_INVALID;
  }
}

/**
 * `validate`: parse as KYAML and bridge to JSON, without judging canonical form.
 *
 * @param {string[]} files
 * @param {"text"|"json"} report
 * @returns {number} Exit status.
 */
function commandValidate(files, report) {
  let code = EXIT_OK;
  for (const file of files) {
    const bytes = readInput(file);
    if (bytes === null) {
      emitResult(
        {
          file,
          format: "yaml",
          status: "invalid",
          error: new ConformanceError({
            code: "IO_ERROR",
            kind: "kyaml",
            message: "cannot read: file is missing or unreadable",
          }),
        },
        report,
      );
      code = EXIT_INVALID;
      continue;
    }
    try {
      const documents = parseKyaml(bytes);
      for (const document of documents) bridgeDocument(document);
      emitResult({ file, format: "yaml", status: "ok", error: null }, report);
    } catch (error) {
      emitResult(
        { file, format: "yaml", status: "invalid", error: asConformanceError(error) },
        report,
      );
      code = EXIT_INVALID;
    }
  }
  return code;
}

/**
 * Run the CLI.
 *
 * @param {string[]} argv  Arguments after the program name.
 * @returns {number} Process exit status.
 */
export function run(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`kyq-conformance: ${error.message}\nTry 'kyq-conformance --help' for usage.\n`);
      return EXIT_INVALID;
    }
    throw error;
  }

  try {
    switch (options.command) {
      case "help":
        process.stdout.write(USAGE);
        return EXIT_OK;
      case "version":
        process.stdout.write(`kyq-conformance ${VERSION}\n`);
        return EXIT_OK;
      case "check":
        if (options.files.length === 0) {
          throw new UsageError("'check' needs at least one FILE");
        }
        return commandCheck(options.files, options.format, options.report);
      case "fix":
      case "fmt":
        if (options.files.length === 0) {
          throw new UsageError(`'${options.command}' needs at least one FILE`);
        }
        return commandFix(options.files, options.format, options.report);
      case "canon":
        if (options.files.length > 0) {
          throw new UsageError("'canon' reads stdin and takes no FILE");
        }
        return commandCanon(options.format, options.array);
      case "validate":
        if (options.files.length === 0) {
          throw new UsageError("'validate' needs at least one FILE");
        }
        if (options.format === "json") {
          throw new UsageError("'validate' checks KYAML; use 'check --format json' for JSON");
        }
        return commandValidate(options.files, options.report);
      default:
        throw new UsageError(`unknown command '${options.command}'`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`kyq-conformance: ${error.message}\nTry 'kyq-conformance --help' for usage.\n`);
      return EXIT_INVALID;
    }
    throw error;
  }
}
