// Domain types shared across the app.

export type Verdict = "pass" | "fail" | null;

export interface ToolCall {
  name: string;
  input: unknown;
}

export interface Step {
  kind: "message" | "tool_call" | "unknown";
  role?: string;
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  raw?: unknown;
}

export interface ConversationMeta {
  model?: string;
  agentName?: string;
  durationMs?: number;
  tokens?: { in: number; out: number };
  status?: string;
}

export interface Conversation {
  id: string;
  startNs: number;
  meta: ConversationMeta;
  steps: Step[];
}

export interface ParseResult {
  format: string;
  conversations: Conversation[];
}

export interface Feedback {
  verdict: Verdict;
  comment: string;
  codes: string[];
  reviewedAt: string | null;
  reviewer?: string | null;
  tags?: string[]; // legacy field, migrated into `codes`
  /** Reviewer asserts this conversation was exhaustively coded (all failure categories present were
   *  captured). Lets judge evaluation scope its ground truth to trustworthy negatives. */
  fullyCoded?: boolean;
}

/** One higher-level error category produced by axial coding. */
export interface Category {
  name: string;
  description: string;
  codes: string[];
}

export interface Axial {
  categories: Category[];
  generatedAt: string;
}

/** A distinct open code with its frequency and example reviewer comments. */
export interface CodeStat {
  code: string;
  count: number;
  comments: string[];
}

/** Minimal per-failure input the coding functions need. */
export interface FailInput {
  comment?: string;
  codes: string[];
}

// ============================================================
// v2: LLM client, anonymization, and judge evaluation
// ============================================================

export type LlmProvider = "anthropic" | "openai" | "custom";

export interface LlmConfig {
  provider: LlmProvider;
  model: string;
  apiKey: string;
  /** For provider "custom": an OpenAI-compatible base URL (e.g. a gateway or local server). */
  baseUrl?: string;
  /** Max output tokens per request. Must exceed a thinking model's budget, so it is tunable. */
  maxTokens?: number;
}

export interface LlmRequest {
  system?: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
}

// ---- Anonymization ----

export type DetectionKind = "email" | "phone" | "ip" | "url" | "card" | "iban" | "name" | "org" | "custom";

export interface Detection {
  kind: DetectionKind;
  start: number;
  end: number;
  value: string;
}

/** token (e.g. "[EMAIL_1]") -> original value */
export type RedactionMap = Record<string, string>;

export interface AnonSettings {
  enabled: boolean;
  /** values the reviewer always wants redacted (names, company names, project codenames…) */
  termList: string[];
  /** capitalized words that look like names but must NEVER be redacted */
  allowList: string[];
  /** run the dictionary-filtered capitalized-word name/org heuristic */
  heuristicNames: boolean;
}

// ---- Judge evaluation ----

export interface Metrics {
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  tpr: number; // recall / sensitivity = TP / (TP + FN)
  tnr: number; // specificity = TN / (TN + FP)
  precision: number; // TP / (TP + FP)
  f1: number;
  accuracy: number;
  kappa: number; // Cohen's kappa (chance-corrected agreement)
  support: { positives: number; negatives: number; total: number };
}

/** One saved version of a category's judge — validated with a specific model. */
export interface JudgeVersion {
  id: string;
  label: string;
  template: string;
  provider: LlmProvider;
  model: string;
  createdAt: string;
  /** metrics measured on the held-out TEST split for this version */
  metrics?: Metrics;
  /** metrics on the TRAIN split, for reference */
  trainMetrics?: Metrics;
}

/** One judge per failure (axial) category. */
export interface Judge {
  category: string;
  versions: JudgeVersion[];
  activeVersionId: string | null;
}
