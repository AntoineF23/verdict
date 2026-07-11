// LLM-as-judge logic: prompt building, tolerant verdict parsing, a bounded
// concurrency run-over-set, and export of the production artifact.
//
// The pure parts (template, render, build, parse, export, new judge) have NO
// DOM/network/Date/random dependencies. `runJudgeOverSet` is the only async
// function and does I/O only through the injected `complete` callback, so the
// whole module is testable without a network or the ./llm module existing.
import type { Category, Conversation, Judge, JudgeVersion, LlmConfig, LlmProvider, Step } from "./types";

/** Signature of the completion callback (matches llm.ts `llmComplete`, minus fetchImpl). */
export type CompleteFn = (
  cfg: LlmConfig,
  req: { system?: string; prompt: string; maxTokens?: number; temperature?: number },
) => Promise<string>;

/**
 * Default per-category binary-judge prompt. Placeholders {category},
 * {description} and {conversation} are substituted by buildJudgePrompt.
 */
export const DEFAULT_JUDGE_TEMPLATE = `You are an expert evaluator judging a single AI agent conversation for ONE specific failure category.

Failure category: {category}
Definition: {description}

Decide whether the conversation below EXHIBITS this failure category.
- Answer true if the conversation clearly exhibits this failure.
- Answer false otherwise (including when it is merely unrelated or ambiguous).
- Judge ONLY this category; ignore other unrelated problems.

Conversation transcript:
{conversation}

Respond with STRICT JSON on a single line and nothing else (no prose, no markdown):
{"label": true|false, "rationale": "one short sentence explaining the decision"}`;

/** Stringify an unknown tool input/output compactly for the transcript. */
function stringifyValue(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Render one step into a transcript line (or "" to skip). */
function renderStep(step: Step): string {
  if (step.kind === "tool_call") {
    const name = step.toolName || "unknown";
    const input = stringifyValue(step.toolInput);
    const output = stringifyValue(step.toolOutput);
    let line = `TOOL ${name}`;
    if (input) line += ` input: ${input}`;
    if (output) line += ` output: ${output}`;
    return line;
  }
  // message / unknown: render role + text
  const role = step.role || (step.kind === "unknown" ? "unknown" : "message");
  const text = step.text ?? (step.kind === "unknown" ? stringifyValue(step.raw) : "");
  return `${role}: ${text}`;
}

/**
 * Turn a Conversation into a readable transcript string, truncated to maxChars
 * (default ~6000) so judge prompts stay bounded.
 */
export function renderConversationForJudge(conv: Conversation, maxChars = 6000): string {
  const lines = conv.steps.map(renderStep).filter((l) => l.trim().length > 0);
  let out = lines.join("\n");
  if (out.length > maxChars) {
    out = out.slice(0, maxChars) + "\n…[truncated]";
  }
  return out;
}

/** Escape a string for use as a literal RegExp replacement target. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Substitute all occurrences of a {placeholder} with a value. */
function fill(template: string, key: string, value: string): string {
  return template.replace(new RegExp(escapeRegExp(`{${key}}`), "g"), value);
}

/** Substitute {category}, {description} and {conversation} placeholders (all occurrences). */
export function buildJudgePrompt(
  template: string,
  category: { name: string; description?: string },
  convText: string,
): string {
  let out = fill(template, "category", category.name);
  out = fill(out, "description", category.description ?? "");
  out = fill(out, "conversation", convText);
  return out;
}

/** Interpret a scalar JSON value as a boolean label, or null if not label-like. */
function coerceLabel(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    if (["true", "yes", "y", "1"].includes(s)) return true;
    if (["false", "no", "n", "0"].includes(s)) return false;
  }
  return null;
}

/** Extract the first balanced {...} JSON object substring, or null. */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Tolerant judge-verdict parser. Strips markdown fences, tries JSON first
 * (accepting boolean or "true"/"false"/"yes"/"no"), then falls back to scanning
 * for yes/no / true/false / "exhibits" / "does not". Throws only if truly
 * indeterminate.
 */
export function parseJudgeVerdict(text: string): { label: boolean; rationale?: string } {
  const cleaned = String(text)
    .replace(/```(json)?/gi, "")
    .replace(/```/g, "")
    .trim();

  // 1) Try a JSON object anywhere in the text (tolerate surrounding prose).
  const jsonStr = extractJsonObject(cleaned);
  if (jsonStr) {
    try {
      const obj = JSON.parse(jsonStr) as Record<string, unknown>;
      const label = coerceLabel(obj.label ?? obj.verdict ?? obj.value);
      if (label !== null) {
        const rationale =
          typeof obj.rationale === "string"
            ? obj.rationale
            : typeof obj.reason === "string"
              ? (obj.reason as string)
              : undefined;
        return rationale !== undefined ? { label, rationale } : { label };
      }
    } catch {
      // fall through to text scanning
    }
  }

  // 2) Fall back to scanning the prose.
  const lower = cleaned.toLowerCase();

  // "label: true" / "answer: no" style
  const kv = lower.match(/(?:label|answer|verdict)\s*[:=]\s*("?)(true|false|yes|no)\1/);
  if (kv) return { label: kv[2] === "true" || kv[2] === "yes" };

  if (/\bdoes not\b|\bdoesn'?t\b|\bnot exhibit/.test(lower)) return { label: false };
  if (/\bexhibits?\b/.test(lower)) return { label: true };

  const word = lower.match(/\b(true|false|yes|no)\b/);
  if (word) return { label: word[1] === "true" || word[1] === "yes" };

  throw new Error("Could not parse a yes/no verdict from the model output.");
}

export interface JudgeResult {
  id: string;
  label: boolean;
  rationale?: string;
  error?: string;
}

/**
 * Run the judge over items with a bounded-concurrency worker pool. Each item's
 * prompt is built and passed to `complete`, whose output is parsed into a
 * verdict. Per-item errors are captured as { id, label:false, error } without
 * aborting the batch. Results are returned in input order; onProgress fires as
 * items finish.
 */
export async function runJudgeOverSet(params: {
  cfg: LlmConfig;
  template: string;
  category: { name: string; description?: string };
  items: { id: string; convText: string }[];
  complete: CompleteFn;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}): Promise<JudgeResult[]> {
  const { cfg, template, category, items, complete, onProgress } = params;
  const total = items.length;
  const results: JudgeResult[] = new Array(total);
  const concurrency = Math.max(1, params.concurrency ?? 4);

  let next = 0;
  let done = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++;
      if (index >= total) return;
      const item = items[index];
      try {
        const prompt = buildJudgePrompt(template, category, item.convText);
        const text = await complete(cfg, { prompt });
        const verdict = parseJudgeVerdict(text);
        results[index] = { id: item.id, label: verdict.label, rationale: verdict.rationale };
      } catch (err) {
        results[index] = { id: item.id, label: false, error: err instanceof Error ? err.message : String(err) };
      }
      done++;
      onProgress?.(done, total);
    }
  };

  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(concurrency, total); i++) workers.push(worker());
  await Promise.all(workers);

  return results;
}

/**
 * Produce the production artifact for the judge's ACTIVE version: a JSON config
 * object (exportedAt left null for the caller to stamp) and a promptText with
 * {category}/{description} filled but {conversation} kept as a literal
 * placeholder for the production caller to fill. Throws if no active version.
 */
export function exportJudge(judge: Judge, category: Category): { json: object; promptText: string } {
  const active = judge.versions.find((v) => v.id === judge.activeVersionId);
  if (!active) throw new Error("No active judge version to export.");

  const json = {
    category: category.name,
    description: category.description,
    provider: active.provider,
    model: active.model,
    template: active.template,
    metrics: active.metrics,
    exportedAt: null as string | null,
  };

  let promptText = fill(active.template, "category", category.name);
  promptText = fill(promptText, "description", category.description ?? "");
  // Leave {conversation} intact for the production caller to substitute.

  return { json, promptText };
}

/**
 * Create a Judge for a category with one initial version using
 * DEFAULT_JUDGE_TEMPLATE. Date-free/random-free: `idSeed` is the version id and
 * createdAt is "" for the caller to stamp.
 */
export function newJudgeForCategory(
  category: Category,
  provider: LlmProvider,
  model: string,
  idSeed: string,
): Judge {
  const version: JudgeVersion = {
    id: idSeed,
    label: "v1",
    template: DEFAULT_JUDGE_TEMPLATE,
    provider,
    model,
    createdAt: "",
  };
  return {
    category: category.name,
    versions: [version],
    activeVersionId: version.id,
  };
}
