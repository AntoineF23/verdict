import { describe, it, expect } from "vitest";
import {
  DEFAULT_JUDGE_TEMPLATE,
  buildJudgePrompt,
  parseJudgeVerdict,
  renderConversationForJudge,
  runJudgeOverSet,
  exportJudge,
  newJudgeForCategory,
} from "../src/judge";
import type { Conversation, Judge, Category, LlmConfig, Metrics } from "../src/types";

const cfg: LlmConfig = { provider: "anthropic", model: "claude-opus-4-8", apiKey: "k" };

describe("buildJudgePrompt", () => {
  it("substitutes all placeholders", () => {
    const p = buildJudgePrompt(DEFAULT_JUDGE_TEMPLATE, { name: "Fabrication", description: "invented facts" }, "USER: hi");
    expect(p).toContain("Fabrication");
    expect(p).toContain("invented facts");
    expect(p).toContain("USER: hi");
    expect(p).not.toMatch(/\{category\}|\{description\}|\{conversation\}/);
  });

  it("replaces every occurrence", () => {
    const p = buildJudgePrompt("{category} then {category}", { name: "X" }, "");
    expect(p).toBe("X then X");
  });
});

describe("parseJudgeVerdict", () => {
  it("parses plain JSON label true", () => {
    expect(parseJudgeVerdict('{"label":true,"rationale":"r"}')).toEqual({ label: true, rationale: "r" });
  });
  it("parses fenced json", () => {
    expect(parseJudgeVerdict('```json\n{"label": false}\n```').label).toBe(false);
  });
  it("parses JSON with surrounding prose", () => {
    expect(parseJudgeVerdict('Here is my verdict:\n{"label": true}\nThanks!').label).toBe(true);
  });
  it('handles "Answer: no"', () => {
    expect(parseJudgeVerdict("Answer: no").label).toBe(false);
  });
  it('handles "label: false" with prose', () => {
    expect(parseJudgeVerdict("After review, label: false because it is fine.").label).toBe(false);
  });
  it("handles yes/no words", () => {
    expect(parseJudgeVerdict("Yes, it clearly does.").label).toBe(true);
    expect(parseJudgeVerdict("No.").label).toBe(false);
  });
  it("accepts string label yes/no", () => {
    expect(parseJudgeVerdict('{"label":"yes"}').label).toBe(true);
  });
  it("throws when indeterminate", () => {
    expect(() => parseJudgeVerdict("hmm, unclear")).toThrow();
  });
});

describe("renderConversationForJudge", () => {
  const conv: Conversation = {
    id: "c1",
    startNs: 0,
    meta: {},
    steps: [
      { kind: "message", role: "user", text: "book me a flight" },
      { kind: "tool_call", toolName: "search_flights", toolInput: { to: "NYC" }, toolOutput: { error: "timeout" } },
      { kind: "message", role: "assistant", text: "Booked!" },
    ],
  };

  it("includes roles and tool names", () => {
    const t = renderConversationForJudge(conv);
    expect(t).toContain("user: book me a flight");
    expect(t).toContain("TOOL search_flights");
    expect(t).toContain("assistant: Booked!");
  });

  it("respects maxChars", () => {
    const t = renderConversationForJudge(conv, 20);
    expect(t.length).toBeLessThanOrEqual(20 + "\n…[truncated]".length);
    expect(t).toContain("truncated");
  });
});

describe("runJudgeOverSet", () => {
  const items = [
    { id: "a", convText: "ta" },
    { id: "b", convText: "tb" },
    { id: "c", convText: "tc" },
  ];

  it("returns results in input order using a fake complete", async () => {
    const complete = async (_c: LlmConfig, req: { prompt: string }) => {
      // canned per item: 'a' true, others false
      const label = req.prompt.includes("ta");
      return JSON.stringify({ label });
    };
    const res = await runJudgeOverSet({ cfg, template: "{conversation}", category: { name: "X" }, items, complete });
    expect(res.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(res[0].label).toBe(true);
    expect(res[1].label).toBe(false);
  });

  it("captures a per-item error without aborting the batch", async () => {
    const complete = async (_c: LlmConfig, req: { prompt: string }) => {
      if (req.prompt.includes("tb")) throw new Error("boom");
      return '{"label":true}';
    };
    const res = await runJudgeOverSet({ cfg, template: "{conversation}", category: { name: "X" }, items, complete });
    expect(res[0].label).toBe(true);
    expect(res[1].error).toBe("boom");
    expect(res[1].label).toBe(false);
    expect(res[2].label).toBe(true);
  });

  it("reports progress for every item", async () => {
    const complete = async () => '{"label":false}';
    const seen: number[] = [];
    await runJudgeOverSet({
      cfg,
      template: "{conversation}",
      category: { name: "X" },
      items,
      complete,
      concurrency: 2,
      onProgress: (done, total) => {
        expect(total).toBe(3);
        seen.push(done);
      },
    });
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });
});

describe("exportJudge / newJudgeForCategory", () => {
  const category: Category = { name: "Fabrication", description: "invents facts", codes: ["hallucinated"] };
  const metrics: Metrics = {
    tp: 1, fp: 0, tn: 1, fn: 0,
    tpr: 1, tnr: 1, precision: 1, f1: 1, accuracy: 1, kappa: 1,
    support: { positives: 1, negatives: 1, total: 2 },
  };

  it("creates a judge with one v1 version and no dates", () => {
    const judge = newJudgeForCategory(category, "anthropic", "claude-opus-4-8", "seed-1");
    expect(judge.category).toBe("Fabrication");
    expect(judge.versions).toHaveLength(1);
    expect(judge.versions[0]).toMatchObject({ id: "seed-1", label: "v1", model: "claude-opus-4-8", createdAt: "" });
    expect(judge.activeVersionId).toBe("seed-1");
    expect(judge.versions[0].template).toBe(DEFAULT_JUDGE_TEMPLATE);
  });

  it("exports the active version's model/template/metrics", () => {
    const judge = newJudgeForCategory(category, "anthropic", "claude-opus-4-8", "seed-1");
    judge.versions[0].metrics = metrics;
    const { json, promptText } = exportJudge(judge, category);
    expect(json).toMatchObject({
      category: "Fabrication",
      description: "invents facts",
      provider: "anthropic",
      model: "claude-opus-4-8",
      template: DEFAULT_JUDGE_TEMPLATE,
      metrics,
      exportedAt: null,
    });
    expect(promptText).toContain("Fabrication");
    expect(promptText).toContain("{conversation}"); // left for production caller
    expect(promptText).not.toContain("{category}");
  });

  it("throws when there is no active version", () => {
    const judge: Judge = { category: "X", versions: [], activeVersionId: null };
    expect(() => exportJudge(judge, category)).toThrow(/active/i);
  });
});
