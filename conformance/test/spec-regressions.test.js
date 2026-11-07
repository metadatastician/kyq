// SPDX-License-Identifier: MPL-2.0
// Normative examples and mutations, independent of the Hypatia implementation.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseKyaml } from "../src/kyaml.js";
import { bridgeStream } from "../src/bridge.js";
import { toJcsString } from "../src/jcs.js";

const parse = (text) => parseKyaml(new TextEncoder().encode(text));
const json = (text) => toJcsString(bridgeStream(parse(text)));

test("one stream-leading BOM has zero display width; another is refused", () => {
  assert.equal(json("\uFEFFa: 1\n"), '{"a":1}');
  assert.throws(() => parse("\uFEFFa: 😀\uFEFF"),
    { code: "BOM_MIDSTREAM", line: 1, column: 5 });
  assert.throws(() => parse("\uFEFF\uFEFFa: 1"),
    { code: "BOM_MIDSTREAM", line: 1, column: 1 });
});

test("whole-stream diagnostics count Unicode code points, excluding the BOM", () => {
  for (const prefix of ["", "\uFEFF"]) {
    assert.throws(() => parse(`${prefix}a: 😀\rb`),
      { code: "INVALID_NEWLINE", line: 1, column: 5 });
    assert.throws(() => parse(`${prefix}a: 😀\u0001`),
      { code: "CONTROL_CHARACTER", line: 1, column: 5 });
  }
});

test("block header comments consume exactly the header newline", () => {
  for (const newline of ["\n", "\r\n"]) {
    assert.equal(json(`a: | # comment${newline}  one${newline}  two${newline}`),
      '{"a":"one\\ntwo\\n"}');
    assert.equal(json(`a: >- # comment${newline}  one${newline}  two${newline}`),
      '{"a":"one two"}');
  }
});

test("flow trailing commas are legal; empty entries are not", () => {
  assert.equal(json("{ports: [80, 443,], enabled: true,}"),
    '{"enabled":true,"ports":[80,443]}');
  for (const text of ["[,]", "[1,,2]"]) {
    assert.throws(() => parse(text), { code: "EMPTY_VALUE" });
  }
  for (const text of ["{,}", "{a: 1,,}"]) {
    assert.throws(() => parse(text), { code: "EMPTY_KEY" });
  }
});

test("YAML 1.2 c-printable exclusions fail in every lexical context", () => {
  const excluded = Array.from({ length: 160 }, (_, point) => point)
    .filter((point) => (point < 32 && ![9, 10, 13].includes(point)) ||
      (point >= 127 && point !== 133));
  const templates = ["a: before~after\n", "a: 'before~after'\n",
    "a: |\n  before~after\n", "a: >\n  before~after\n", "# before~after\na: 1\n",
    "a~b: 1\n", "a: &before~after 1\n", "%YAML 1.2 # ~\n---\na: 1\n"];
  for (const point of excluded) {
    for (const template of templates) {
      assert.throws(() => parse(template.replace("~", String.fromCodePoint(point))),
        { code: "CONTROL_CHARACTER" }, `${point} in ${template}`);
    }
  }
});

test("printable boundary characters and escaped controls remain valid", () => {
  for (const point of [32, 126, 160, 255, 0xd7ff, 0xe000, 0xfffd, 0x10000]) {
    assert.doesNotThrow(() => json(`a: 'before${String.fromCodePoint(point)}after'\n`));
  }
  assert.equal(json('a: "escaped\\u0001"\n'), '{"a":"escaped\\u0001"}');
});
