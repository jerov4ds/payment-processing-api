import { mulberry32 } from "../../../src/services/random";

describe("mulberry32", () => {
  it("returns a repeatable sequence in [0, 1)", () => {
    const left = mulberry32(42);
    const right = mulberry32(42);
    const values = [left(), left(), left()];
    expect(values).toEqual([right(), right(), right()]);
    expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
    expect(new Set(values).size).toBeGreaterThan(1);
  });

  it("truncates a fractional seed and changes the sequence when the seed changes", () => {
    expect(mulberry32(1.9)()).toBe(mulberry32(1)());
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
    expect(mulberry32(-1)()).toBeGreaterThanOrEqual(0);
    expect(mulberry32(-1)()).toBeLessThan(1);
  });
});
