// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell (hyperpolymath) <j.d.a.jewell@open.ac.uk>
//
// The generated boundary rows of fixtures/oracle/divergences.json
// (`budgetDivergences`): inputs one step over a J-3 budget that
// hyperpolymath/ijson-jcs accepts (measured at 2c880594 and 1735d68) and the
// gate refuses with a typed code. Generated rather than stored: the node row
// is 1 MB and the string row 8 MiB.
//
// Used by tools/ijson-jcs-diff.mjs (the oracle must still accept them, the gate
// must refuse them) and by test/budgets.test.js (the gate refuses them).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const divergencesPath = fileURLToPath(new URL("../fixtures/oracle/divergences.json", import.meta.url));

/** @returns {{case: string, generator: string, code: string, size: number}[]} */
export function budgetDivergenceRows() {
  return JSON.parse(readFileSync(divergencesPath, "utf8")).budgetDivergences;
}

/**
 * The bytes of one generated row.
 *
 * @param {{generator: string, size: number}} row
 * @returns {Buffer}
 */
export function budgetRowBytes(row) {
  if (row.generator === "array-of-zeros") {
    // `size` elements: `size` zeros and the array make size + 1 nodes.
    return Buffer.from(`[${"0,".repeat(row.size - 1)}0]`);
  }
  if (row.generator === "string-of-x") {
    // A one-element array holding a string of exactly `size` bytes.
    return Buffer.from(`["${"x".repeat(row.size)}"]`);
  }
  throw new Error(`unknown generator ${row.generator}`);
}
