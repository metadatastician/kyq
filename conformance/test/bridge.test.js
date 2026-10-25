// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: 2026 Jonathan D.A. Jewell (hyperpolymath) <j.d.a.jewell@open.ac.uk>
//
// The KYAML → JSON bridge φ.
//
// Besides the vector table, two cross-checks matter:
//
//   * every JSON image the bridge produces must be *valid strict I-JSON* — it is
//     fed back through the JSON front end and must canonicalise to itself;
//   * bridging must refuse, never coerce, the YAML-only shapes JSON cannot hold.

import assert from "node:assert/strict";
import { test } from "node:test";

import { bridgeDocument, bridgeStream } from "../src/bridge.js";
import { toJcsString } from "../src/jcs.js";
import { parseIJson } from "../src/json.js";
import { NODE_BUDGET, parseKyaml } from "../src/kyaml.js";
import { readCorpus, readFixture, utf8 } from "./helpers.js";

const vectors = readCorpus("bridge/vectors.json");
const cases = readCorpus("kyaml/cases.json");

/**
 * Bridge a KYAML text to canonical JSON bytes.
 *
 * @param {string} text
 * @param {{array?: boolean}} [options]
 * @returns {string}
 */
function jcs(text, options) {
  return toJcsString(bridgeStream(parseKyaml(utf8(text)), options));
}

test("bridge vectors", async (t) => {
  for (const vector of vectors.vectors) {
    await t.test(vector.name, () => {
      if (vector.error) {
        assert.throws(
          () => jcs(vector.yaml, { array: vector.array }),
          (error) => {
            assert.equal(error.code, vector.error.code, error.reason ?? error.message);
            if (vector.error.line !== undefined) assert.equal(error.line, vector.error.line);
            if (vector.error.column !== undefined) {
              assert.equal(error.column, vector.error.column);
            }
            if (vector.error.path !== undefined) {
              assert.equal(error.path ?? "", vector.error.path);
            }
            return true;
          },
        );
        return;
      }
      assert.equal(jcs(vector.yaml, { array: vector.array }), vector.jcs);
    });
  }
});

test("vector table is not vacuous", () => {
  assert.ok(vectors.vectors.length >= 20);
  assert.ok(vectors.vectors.some((vector) => vector.error));
  assert.ok(vectors.vectors.some((vector) => vector.jcs && !vector.error));
});

test("every bridged fixture produces valid strict I-JSON", async (t) => {
  for (const entry of cases.cases.filter((item) => item.expect === "valid")) {
    await t.test(entry.file, () => {
      const documents = parseKyaml(readFixture(`kyaml/${entry.file}`));
      for (const document of documents) {
        const canonical = toJcsString(bridgeDocument(document));
        // Re-reading the canonical bytes must be accepted and must be a fixed
        // point: this is the "no second canonical form" property.
        assert.equal(toJcsString(parseIJson(utf8(canonical))), canonical);
      }
    });
  }
});

test("multi-document streams need --array to become one value", () => {
  const stream = parseKyaml(utf8("a: 1\n---\nb: 2\n"));
  assert.throws(() => bridgeStream(stream), (error) => {
    assert.equal(error.code, "MULTI_DOC_STREAM");
    return true;
  });
  assert.equal(
    toJcsString(bridgeStream(stream, { array: true })),
    '[{"a":1},{"b":2}]',
  );
});

test("an empty stream has no JSON image", () => {
  assert.throws(() => bridgeStream([]), (error) => {
    assert.equal(error.code, "EMPTY_STREAM");
    return true;
  });
});

test("a single null document bridges to null", () => {
  const documents = parseKyaml(utf8("---\n...\n"));
  assert.equal(documents.length, 1);
  assert.equal(toJcsString(bridgeStream(documents)), "null");
});

test("integers are checked in BigInt before any double conversion", () => {
  // 2^53 is exactly representable as a double but outside the I-JSON safe
  // range, so the bridge must refuse it rather than round it.
  assert.throws(() => jcs("a: 9007199254740992\n"), (error) => {
    assert.equal(error.code, "UNSAFE_INTEGER");
    assert.equal(error.path, "a");
    return true;
  });
  assert.equal(jcs("a: 9007199254740991\n"), '{"a":9007199254740991}');
  assert.equal(jcs("a: -9007199254740991\n"), '{"a":-9007199254740991}');
  assert.equal(jcs("a: 0x1f\n"), '{"a":31}');
  assert.equal(jcs("a: 0o17\n"), '{"a":15}');
});

test("float tokens outside the safe range are legal I-JSON", () => {
  // The token, not the value, decides: 1e18 as a float is accepted, while the
  // integer token 1000000000000000000 is refused. This mirrors ijson-jcs.
  assert.equal(jcs("a: 1e18\n"), '{"a":1000000000000000000}');
  assert.throws(() => jcs("a: 1000000000000000000\n"), (error) => {
    assert.equal(error.code, "UNSAFE_INTEGER");
    return true;
  });
});

test("anchor expansion is bounded", () => {
  const wide = `a: &a\n${Array.from({ length: 1000 }, (_, index) => `  - ${index}`).join("\n")}\n`;
  const bomb = `${wide}b: &b\n${Array.from({ length: 200 }, () => "  - *a").join("\n")}\n`;
  assert.throws(
    () => {
      const documents = parseKyaml(utf8(bomb));
      for (const document of documents) bridgeDocument(document);
    },
    (error) => {
      assert.equal(error.code, "NODE_BUDGET_EXCEEDED");
      assert.match(error.message, new RegExp(String(NODE_BUDGET)));
      return true;
    },
  );
});

test("bridge paths follow mapping keys and sequence indices", () => {
  assert.throws(
    () =>
      jcs(
        "spec:\n  containers:\n    - name: a\n      uid: 9007199254740993\n",
      ),
    (error) => {
      assert.equal(error.code, "UNSAFE_INTEGER");
      assert.equal(error.path, "spec/containers/0/uid");
      return true;
    },
  );
});

test("a non-string key is reported at the key, with the mapping's path", () => {
  assert.throws(
    () => jcs("spec:\n  1: one\n"),
    (error) => {
      assert.equal(error.code, "NON_STRING_KEY");
      assert.equal(error.path, "spec");
      assert.equal(error.line, 2);
      assert.equal(error.column, 3);
      return true;
    },
  );
});

test("JSON Pointer escaping in bridge paths", () => {
  assert.throws(
    () => jcs('"a/b":\n  "c~d": [1, 9007199254740993]\n'),
    (error) => {
      assert.equal(error.path, "a~1b/c~0d/1");
      return true;
    },
  );
});
