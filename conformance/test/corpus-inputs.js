// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell (hyperpolymath) <j.d.a.jewell@open.ac.uk>
//
// Every input the corpus holds, as bytes with the format the CLI would read
// them in. Used by the closure tests (budgets.test.js) and the translation
// validation tests (tv.test.js), so both run over the same denominator.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { conformanceRoot, fromHex, readCorpus, utf8 } from "./helpers.js";

/**
 * @typedef {{name: string, bytes: Uint8Array, format: "yaml"|"json", source: string}} CorpusInput
 */

/**
 * Inputs from the fixture corpus (always present, also in the tarball).
 *
 * @returns {CorpusInput[]}
 */
export function fixtureInputs() {
  /** @type {CorpusInput[]} */
  const inputs = [];
  const kyamlRoot = join(conformanceRoot, "fixtures", "kyaml");
  for (const directory of ["valid", "invalid", "fix"]) {
    for (const name of readdirSync(join(kyamlRoot, directory)).sort()) {
      if (!name.endsWith(".yaml") && !name.endsWith(".yml")) continue;
      inputs.push({
        name: `kyaml/${directory}/${name}`,
        bytes: readFileSync(join(kyamlRoot, directory, name)),
        format: "yaml",
        source: "kyaml-fixture",
      });
    }
  }
  for (const vector of readCorpus("bridge/vectors.json").vectors) {
    inputs.push({ name: `bridge/${vector.name}`, bytes: utf8(vector.yaml), format: "yaml", source: "bridge-vector" });
  }
  for (const vector of readCorpus("ijson/vectors.json").vectors) {
    const bytes = vector.input_hex ? fromHex(vector.input_hex) : utf8(vector.input);
    inputs.push({ name: `ijson/${vector.name}`, bytes, format: "json", source: "ijson-vector" });
  }
  for (const vector of readCorpus("ijson/check.json").vectors) {
    inputs.push({ name: `check/${vector.name}`, bytes: utf8(vector.bytes), format: "json", source: "check-vector" });
  }
  const rfc = readCorpus("rfc8785/vectors.json");
  for (const vector of rfc.numbers) {
    inputs.push({ name: `rfc8785/number/${vector.token}`, bytes: utf8(`[${vector.token}]`), format: "json", source: "rfc8785" });
  }
  rfc.strings.forEach((vector, index) => {
    inputs.push({ name: `rfc8785/string/${index}`, bytes: utf8(`"${vector.raw}"`), format: "json", source: "rfc8785" });
  });
  for (const vector of rfc.sorting) {
    inputs.push({ name: `rfc8785/sorting/${vector.name}`, bytes: utf8(vector.input), format: "json", source: "rfc8785" });
  }
  const oracle = readCorpus("oracle/ijson-jcs.json");
  for (const group of ["canonVectors", "acceptVectors", "rejectVectors"]) {
    for (const vector of oracle[group]) {
      inputs.push({ name: `oracle/${group}/${vector.name}`, bytes: utf8(vector.input), format: "json", source: "oracle" });
    }
  }
  return inputs;
}

/**
 * Tracked `*.yaml`, `*.yml` and `*.json` files of the parent repository, when
 * the gate runs inside it. Returns `null` outside a git checkout, so a caller
 * can report the layout instead of silently counting zero.
 *
 * @returns {CorpusInput[]|null}
 */
export function repositoryInputs() {
  const root = join(conformanceRoot, "..");
  if (!existsSync(join(root, ".git"))) return null;
  const listed = spawnSync("git", ["ls-files", "*.yaml", "*.yml", "*.json"], { cwd: root });
  if (listed.status !== 0) return null;
  return listed.stdout
    .toString("utf8")
    .split("\n")
    .filter((line) => line !== "" && existsSync(join(root, line)))
    .map((file) => ({
      name: `repo/${file}`,
      bytes: readFileSync(join(root, file)),
      format: file.endsWith(".json") ? "json" : "yaml",
      source: "repository",
    }));
}
