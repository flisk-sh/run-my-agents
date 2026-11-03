import { describe, it, expect } from "bun:test";
import { unique } from "../src/math";

describe("unique", () => {
  it("preserves first-seen order", () => {
    expect(unique([3, 1, 3, 2, 1])).toEqual([3, 1, 2]);
  });

  it("handles empty and no-duplicate lists", () => {
    expect(unique([])).toEqual([]);
    expect(unique([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it("does not mutate input and returns new array", () => {
    const input = [1, 2, 2, 3];
    const result = unique(input);
    expect(result).toEqual([1, 2, 3]);
    expect(result).not.toBe(input);
  });

  it("dedupes NaN and treats 0 and -0 as same value", () => {
    expect(unique([0, -0, NaN, NaN, 5])).toEqual([0, NaN, 5]);
  });
});
