import { describe, it, expect } from "vitest";
import { codeStats, buildAxialPrompt, parseAxialResult, convCategories, categoryCounts } from "../src/coding";
import type { Axial } from "../src/types";

const fails = [
  { comment: "invented a stock price after timeout", codes: ["hallucinated data"] },
  { comment: "claimed booking succeeded but tool errored", codes: ["ignored tool error", "overconfident"] },
  { comment: "gave chicken to a vegetarian", codes: ["ignored constraint"] },
  { comment: "made up a citation", codes: ["hallucinated data"] },
];

describe("open coding — codeStats", () => {
  it("aggregates distinct codes with counts and comments, sorted by frequency", () => {
    const stats = codeStats(fails);
    expect(stats[0]).toMatchObject({ code: "hallucinated data", count: 2 });
    expect(stats[0].comments).toContain("invented a stock price after timeout");
    expect(stats.map((s) => s.code)).toContain("ignored constraint");
    expect(stats).toHaveLength(4);
  });
});

describe("axial prompt", () => {
  it("includes frequencies and example comments", () => {
    const p = buildAxialPrompt(codeStats(fails));
    expect(p).toMatch(/"hallucinated data" \(x2\)/);
    expect(p).toMatch(/invented a stock price/);
    expect(p).toMatch(/"categories"/); // schema instruction present
  });
});

describe("parseAxialResult", () => {
  it("parses a categories object", () => {
    const cats = parseAxialResult('{"categories":[{"name":"A","description":"d","codes":["x"]}]}');
    expect(cats).toHaveLength(1);
    expect(cats[0].name).toBe("A");
  });
  it("tolerates markdown fences and a bare array", () => {
    expect(parseAxialResult('```json\n[{"name":"A","codes":["x"]}]\n```')).toHaveLength(1);
  });
  it("throws friendly errors on bad input", () => {
    expect(() => parseAxialResult("not json")).toThrow(/Invalid JSON/);
    expect(() => parseAxialResult('{"foo":1}')).toThrow(/categories/);
    expect(() => parseAxialResult('{"categories":[]}')).toThrow(/No valid categories/);
  });
});

describe("map-back + roll-up", () => {
  const axial: Axial = {
    generatedAt: "2026-01-01T00:00:00Z",
    categories: [
      { name: "Fabrication", description: "", codes: ["hallucinated data"] },
      { name: "Tool mishandling", description: "", codes: ["ignored tool error", "overconfident"] },
      { name: "Instruction following", description: "", codes: ["ignored constraint"] },
    ],
  };

  it("maps a conversation's codes to its categories", () => {
    expect(convCategories(["hallucinated data"], axial)).toEqual(["Fabrication"]);
    expect(convCategories(["ignored tool error", "overconfident"], axial)).toEqual(["Tool mishandling"]);
    expect(convCategories(["unknown code"], axial)).toEqual([]);
  });

  it("rolls up conversation counts per category", () => {
    const counts = categoryCounts(fails, axial);
    expect(counts["Fabrication"].convs).toBe(2); // two fails share 'hallucinated data'
    expect(counts["Tool mishandling"].convs).toBe(1);
    expect(counts["Instruction following"].convs).toBe(1);
  });

  it("is case-insensitive on code matching", () => {
    expect(convCategories(["  Hallucinated Data "], axial)).toEqual(["Fabrication"]);
  });
});
