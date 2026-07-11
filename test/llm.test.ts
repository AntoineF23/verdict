import { describe, it, expect } from "vitest";
import { llmComplete, PRESETS } from "../src/llm";
import type { LlmConfig } from "../src/types";

interface Captured {
  url: string;
  options: RequestInit;
}

/** Build a fake fetch returning a fixed JSON body and record what it was called with. */
function fakeFetch(json: unknown, calls: Captured[]): typeof fetch {
  return (async (url: string, options: RequestInit) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => json,
      text: async () => JSON.stringify(json),
    } as Response;
  }) as unknown as typeof fetch;
}

/** Build a fake fetch that returns a non-2xx error response. */
function errorFetch(status: number, body: unknown): typeof fetch {
  return (async () => {
    return {
      ok: false,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  }) as unknown as typeof fetch;
}

function bodyOf(calls: Captured[]): any {
  return JSON.parse(calls[0].options.body as string);
}

function headersOf(calls: Captured[]): Record<string, string> {
  return calls[0].options.headers as Record<string, string>;
}

describe("llmComplete — anthropic", () => {
  it("hits the messages endpoint, sends the right headers, and returns text", async () => {
    const calls: Captured[] = [];
    const cfg: LlmConfig = { provider: "anthropic", model: "claude-opus-4-8", apiKey: "sk-ant-123" };
    const fetchImpl = fakeFetch(
      { content: [{ type: "text", text: "Hello " }, { type: "text", text: "world" }] },
      calls,
    );

    const out = await llmComplete(cfg, { system: "be terse", prompt: "hi" }, fetchImpl);

    expect(out).toBe("Hello world");
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    const headers = headersOf(calls);
    expect(headers["x-api-key"]).toBe("sk-ant-123");
    expect(headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const body = bodyOf(calls);
    expect(body.model).toBe("claude-opus-4-8");
    expect(body.system).toBe("be terse");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(body.max_tokens).toBe(4096);
    // temperature is omitted unless explicitly set (thinking-enabled models reject non-1 values)
    expect("temperature" in body).toBe(false);
  });

  it("honors maxTokens and temperature overrides", async () => {
    const calls: Captured[] = [];
    const cfg: LlmConfig = { provider: "anthropic", model: "claude-sonnet-5", apiKey: "k" };
    const fetchImpl = fakeFetch({ content: [{ type: "text", text: "ok" }] }, calls);

    await llmComplete(cfg, { prompt: "x", maxTokens: 42, temperature: 0.7 }, fetchImpl);

    const body = bodyOf(calls);
    expect(body.max_tokens).toBe(42);
    expect(body.temperature).toBe(0.7);
  });

  it("uses cfg.maxTokens when the request omits one", async () => {
    const calls: Captured[] = [];
    const cfg: LlmConfig = { provider: "anthropic", model: "claude-opus-4-8", apiKey: "k", maxTokens: 12000 };
    const fetchImpl = fakeFetch({ content: [{ type: "text", text: "ok" }] }, calls);
    await llmComplete(cfg, { prompt: "x" }, fetchImpl);
    expect(bodyOf(calls).max_tokens).toBe(12000);
  });
});

describe("llmComplete — openai", () => {
  it("hits the default base URL, sends bearer auth, system+user messages, returns content", async () => {
    const calls: Captured[] = [];
    const cfg: LlmConfig = { provider: "openai", model: "gpt-4o", apiKey: "sk-oai-9" };
    const fetchImpl = fakeFetch({ choices: [{ message: { content: "the answer" } }] }, calls);

    const out = await llmComplete(cfg, { system: "sys", prompt: "usr" }, fetchImpl);

    expect(out).toBe("the answer");
    expect(calls[0].url).toBe(`${PRESETS.openai.defaultBaseUrl}/chat/completions`);
    const headers = headersOf(calls);
    expect(headers.authorization).toBe("Bearer sk-oai-9");
    const body = bodyOf(calls);
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "usr" },
    ]);
  });

  it("omits the system message when none is provided", async () => {
    const calls: Captured[] = [];
    const cfg: LlmConfig = { provider: "openai", model: "gpt-4o", apiKey: "k" };
    const fetchImpl = fakeFetch({ choices: [{ message: { content: "hi" } }] }, calls);

    await llmComplete(cfg, { prompt: "just user" }, fetchImpl);

    expect(bodyOf(calls).messages).toEqual([{ role: "user", content: "just user" }]);
  });
});

describe("llmComplete — custom", () => {
  it("uses the provided baseUrl", async () => {
    const calls: Captured[] = [];
    const cfg: LlmConfig = {
      provider: "custom",
      model: "local-model",
      apiKey: "k",
      baseUrl: "http://localhost:1234/v1",
    };
    const fetchImpl = fakeFetch({ choices: [{ message: { content: "local" } }] }, calls);

    const out = await llmComplete(cfg, { prompt: "p" }, fetchImpl);

    expect(out).toBe("local");
    expect(calls[0].url).toBe("http://localhost:1234/v1/chat/completions");
  });
});

describe("llmComplete — errors", () => {
  it("throws with the HTTP status and provider message on non-2xx", async () => {
    const cfg: LlmConfig = { provider: "openai", model: "gpt-4o", apiKey: "k" };
    const fetchImpl = errorFetch(401, { error: { message: "invalid api key" } });

    await expect(llmComplete(cfg, { prompt: "p" }, fetchImpl)).rejects.toThrow(/401/);
    await expect(llmComplete(cfg, { prompt: "p" }, fetchImpl)).rejects.toThrow(/invalid api key/);
  });

  it("rethrows network failures with context", async () => {
    const cfg: LlmConfig = { provider: "anthropic", model: "claude-opus-4-8", apiKey: "k" };
    const boom = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;

    await expect(llmComplete(cfg, { prompt: "p" }, boom)).rejects.toThrow(/Network error/);
  });
});

describe("llmComplete — validation", () => {
  it("throws when the API key is empty", async () => {
    const cfg: LlmConfig = { provider: "anthropic", model: "claude-opus-4-8", apiKey: "" };
    await expect(llmComplete(cfg, { prompt: "p" })).rejects.toThrow(/API key/);
  });

  it("throws when a custom provider has no baseUrl", async () => {
    const cfg: LlmConfig = { provider: "custom", model: "m", apiKey: "k" };
    await expect(llmComplete(cfg, { prompt: "p" })).rejects.toThrow(/baseUrl/);
  });
});

describe("PRESETS", () => {
  it("defaults Anthropic to the latest Opus model", () => {
    expect(PRESETS.anthropic.defaultModel).toBe("claude-opus-4-8");
    expect(PRESETS.anthropic.models).toContain("claude-sonnet-5");
    expect(PRESETS.anthropic.models).toContain("claude-haiku-4-5-20251001");
  });
});
