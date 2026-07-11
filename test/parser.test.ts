import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseText, detectAndNormalize } from "../src/parser";
import type { Conversation, Step } from "../src/types";

const here = dirname(fileURLToPath(import.meta.url));
const load = (rel: string) => detectAndNormalize(parseText(readFileSync(join(here, "..", rel), "utf8")));
const toolSteps = (c: Conversation) => c.steps.filter((s: Step) => s.kind === "tool_call");

describe("format-agnostic parser", () => {
  it("OTLP export: groups by trace, extracts messages, tools, tokens; no history duplication", () => {
    const r = load("fixtures/otlp.json");
    expect(r.format).toMatch(/OTLP/);
    expect(r.conversations).toHaveLength(1);
    const c = r.conversations[0];
    expect(c.meta.model).toBe("gpt-4o");
    expect(c.meta.tokens).toEqual({ in: 42, out: 12 });
    expect(c.steps.some((s) => s.role === "user" && /Paris/.test(s.text!))).toBe(true);
    expect(toolSteps(c).some((s) => s.toolName === "get_weather" && /sunny/.test(String(s.toolOutput)))).toBe(true);
    expect(c.steps.filter((s) => s.role === "user")).toHaveLength(1); // dedup across prompt windows
  });

  it("OpenInference span array: two traces, tool call with output", () => {
    const r = load("fixtures/openinference.json");
    expect(r.format).toMatch(/OpenInference|span/);
    expect(r.conversations).toHaveLength(2);
    const c = r.conversations.find((x) => x.id === "trace-bbb")!;
    expect(c.meta.model).toBe("claude-opus-4-8");
    expect(toolSteps(c).some((s) => s.toolName === "list_files" && /README/.test(String(s.toolOutput)))).toBe(true);
  });

  it("plain [{role,content}] conversation with a tool call + result merged into one step", () => {
    const r = load("fixtures/plain.json");
    expect(r.format).toMatch(/conversation/);
    expect(r.conversations).toHaveLength(1);
    const c = r.conversations[0];
    for (const role of ["system", "user", "assistant"]) {
      expect(c.steps.some((s) => s.role === role)).toBe(true);
    }
    const lookup = toolSteps(c).find((s) => s.toolName === "lookup_order");
    expect(lookup).toBeTruthy();
    expect(/in_transit/.test(String(lookup!.toolOutput))).toBe(true);
  });

  it("unknown/custom shape still parses into gradable conversations (fallback)", () => {
    const r = load("fixtures/weird.json");
    expect(r.format).toMatch(/fallback/);
    expect(r.conversations).toHaveLength(2);
    // messages recovered from a non-standard 'events' container
    expect(r.conversations[1].steps.some((s) => /fallback still let me grade/.test(String(s.text)))).toBe(true);
  });

  it("dense generated sample: all tool calls carry both input and output", () => {
    const r = load("test-files/02-openinference-spans.json");
    expect(r.conversations.length).toBeGreaterThan(5);
    const missingOutput = r.conversations.flatMap(toolSteps).filter((s) => s.toolOutput === undefined || s.toolOutput === "");
    expect(missingOutput).toHaveLength(0);
  });

  it("parses the new OTel GenAI convention (gen_ai.input.messages with typed parts)", () => {
    const r = load("fixtures/genai-v2-messages.json");
    expect(r.conversations).toHaveLength(1);
    const c = r.conversations[0];
    expect(c.meta.model).toBe("gpt-4o");
    // user text extracted from a text part
    expect(c.steps.some((s) => s.role === "user" && /Weather in Paris/.test(s.text!))).toBe(true);
    // tool_call part -> a tool step, tool_call_response part fills its output
    const tool = toolSteps(c).find((s) => s.toolName === "get_weather");
    expect(tool).toBeTruthy();
    expect(JSON.stringify(tool!.toolInput)).toMatch(/Paris/);
    expect(JSON.stringify(tool!.toolOutput)).toMatch(/rainy/);
    // final assistant text from output messages
    expect(c.steps.some((s) => s.role === "assistant" && /rainy and 57/.test(s.text!))).toBe(true);
    // history repeated across spans is de-duplicated
    expect(c.steps.filter((s) => s.role === "user")).toHaveLength(1);
  });

  it("parseText accepts NDJSON", () => {
    const data = parseText('{"a":1}\n{"a":2}\n');
    expect(Array.isArray(data)).toBe(true);
    expect(data).toHaveLength(2);
  });
});
