// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell (hyperpolymath) <j.d.a.jewell@open.ac.uk>
//
// I-JSON (RFC 7493) and JCS (RFC 8785) contract tests.
//
// Three sources of truth are exercised separately, so a regression cannot hide
// behind agreement between two copies of the same mistake:
//
//   1. `fixtures/rfc8785` — the RFC's own §3.2.2.3 / §3.2.3 examples;
//   2. `fixtures/ijson` — the gate's own strict-parsing corpus, including the
//      classes `hyperpolymath/ijson-jcs` refuses;
//   3. `fixtures/oracle` — expectations transcribed from the pinned
//      `ijson-jcs` sources (and re-derivable in CI by
//      `tools/ijson-jcs-diff.mjs`).

import assert from "node:assert/strict";
import { test } from "node:test";

import { isUnsafeIntegerFloat, parseIJson } from "../src/json.js";
import { toJcs, toJcsString, esNumberToString } from "../src/jcs.js";
import { fromHex, readCorpus, utf8 } from "./helpers.js";

const ijson = readCorpus("ijson/vectors.json");
const rfc = readCorpus("rfc8785/vectors.json");
const oracle = readCorpus("oracle/ijson-jcs.json");
/** Rows where the gate deliberately refuses what the pinned oracle accepts (R3). */
const divergences = new Map(
  readCorpus("oracle/divergences.json").divergences.map((row) => [row.case, row]),
);

/**
 * Canonicalise JSON text, returning `{jcs}` or throwing.
 *
 * @param {string} text
 * @returns {string}
 */
function canon(text) {
  return toJcsString(parseIJson(utf8(text)));
}

test("I-JSON corpus: canonical byte vectors", async (t) => {
  const vectors = ijson.vectors.filter((vector) => vector.jcs !== undefined);
  assert.ok(vectors.length >= 10, "the canonical corpus must not be vacuous");
  for (const vector of vectors) {
    await t.test(vector.name, () => {
      assert.equal(canon(vector.input), vector.jcs);
      // Canonical bytes are a fixed point, with no exceptions since ruling R3
      // refuses the floats whose canonical text was not strict input.
      assert.equal(vector.reflexive, undefined, "no vector may opt out of reflexivity");
      assert.equal(canon(vector.jcs), vector.jcs);
    });
  }
});

test("I-JSON corpus: refusal vectors keep their code and path", async (t) => {
  const vectors = ijson.vectors.filter((vector) => vector.error !== undefined);
  assert.ok(vectors.length >= 10, "the refusal corpus must not be vacuous");
  for (const vector of vectors) {
    await t.test(vector.name, () => {
      const bytes = vector.input_hex
        ? fromHex(vector.input_hex)
        : utf8(vector.input);
      assert.throws(
        () => {
          const value = parseIJson(bytes);
          return toJcsString(value);
        },
        (error) => {
          assert.equal(error.code, vector.error.code, error.reason);
          if (vector.error.path !== undefined) {
            assert.equal(error.path ?? "", vector.error.path, error.reason);
          }
          return true;
        },
      );
    });
  }
});

test("RFC 8785 §3.2.2.3: number tokens canonicalise with ES rules", async (t) => {
  let refused = 0;
  for (const vector of rfc.numbers) {
    await t.test(vector.token, () => {
      // The formatter is the RFC's algorithm for every vector.
      assert.equal(esNumberToString(Number(vector.token)), vector.jcs);
      if (isUnsafeIntegerFloat(Number(vector.token))) {
        // Ruling R3: the RFC prints these as integer tokens outside ±(2^53−1),
        // which strict I-JSON refuses, so the gate refuses them as input.
        refused += 1;
        for (const text of [vector.token, `[${vector.token}]`]) {
          assert.throws(() => canon(text), (error) => error.code === "UNSAFE_FLOAT_INTEGER");
        }
        return;
      }
      assert.equal(canon(vector.token), vector.jcs);
      // A number inside a container uses the same text.
      assert.equal(canon(`[${vector.token}]`), `[${vector.jcs}]`);
    });
  }
  // 1e20, 123456789012345680000.0 and 9007199254740992.0.
  assert.equal(refused, 3);
});

test("esNumberToString agrees with the ECMAScript algorithm", () => {
  // Independent of the parser: the formatter itself is the ES algorithm.
  for (const vector of oracle.esNumberVectors) {
    assert.equal(esNumberToString(Number(vector.value)), vector.jcs, vector.value);
  }
  assert.throws(() => esNumberToString(Number.NaN));
  assert.throws(() => esNumberToString(Number.POSITIVE_INFINITY));
});

test("RFC 8785 §3.2.3: string escaping", async (t) => {
  for (const vector of rfc.strings) {
    await t.test(vector.source, () => {
      const input = `"${vector.raw}"`;
      assert.equal(canon(input), `"${vector.jcs}"`);
    });
  }
});

test("RFC 8785 §3.2.3: object keys sort by UTF-16 code units", async (t) => {
  for (const vector of rfc.sorting) {
    await t.test(vector.name, () => {
      assert.equal(canon(vector.input), vector.jcs);
    });
  }
});

test("UTF-16 order differs from code-point order for key sorting", () => {
  // U+1F600 is D83D DE00 in UTF-16, so it sorts before U+FB33 even though its
  // code point is higher. Comparing code points would get this backwards.
  const value = parseIJson(utf8('{"\\ufb33":1,"\\ud83d\\ude00":2}'));
  assert.equal(toJcsString(value), '{"\u{1F600}":2,"\ufb33":1}');
});

test("oracle: canonical byte vectors from the pinned ijson-jcs sources", async (t) => {
  assert.equal(oracle.oracle.repo, "hyperpolymath/ijson-jcs");
  assert.match(oracle.oracle.commit, /^[0-9a-f]{40}$/);
  const groups = [
    ["canonVectors", oracle.canonVectors],
    ["acceptVectors", oracle.acceptVectors],
  ];
  for (const [group, vectors] of groups) {
    for (const vector of vectors) {
      await t.test(`${group}: ${vector.name}`, () => {
        assert.ok(vector.source, "every transcribed vector must cite its source");
        const divergence = divergences.get(`oracle/${vector.name}`);
        if (divergence) {
          assert.throws(() => canon(vector.input), (error) => error.code === divergence.code);
          return;
        }
        assert.equal(canon(vector.input), vector.jcs);
      });
    }
  }
});

test("oracle: refusal vectors from the pinned ijson-jcs sources", async (t) => {
  for (const vector of oracle.rejectVectors) {
    await t.test(vector.name, () => {
      assert.throws(
        () => canon(vector.input),
        (error) => {
          assert.equal(error.code, vector.code, error.reason);
          if (vector.path !== undefined) assert.equal(error.path, vector.path);
          return true;
        },
      );
    });
  }
});

test("oracle CLI vectors: canon bytes and exit codes", async (t) => {
  for (const vector of oracle.cliVectors.filter((entry) => entry.stdout !== undefined)) {
    await t.test(vector.name, () => {
      const bytes = toJcs(parseIJson(utf8(vector.input)));
      assert.equal(new TextDecoder().decode(bytes), vector.stdout);
      assert.equal(vector.exit, 0);
    });
  }
});

test("float closure (R3): integer-shaped floats outside ±(2^53−1) are refused", async (t) => {
  // Before contract 0.4.0 the gate, like ijson-jcs, printed 1e20 as the integer
  // token 100000000000000000000, which its own strict reader then refused.
  // Ruling R3 closes the hole at the input: such a float is refused, so
  // canon output is always valid input again.
  const refused = [
    ["1e20", ""],
    ["[18446744073709551616.0]", "0"],
    ["[1e18]", "0"],
    ['{"n":-1e18}', "n"],
    ["[9007199254740993.0]", "0"],
    ["[9007199254740992.0]", "0"],
  ];
  for (const [input, path] of refused) {
    await t.test(input, () => {
      assert.throws(
        () => canon(input),
        (error) => {
          assert.equal(error.code, "UNSAFE_FLOAT_INTEGER");
          assert.equal(error.kind, "json");
          assert.equal(error.path ?? "", path);
          return true;
        },
      );
    });
  }
  // Accepted, and reflexive: safe integer-shaped floats, exponent forms, -0.
  const accepted = [
    ["[1e15]", "[1000000000000000]"],
    ["[9007199254740991.0]", "[9007199254740991]"],
    ["[1e21]", "[1e+21]"],
    ["[1e+30]", "[1e+30]"],
    ["[-0.0]", "[0]"],
  ];
  for (const [input, expected] of accepted) {
    await t.test(input, () => {
      assert.equal(canon(input), expected);
      assert.equal(canon(expected), expected);
    });
  }
});

test("canonical output never carries a trailing newline", () => {
  const bytes = toJcs(parseIJson(utf8('{"a" : [ 1 ] }\n')));
  assert.equal(new TextDecoder().decode(bytes), '{"a":[1]}');
});
