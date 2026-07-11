// Configurable, client-side LLM client for the LLM grader.
//
// SECURITY CAVEAT: This app runs entirely in the browser and talks to provider
// APIs directly. The API key is held in memory and (optionally) persisted to
// localStorage on the reviewer's own machine. This is ONLY appropriate for a
// reviewer running the tool locally with their OWN key. Never host this
// publicly with a shared key — the key would be exposed to every visitor.

import type { LlmConfig, LlmProvider, LlmRequest } from "./types";

export interface ProviderPreset {
  label: string;
  defaultModel: string;
  models: string[];
  defaultBaseUrl?: string;
}

/**
 * Known providers and their default/available models. The app defaults to the
 * latest Claude models (Claude 5 family, Opus 4.8, Haiku 4.5).
 */
export const PRESETS: Record<LlmProvider, ProviderPreset> = {
  anthropic: {
    label: "Anthropic (Claude)",
    defaultModel: "claude-opus-4-8",
    models: ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5-20251001"],
  },
  openai: {
    label: "OpenAI",
    defaultModel: "gpt-4o",
    models: ["gpt-4o", "gpt-4o-mini", "o3-mini"],
    defaultBaseUrl: "https://api.openai.com/v1",
  },
  custom: {
    label: "Custom (OpenAI-compatible)",
    defaultModel: "",
    models: [],
  },
};

const STORAGE_KEY = "llm-grader-llm-config-v1";

/** Pull a human-readable error message out of a provider error body. */
function extractErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const err = (body as { error?: unknown }).error;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === "string") return msg;
  }
  const message = (body as { message?: unknown }).message;
  if (typeof message === "string") return message;
  return null;
}

/** Build a helpful Error for a non-2xx HTTP response, parsing the body defensively. */
async function responseError(res: Response): Promise<Error> {
  let detail: string | null = null;
  try {
    const text = await res.text();
    if (text) {
      try {
        detail = extractErrorMessage(JSON.parse(text));
      } catch {
        detail = text;
      }
    }
  } catch {
    // ignore body read failures
  }
  const base = `LLM request failed with HTTP ${res.status}`;
  return new Error(detail ? `${base}: ${detail}` : base);
}

/** Concatenate all text blocks from an Anthropic `content` array. */
function anthropicText(json: unknown): string {
  const content = (json as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string") {
        return (block as { text: string }).text;
      }
      return "";
    })
    .join("");
}

/** Perform ONE completion request and return the assistant's text. */
export async function llmComplete(
  cfg: LlmConfig,
  req: LlmRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!cfg.apiKey) {
    throw new Error("Missing API key. Configure an API key before running the model.");
  }

  // Default is generous so it clears a thinking model's budget_tokens; tunable in Settings.
  const maxTokens = req.maxTokens ?? cfg.maxTokens ?? 4096;
  // Only forward `temperature` when the caller explicitly set one. Some models
  // (e.g. thinking-enabled Claude behind a gateway) reject any value other than 1,
  // so omitting it lets the provider apply its own valid default.
  const temperature = req.temperature;

  if (cfg.provider === "anthropic") {
    return anthropicComplete(cfg, req, maxTokens, temperature, fetchImpl);
  }
  return openaiCompatibleComplete(cfg, req, maxTokens, temperature, fetchImpl);
}

async function anthropicComplete(
  cfg: LlmConfig,
  req: LlmRequest,
  maxTokens: number,
  temperature: number | undefined,
  fetchImpl: typeof fetch,
): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": cfg.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: maxTokens,
        ...(typeof temperature === "number" ? { temperature } : {}),
        system: req.system,
        messages: [{ role: "user", content: req.prompt }],
      }),
    });
  } catch (cause) {
    throw new Error(`Network error calling Anthropic: ${errorText(cause)}`);
  }
  if (!res.ok) throw await responseError(res);
  const json = await res.json();
  return anthropicText(json);
}

async function openaiCompatibleComplete(
  cfg: LlmConfig,
  req: LlmRequest,
  maxTokens: number,
  temperature: number | undefined,
  fetchImpl: typeof fetch,
): Promise<string> {
  const baseUrl = cfg.provider === "custom" ? cfg.baseUrl : PRESETS.openai.defaultBaseUrl;
  if (!baseUrl) {
    throw new Error('Custom provider requires a "baseUrl" (an OpenAI-compatible endpoint).');
  }

  const messages: Array<{ role: string; content: string }> = [];
  if (req.system) messages.push({ role: "system", content: req.system });
  messages.push({ role: "user", content: req.prompt });

  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + cfg.apiKey,
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: maxTokens,
        ...(typeof temperature === "number" ? { temperature } : {}),
        messages,
      }),
    });
  } catch (cause) {
    throw new Error(`Network error calling ${baseUrl}: ${errorText(cause)}`);
  }
  if (!res.ok) throw await responseError(res);
  const json = await res.json();
  const content = (json as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : "";
}

function errorText(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

/**
 * Load the persisted LLM config from localStorage, or null if none/invalid.
 *
 * SECURITY: The stored config includes the API key in plaintext in the
 * browser's localStorage. This is only acceptable for a reviewer running the
 * tool locally with their own key. Never deploy publicly with a shared key.
 */
export function loadLlmConfig(): LlmConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as LlmConfig;
    return null;
  } catch {
    return null;
  }
}

/**
 * Persist (or clear, when passed null) the LLM config in localStorage.
 *
 * SECURITY: See {@link loadLlmConfig} — the API key is stored in plaintext in
 * the browser. Local-reviewer use only; never host publicly with a shared key.
 */
export function saveLlmConfig(cfg: LlmConfig | null): void {
  try {
    if (cfg === null) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch {
    // localStorage may be unavailable (private mode, quota); fail silently.
  }
}
