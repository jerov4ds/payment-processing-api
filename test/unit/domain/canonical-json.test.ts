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

  it("keeps array order and treats null, holes, and missing keys as distinct", () => {
    expect(canonicalJson([1, { b: 1, a: 2 }, null, "x"])).toBe(
      '[1,{"a":2,"b":1},null,"x"]',
    );
    expect(sha256Canonical([1, 2])).not.toBe(sha256Canonical([2, 1]));
    expect(canonicalJson([undefined])).toBe("[null]");
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJson({ z: true, m: null, a: [3, { d: 1, c: 2 }] })).toBe(
      '{"a":[3,{"c":2,"d":1}],"m":null,"z":true}',
    );
    expect(sha256Canonical({})).not.toBe(sha256Canonical([]));
    expect(sha256Canonical({ n: 1 })).not.toBe(sha256Canonical({ n: "1" }));
  });
});
