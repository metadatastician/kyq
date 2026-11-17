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

import { closeSync, fstatSync, openSync, readFileSync, writeFileSync } from "node:fs";

import { MAX_INPUT_BYTES, budgetError, budgetMessage } from "./budgets.js";

import { formatStream } from "./emit.js";
import { ConformanceError } from "./errors.js";
import { toJcs } from "./jcs.js";
import { parseIJson } from "./json.js";
import { bridgeDocuments, bridgeStream } from "./bridge.js";
import { parseKyaml, parseKyamlWithComments } from "./kyaml.js";
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

    \`fix\` always writes the canonical form plus exactly one newline, except that a
    leading header comment block (e.g. the SPDX line) is kept byte for byte; any other
    comment makes \`fix\` refuse the file (COMMENTS_WOULD_BE_LOST, exit 2). \`canon\`
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
  bridgeDocuments(documents);
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
 * The leading header comment block of a KYAML stream: every comment and blank
 * line before the first content line (spec §7.3). A stream whose prefix holds
 * no comment has no header (blank lines alone are not preserved). A leading
 * BOM is not part of the header; it is dropped, as before.
 *
 * @param {string} text  The decoded input as read (not newline-normalised).
 * @returns {{header: string, lines: number}} The header bytes, verbatim, and
 *   the number of source lines it spans.
 */
function headerBlock(text) {
  const start = text.startsWith("\uFEFF") ? 1 : 0;
  let end = start;
  let lines = 0;
  let sawComment = false;
  while (end < text.length) {
    let next = text.indexOf("\n", end);
    const lineEnd = next === -1 ? text.length : next;
    next = next === -1 ? text.length : next + 1;
    // A header line is blank, or a comment (`#` after only blanks).
    let k = end;
    while (k < lineEnd && (text[k] === " " || text[k] === "\t")) k += 1;
    const isComment = text[k] === "#";
    const isBlank = k === lineEnd || (k === lineEnd - 1 && text[k] === "\r");
    if (!isComment && !isBlank) break;
    end = next;
    lines += 1;
    if (isComment) sawComment = true;
  }
  if (!sawComment) return { header: "", lines: 0 };
  // Blank lines around the comments are kept verbatim: the header is every
  // byte up to the first content line.
  return { header: text.slice(start, end), lines };
}

/**
 * The canonical text of a KYAML input: the header comment block verbatim (with
 * a terminating newline when it has none), then the formatted body. This is
 * the one definition both `fix` (writes it) and `check` (accepts it) use, so
 * `check(fix x) = OK` holds by construction.
 *
 * @param {Uint8Array} bytes
 * @param {boolean} recordLost  `fix` passes true: the first comment outside the
 *   header is then reported in `lost`. `check` records nothing (O(1) memory).
 * @returns {{text: string, lost: {line: number, column: number}|null}}
 * @throws {ConformanceError}
 */
function yamlCanonicalText(bytes, recordLost) {
  const input = Buffer.from(bytes).toString("utf8");
  const { header, lines } = headerBlock(input);
  const { documents, lostComment } = parseKyamlWithComments(
    bytes,
    undefined,
    recordLost ? lines : null,
  );
  bridgeDocuments(documents);
  const head = header === "" || header.endsWith("\n") ? header : `${header}\n`;
  return { text: head + formatStream(documents), lost: lostComment };
}

/**
 * The text `fix` writes for a KYAML input: the header comment block verbatim,
 * then the canonical body. Refuses (`COMMENTS_WOULD_BE_LOST`) when a comment
 * outside the header would be dropped, and (`INPUT_BUDGET_EXCEEDED`) when the
 * result would be over the input budget, so `fix` never writes a file the
 * gate would then refuse.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 * @throws {ConformanceError}
 */
function fixedYamlText(bytes) {
  const { text, lost } = yamlCanonicalText(bytes, true);
  if (lost) {
    throw new ConformanceError({
      code: "COMMENTS_WOULD_BE_LOST",
      kind: "kyaml",
      message:
        "formatting would drop this comment (comments are not data; only the leading header comment block is kept); move it into the header or remove it",
      line: lost.line,
      column: lost.column,
    });
  }
  return assertOutputBudget(text, "yaml");
}

/**
 * Refuse a `fix` result longer than the input budget (the header is written
 * verbatim and is not covered by `outputBound`).
 *
 * @param {string} text
 * @param {"yaml"|"json"} format
 * @returns {string}
 * @throws {ConformanceError}
 */
function assertOutputBudget(text, format) {
  const size = Buffer.byteLength(text);
  if (size > MAX_INPUT_BYTES) {
    throw budgetError("input", budgetMessage.output(size), {
      kind: format === "json" ? "json" : "kyaml",
    });
  }
  return text;
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
  // KYAML canonical text (header + body) ends with a newline: accept it, or the
  // same text without that final newline.
  return input === canonicalText || input === canonicalText.replace(/\n$/, "");
}

/**
 * The `check` verdict for one buffer, as the CLI computes it (exported so the
 * closure tests exercise exactly the code the CLI runs).
 *
 * @param {Uint8Array} bytes
 * @param {"yaml"|"json"} format
 * @returns {{status: "ok"|"not-canonical"|"invalid", error: ConformanceError|null}}
 */
export function checkVerdict(bytes, format) {
  try {
    const { text } =
      format === "yaml" ? yamlCanonicalText(bytes, false) : canonicalForm(bytes, format);
    return isCanonical(bytes, text, format)
      ? { status: "ok", error: null }
      : { status: "not-canonical", error: null };
  } catch (error) {
    return { status: "invalid", error: asConformanceError(error, format) };
  }
}

/**
 * The bytes `canon` writes for one buffer (no trailing newline), or a throw.
 *
 * @param {Uint8Array} bytes
 * @param {"yaml"|"json"} format
 * @param {boolean} [array]
 * @returns {Uint8Array}
 * @throws {ConformanceError}
 */
export function canonBytes(bytes, format, array = false) {
  const value = format === "json" ? parseIJson(bytes) : bridgeStream(parseKyaml(bytes), { array });
  return toJcs(value);
}

/**
 * The text `fix` writes for one buffer, or a throw.
 *
 * @param {Uint8Array} bytes
 * @param {"yaml"|"json"} format
 * @returns {string}
 * @throws {ConformanceError}
 */
export function fixText(bytes, format) {
  return format === "yaml" ? fixedYamlText(bytes) : canonicalForm(bytes, format).text;
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
 * The CLI-edge input guard (budgets.js MAX_INPUT_BYTES): the only limit on
 * encoded bytes. It is set above the largest canonical text any accepted value
 * can have, so it never refuses `canon` output of an accepted input. `fix` also
 * writes the header verbatim, so it refuses by itself (INPUT_BUDGET_EXCEEDED)
 * when header + body would pass the budget.
 */
class InputTooLarge extends Error {
  /** @param {number} size */
  constructor(size) {
    super(budgetMessage.input(size));
    this.size = size;
  }
}

/**
 * Read one file, converting an I/O failure into a diagnostic result. A file
 * over the input budget is refused from its size, before it is read.
 *
 * @param {string} file
 * @returns {Uint8Array|null|InputTooLarge}
 */
function readInput(file) {
  let fd;
  try {
    fd = openSync(file, "r");
    const { size } = fstatSync(fd);
    if (size > MAX_INPUT_BYTES) return new InputTooLarge(size);
    const bytes = readFileSync(fd);
    // A file that grew (or a device with no size) is checked again after reading.
    if (bytes.length > MAX_INPUT_BYTES) return new InputTooLarge(bytes.length);
    return bytes;
  } catch (error) {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * The diagnostic for an input over the budget.
 *
 * @param {InputTooLarge} tooLarge
 * @param {"yaml"|"json"} format
 * @returns {ConformanceError}
 */
function inputBudgetError(tooLarge, format) {
  return budgetError("input", tooLarge.message, { kind: format === "json" ? "json" : "kyaml" });
}

/**
 * Wrap an arbitrary exception as a `ConformanceError`.
 *
 * @param {unknown} error
 * @param {"yaml"|"json"} [format]  The input format, so an unexpected failure
 *   (stack overflow, internal error) reports the contract that was running.
 * @returns {ConformanceError}
 */
function asConformanceError(error, format = "yaml") {
  if (error instanceof ConformanceError) return error;
  return new ConformanceError({
    code: "INTERNAL_ERROR",
    kind: format === "json" ? "json" : "kyaml",
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
    if (bytes instanceof InputTooLarge) {
      emitResult({ file, format, status: "invalid", error: inputBudgetError(bytes, format) }, report);
      code = EXIT_INVALID;
      continue;
    }
    const verdict = checkVerdict(bytes, format);
    emitResult({ file, format, ...verdict }, report);
    if (verdict.status === "not-canonical") code = Math.max(code, EXIT_NOT_CANONICAL);
    if (verdict.status === "invalid") code = EXIT_INVALID;
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
    if (bytes instanceof InputTooLarge) {
      emitResult({ file, format, status: "invalid", error: inputBudgetError(bytes, format) }, report);
      code = EXIT_INVALID;
      continue;
    }
    let canonicalText;
    try {
      canonicalText = fixText(bytes, format);
    } catch (error) {
      emitResult(
        { file, format, status: "invalid", error: asConformanceError(error, format) },
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
  if (bytes.length > MAX_INPUT_BYTES) {
    const error = inputBudgetError(new InputTooLarge(bytes.length), format);
    process.stderr.write(`INVALID <stdin>: ${error.reason}\n`);
    return EXIT_INVALID;
  }
  try {
    const canonical = canonBytes(bytes, format, array);
    process.stdout.write(Buffer.from(canonical));
    return EXIT_OK;
  } catch (error) {
    process.stderr.write(`INVALID <stdin>: ${asConformanceError(error, format).reason}\n`);
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
    if (bytes instanceof InputTooLarge) {
      emitResult({ file, format: "yaml", status: "invalid", error: inputBudgetError(bytes, "yaml") }, report);
      code = EXIT_INVALID;
      continue;
    }
    try {
      const documents = parseKyaml(bytes);
      bridgeDocuments(documents);
      emitResult({ file, format: "yaml", status: "ok", error: null }, report);
    } catch (error) {
      emitResult(
        { file, format: "yaml", status: "invalid", error: asConformanceError(error, "yaml") },
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
