import { describe, it, expect } from "vitest";
import { confusion, rates, metricsFromPairs, splitStratified } from "../src/metrics";

describe("confusion", () => {
  it("counts tp/fp/fn/tn on a known vector", () => {
    const pairs = [
      { human: true, llm: true }, // tp
      { human: true, llm: true }, // tp
      { human: false, llm: true }, // fp
      { human: true, llm: false }, // fn
      { human: false, llm: false }, // tn
      { human: false, llm: false }, // tn
    ];
    expect(confusion(pairs)).toEqual({ tp: 2, fp: 1, fn: 1, tn: 2 });
  });
});

describe("rates", () => {
  it("computes rates + kappa on a hand-computed example (tp=5,fp=1,tn=8,fn=2)", () => {
    const m = rates({ tp: 5, fp: 1, tn: 8, fn: 2 });
    expect(m.tpr).toBeCloseTo(0.714, 3); // 5/7
    expect(m.tnr).toBeCloseTo(0.889, 3); // 8/9
    expect(m.precision).toBeCloseTo(0.833, 3); // 5/6
    expect(m.f1).toBeCloseTo(0.769, 3); // 10/13
    expect(m.accuracy).toBeCloseTo(0.8125, 4); // 13/16
    expect(m.kappa).toBeCloseTo(0.613, 3); // (0.8125-0.515625)/(1-0.515625)
    expect(m.support).toEqual({ positives: 7, negatives: 9, total: 16 });
  });

  it("guards divide-by-zero: all-zero returns 0 not NaN", () => {
    const m = rates({ tp: 0, fp: 0, tn: 0, fn: 0 });
    for (const k of ["tpr", "tnr", "precision", "f1", "accuracy", "kappa"] as const) {
      expect(m[k]).toBe(0);
      expect(Number.isNaN(m[k])).toBe(false);
    }
  });

  it("guards divide-by-zero: all-negative agreement returns 0 not NaN", () => {
    // Human all false, LLM all false → perfect but no positives; precision/tpr undefined → 0.
    const m = metricsFromPairs([
      { human: false, llm: false },
      { human: false, llm: false },
      { human: false, llm: false },
    ]);
    expect(m.accuracy).toBe(1);
    expect(m.precision).toBe(0);
    expect(m.tpr).toBe(0);
    expect(m.f1).toBe(0);
    expect(Number.isNaN(m.kappa)).toBe(false);
  });
});

describe("splitStratified", () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ i, pos: i < 8 }));
  const isPos = (t: { pos: boolean }) => t.pos;

  it("is deterministic for a given seed", () => {
    const a = splitStratified(items, isPos, 0.25, 42);
    const b = splitStratified(items, isPos, 0.25, 42);
    expect(a.test.map((x) => x.i)).toEqual(b.test.map((x) => x.i));
    expect(a.train.map((x) => x.i)).toEqual(b.train.map((x) => x.i));
  });

  it("different seeds generally differ", () => {
    const a = splitStratified(items, isPos, 0.25, 1);
    const b = splitStratified(items, isPos, 0.25, 999);
    expect(a.test.map((x) => x.i)).not.toEqual(b.test.map((x) => x.i));
  });

  it("preserves counts (train + test = all)", () => {
    const { train, test } = splitStratified(items, isPos, 0.25, 7);
    expect(train.length + test.length).toBe(items.length);
    const seen = new Set([...train, ...test].map((x) => x.i));
    expect(seen.size).toBe(items.length);
  });

  it("keeps per-stratum test sizes = round(n*ratio)", () => {
    // 8 positives, 12 negatives, ratio 0.25 → 2 positive + 3 negative in test.
    const { test } = splitStratified(items, isPos, 0.25, 7);
    const posInTest = test.filter((x) => x.pos).length;
    const negInTest = test.filter((x) => !x.pos).length;
    expect(posInTest).toBe(2);
    expect(negInTest).toBe(3);
  });
});
