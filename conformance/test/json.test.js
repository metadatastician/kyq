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

import { parseIJson } from "../src/json.js";
import { toJcs, toJcsString, esNumberToString } from "../src/jcs.js";
import { fromHex, readCorpus, utf8 } from "./helpers.js";

const ijson = readCorpus("ijson/vectors.json");
const rfc = readCorpus("rfc8785/vectors.json");
const oracle = readCorpus("oracle/ijson-jcs.json");

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
      // Canonical bytes must be a fixed point: parsing and re-canonicalising
      // the output yields the same bytes — except where the canonical text of a
      // float is an integer token beyond ±(2^53−1); `reflexive: false` marks
      // those and the dedicated test below pins the behaviour.
      if (vector.reflexive !== false) {
        assert.equal(canon(vector.jcs), vector.jcs);
      }
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
  for (const vector of rfc.numbers) {
    await t.test(vector.token, () => {
      assert.equal(canon(vector.token), vector.jcs);
      // A number inside a container uses the same text.
      assert.equal(canon(`[${vector.token}]`), `[${vector.jcs}]`);
    });
  }
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
        assert.equal(canon(vector.input), vector.jcs);
        assert.ok(vector.source, "every transcribed vector must cite its source");
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

test("known upstream interaction: JCS text of a large float is not strict input", async (t) => {
  // JCS prints 1e20 as 100000000000000000000 (no exponent, per ES rules), which
  // strict I-JSON parsing refuses because it is an integer token outside
  // ±(2^53−1). `ijson-jcs` behaves identically (`canon` succeeds, re-parsing the
  // result does not), so byte equality is preserved and the difference is
  // documented rather than silently "fixed" by inventing a second form.
  const cases = [
    { input: "1e20", jcs: "100000000000000000000" },
    { input: "[18446744073709551616.0]", jcs: "[18446744073709552000]" },
  ];
  for (const vector of cases) {
    await t.test(vector.input, () => {
      assert.equal(canon(vector.input), vector.jcs);
      assert.throws(
        () => canon(vector.jcs),
        (error) => {
          assert.equal(error.code, "UNSAFE_INTEGER");
          return true;
        },
      );
    });
  }
  // The escape hatch is real: a float token with an exponent stays reflexive.
  assert.equal(canon("1e+30"), "1e+30");
});

test("canonical output never carries a trailing newline", () => {
  const bytes = toJcs(parseIJson(utf8('{"a" : [ 1 ] }\n')));
  assert.equal(new TextDecoder().decode(bytes), '{"a":[1]}');
});
