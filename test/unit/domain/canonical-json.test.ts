import {
  canonicalJson,
  sha256Canonical,
} from "../../../src/domain/canonical-json";

describe("canonical json", () => {
  it("sorts object keys and ignores key order in the hash", () => {
    const left = { b: 1, a: { d: true, c: "x" } };
    const right = { a: { c: "x", d: true }, b: 1 };
    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(sha256Canonical(left)).toBe(sha256Canonical(right));
    expect(sha256Canonical({ a: 1 })).not.toBe(sha256Canonical({ a: 2 }));
    expect(canonicalJson([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });
});
