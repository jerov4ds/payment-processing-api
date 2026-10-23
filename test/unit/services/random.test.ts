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
});
