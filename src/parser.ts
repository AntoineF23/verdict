// @ts-nocheck
// Format-agnostic trace parser. Pure (no DOM, no app state) so it is easy to test.
// Ported verbatim from the original single-file tool; typing is intentionally loose
// here because it consumes arbitrary third-party JSON. Public return types are
// annotated (below) so consumers get proper types despite @ts-nocheck.
import type { ParseResult } from "./types";

/* ============================================================
   GENERIC HELPERS
   ============================================================ */
export function esc(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]
  ));
}
function hashStr(s) {
  s = typeof s === "string" ? s : safeStringify(s);
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return h;
}
function safeStringify(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}
export function pretty(v) {
  if (v == null) return "";
  if (typeof v === "string") {
    // If it's a JSON string, pretty-print it.
    const t = v.trim();
    if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
      try { return JSON.stringify(JSON.parse(t), null, 2); } catch {}
    }
    return v;
  }
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}
function asText(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  // Content can be an array of parts ([{type:'text',text:'..'}])
  if (Array.isArray(v)) {
    const parts = v.map(p => {
      if (p == null) return "";
      if (typeof p === "string") return p;
      if (typeof p === "object") return p.text ?? p.content ?? safeStringify(p);
      return String(p);
    }).filter(Boolean);
    if (parts.length) return parts.join("\n");
  }
  return safeStringify(v);
}
function firstDefined(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null && obj[k] !== "") return obj[k];
  }
  return undefined;
}
/* Resolve a dotted path ("llm.input_messages") against a nested object. */
function getPath(obj, path) {
  let node = obj;
  for (const p of path.split(".")) {
    if (node == null) return undefined;
    node = node[p];
  }
  return node;
}

/* Un-flatten dotted / indexed keys ("a.b.0.c") into nested objects/arrays. */
function unflatten(flat) {
  const root = {};
  for (const key of Object.keys(flat)) {
    const parts = key.split(".");
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const last = i === parts.length - 1;
      const nextIsIndex = !last && /^\d+$/.test(parts[i + 1]);
      if (last) {
        node[part] = flat[key];
      } else {
        if (node[part] == null) node[part] = nextIsIndex ? [] : {};
        node = node[part];
      }
    }
  }
  // Convert numeric-keyed objects into arrays where sensible.
  return normalizeArrays(root);
}
function normalizeArrays(node) {
  if (Array.isArray(node)) return node.map(normalizeArrays).filter(x => x !== undefined);
  if (node && typeof node === "object") {
    const keys = Object.keys(node);
    const allNum = keys.length && keys.every(k => /^\d+$/.test(k));
    if (allNum) {
      const arr = [];
      keys.sort((a, b) => a - b).forEach(k => { arr[+k] = normalizeArrays(node[k]); });
      return arr.filter(x => x !== undefined);
    }
    const out = {};
    for (const k of keys) out[k] = normalizeArrays(node[k]);
    return out;
  }
  return node;
}

/* ============================================================
   OTLP DECODING
   ============================================================ */
function otlpValue(v) {
  if (v == null || typeof v !== "object") return v;
  if ("stringValue" in v) return v.stringValue;
  if ("intValue" in v) return Number(v.intValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("boolValue" in v) return v.boolValue;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(otlpValue);
  if ("kvlistValue" in v) {
    const o = {};
    (v.kvlistValue.values || []).forEach(kv => { o[kv.key] = otlpValue(kv.value); });
    return o;
  }
  return v;
}
function otlpAttrsToObject(attrs) {
  const o = {};
  (attrs || []).forEach(a => { o[a.key] = otlpValue(a.value); });
  return o;
}

/* Return a flat {key:value} attribute map for any span shape. */
function getSpanAttrs(span) {
  let a = span.attributes;
  if (Array.isArray(a)) return otlpAttrsToObject(a);        // OTLP shape
  if (a && typeof a === "object") return a;                  // already flat
  // Some exporters put attributes at the top level or under tags
  if (Array.isArray(span.tags)) {
    const o = {}; span.tags.forEach(t => { o[t.key] = t.value; }); return o;
  }
  return {};
}
function getTraceId(span) {
  return span.trace_id || span.traceId ||
    (span.context && (span.context.trace_id || span.context.traceId)) ||
    (span.spanContext && span.spanContext.traceId) || null;
}
function getStartNs(span) {
  const v = span.startTimeUnixNano ?? span.start_time_unix_nano ?? span.startTime ?? span.start_time ?? span.timestamp;
  if (v == null) return 0;
  const n = Number(v);
  return isNaN(n) ? Date.parse(v) * 1e6 || 0 : n;
}

/* ============================================================
   ATTRIBUTE KEY DICTIONARIES (agnostic probing)
   ============================================================ */
const MSG_ARRAY_KEYS = [
  // New OpenTelemetry GenAI convention (used by AI SDK v7): role + typed `parts`.
  ["gen_ai.input.messages", "input"],
  ["gen_ai.output.messages", "output"],
  // OpenInference and older / other conventions.
  ["llm.input_messages", "input"],
  ["llm.output_messages", "output"],
  ["gen_ai.prompt", "input"],
  ["gen_ai.completion", "output"],
  ["messages", "input"],
  ["input.messages", "input"],
  ["output.messages", "output"],
];
const MODEL_KEYS = ["llm.model_name", "gen_ai.request.model", "gen_ai.response.model", "model", "llm.invocation_parameters.model"];
const AGENT_KEYS = ["agent.name", "gen_ai.agent.name", "openinference.span.kind", "service.name"];
const TOOL_NAME_KEYS = ["tool.name", "gen_ai.tool.name", "tool_call.function.name", "function.name", "name"];
const TOOL_INPUT_KEYS = ["tool.parameters", "tool.arguments", "input.value", "tool_call.function.arguments", "arguments", "input"];
const TOOL_OUTPUT_KEYS = ["tool.output", "output.value", "tool_response", "output"];
const TOK_IN_KEYS = ["gen_ai.usage.prompt_tokens", "llm.token_count.prompt", "gen_ai.usage.input_tokens", "usage.prompt_tokens"];
const TOK_OUT_KEYS = ["gen_ai.usage.completion_tokens", "llm.token_count.completion", "gen_ai.usage.output_tokens", "usage.completion_tokens"];

/* Map common role synonyms onto the canonical set. */
const ROLE_ALIASES = {
  human: "user", customer: "user", person: "user", client: "user",
  ai: "assistant", bot: "assistant", agent: "assistant", model: "assistant", llm: "assistant", gpt: "assistant",
  sys: "system",
  function: "tool", tool_result: "tool", observation: "tool",
};

/* Normalize one raw message-like object into {role, content, toolCalls[]}. */
function normalizeMessage(m, fallbackRole) {
  if (m == null) return null;
  if (typeof m === "string") return { role: fallbackRole || "user", content: m, toolCalls: [] };
  // OpenInference wraps content under `message`.
  const msg = (m.message && typeof m.message === "object") ? m.message : m;
  let role = msg.role || msg.author || msg.speaker || msg.from || msg.sender || fallbackRole || "assistant";
  role = ROLE_ALIASES[String(role).toLowerCase()] || role;

  // New OpenTelemetry GenAI convention (AI SDK v7): a `parts` array of typed parts,
  // e.g. {type:"text",content}, {type:"tool_call",name,arguments,id},
  // {type:"tool_call_response",response,id}.
  if (Array.isArray(msg.parts)) {
    const texts = [];
    const calls = [];
    for (const p of msg.parts) {
      if (!p || typeof p !== "object") { if (p != null) texts.push(String(p)); continue; }
      const type = String(p.type || "").toLowerCase();
      const fn = (p.function && typeof p.function === "object") ? p.function : null;
      if (type === "tool_call" || type === "function_call") {
        calls.push({ name: p.name || (fn && fn.name) || "tool", input: p.arguments ?? p.args ?? (fn && (fn.arguments ?? fn.parameters)) ?? "" });
      } else if (type === "tool_call_response" || type === "tool_response" || type === "tool_result") {
        texts.push(asText(p.response ?? p.result ?? p.content));
      } else if (p.content != null) {
        texts.push(asText(p.content));
      } else if (p.text != null) {
        texts.push(asText(p.text));
      }
    }
    return { role, content: texts.filter(Boolean).join("\n"), toolCalls: calls, raw: msg };
  }

  let content = msg.content ?? msg.text ?? msg.value ?? msg.utterance ?? msg.body ??
    (typeof msg.message === "string" ? msg.message : "") ?? "";
  content = asText(content);
  // tool calls
  let rawCalls = msg.tool_calls || msg.toolCalls || msg.function_call || [];
  if (!Array.isArray(rawCalls)) rawCalls = rawCalls ? [rawCalls] : [];
  const toolCalls = rawCalls.map(tc => {
    const t = (tc && tc.tool_call) ? tc.tool_call : tc;
    const fn = (t && t.function) ? t.function : t;
    return {
      name: (fn && (fn.name)) || (t && t.name) || "tool",
      input: (fn && (fn.arguments ?? fn.parameters)) ?? (t && t.arguments) ?? "",
    };
  }).filter(Boolean);
  return { role, content, toolCalls, raw: msg };
}

/* Parse a value that might be messages (array, {messages:[]}, JSON string). */
function coerceMessages(val, dir) {
  if (val == null) return [];
  let v = val;
  if (typeof v === "string") {
    const t = v.trim();
    if (t.startsWith("[") || t.startsWith("{")) {
      try { v = JSON.parse(t); } catch { return []; }
    } else return [];
  }
  if (Array.isArray(v)) return v.map(x => normalizeMessage(x)).filter(Boolean);
  if (v && typeof v === "object") {
    if (Array.isArray(v.messages)) return v.messages.map(x => normalizeMessage(x)).filter(Boolean);
    if (v.role || v.content || v.message) { const n = normalizeMessage(v); return n ? [n] : []; }
  }
  return [];
}

/* Extract ordered messages from an (unflattened) attribute object. */
function extractMessages(attrs) {
  const out = [];
  for (const [key] of MSG_ARRAY_KEYS) {
    const val = getPath(attrs, key);
    if (val != null) out.push(...coerceMessages(val));
  }
  return out;
}

/* Tool-span detection works off the FLAT attribute map (dotted keys intact). */
function looksLikeToolSpan(flat, span) {
  const kind = String(flat["openinference.span.kind"] || flat["gen_ai.operation.name"] || "").toLowerCase();
  if (kind.includes("tool")) return true;
  if (firstDefined(flat, ["tool.name", "gen_ai.tool.name"]) != null) return true;
  const name = String((span && span.name) || "").toLowerCase();
  if (/tool|function/.test(name) && flat["input.value"] != null) return true;
  return false;
}

/* ============================================================
   NORMALIZE: shared ledger
   ============================================================ */
/* Normalize a value for identity comparison (parse JSON strings so
   '{"a":1}' and {a:1} compare equal). */
function normArg(v) {
  if (v == null) return "";
  try {
    if (typeof v === "string") {
      const t = v.trim();
      if (t.startsWith("{") || t.startsWith("[")) return JSON.stringify(JSON.parse(t));
      return t;
    }
    return JSON.stringify(v);
  } catch { return String(v); }
}

/* A ledger accumulates timeline steps while (a) merging the multiple
   representations of ONE tool call — the assistant's request, the TOOL span,
   and the tool-result message — into a single step, and (b) de-duplicating
   messages repeated across overlapping prompt windows. */
function newLedger() {
  const steps = [];
  const seenMsg = new Set();
  const tools = [];   // tool_call steps, for matching results back to requests

  function toolRequest(name, input, raw) {
    const key = normArg(input);
    let t = tools.find(x => x.toolName === name && x.inputKey === key);
    if (t) return t;                       // duplicate request — reuse
    t = { kind: "tool_call", role: "tool", toolName: name || "tool", toolInput: input, toolOutput: undefined, inputKey: key, raw };
    tools.push(t); steps.push(t); return t;
  }
  /* A completed observation of a tool, from a TOOL span or a tool-result message. */
  function toolResult(output, raw, name, input) {
    const key = input != null ? normArg(input) : null;
    // 1) match an existing request with the same name+input
    let t = (name && key != null) ? tools.find(x => x.toolName === name && x.inputKey === key) : null;
    // 2) otherwise fill the earliest request still lacking an output
    if (!t) t = tools.find(x => x.toolOutput === undefined);
    if (t) {
      if (t.toolOutput === undefined && output !== undefined) t.toolOutput = output;
      if ((!t.toolName || t.toolName === "tool") && name) t.toolName = name;
      if (t.toolInput == null && input != null) { t.toolInput = input; t.inputKey = key; }
      if (!t.raw && raw) t.raw = raw;
      return t;
    }
    // 3) no matching request — dedup by identical output, else add a new step
    if (output !== undefined && tools.some(x => x.toolOutput !== undefined && normArg(x.toolOutput) === normArg(output))) return null;
    const nt = { kind: "tool_call", role: "tool", toolName: name || "tool", toolInput: input, toolOutput: output, inputKey: key, raw };
    tools.push(nt); steps.push(nt); return nt;
  }
  function addMessage(m) {
    if (!m) return;
    if (m.role === "tool" || m.role === "function") {
      toolResult(m.content, m.raw || m, (m.raw && (m.raw.name || m.raw.tool_name)) || undefined);
      return;
    }
    const key = m.role + "::" + m.content;
    if (m.content && !seenMsg.has(key)) {
      seenMsg.add(key);
      steps.push({ kind: "message", role: m.role, text: m.content, raw: m });
    }
    (m.toolCalls || []).forEach(tc => toolRequest(tc.name, tc.input, tc));
  }
  function addUnknown(role, text, raw) { steps.push({ kind: "unknown", role, text, raw }); }
  function finalize() { steps.forEach(s => { delete s.inputKey; }); return steps; }

  return { steps, addMessage, toolResult, addUnknown, finalize };
}

/* ============================================================
   NORMALIZE: spans -> conversation
   ============================================================ */
function spansToConversation(traceId, spans) {
  spans = spans.slice().sort((a, b) => getStartNs(a) - getStartNs(b));
  const led = newLedger();
  const meta = { model: undefined, agentName: undefined, tokensIn: 0, tokensOut: 0, status: undefined };
  let startNs = Infinity, endNs = 0;

  for (const span of spans) {
    startNs = Math.min(startNs, getStartNs(span));
    const endV = Number(span.endTimeUnixNano ?? span.end_time_unix_nano ?? 0);
    if (endV) endNs = Math.max(endNs, endV);

    const flat = getSpanAttrs(span);
    const attrs = unflatten(flat);
    // meta
    meta.model = meta.model || firstDefined(flat, MODEL_KEYS);
    const ag = firstDefined(flat, ["agent.name", "gen_ai.agent.name"]);
    if (ag) meta.agentName = ag;
    meta.tokensIn += Number(firstDefined(flat, TOK_IN_KEYS) || 0);
    meta.tokensOut += Number(firstDefined(flat, TOK_OUT_KEYS) || 0);
    if (String(flat["status.code"] || (span.status && span.status.code) || "").match(/error/i)) meta.status = "error";

    if (looksLikeToolSpan(flat, span)) {
      const tn = firstDefined(flat, TOOL_NAME_KEYS) || span.name || "tool";
      const ti = firstDefined(flat, TOOL_INPUT_KEYS);
      const to = firstDefined(flat, TOOL_OUTPUT_KEYS);
      led.toolResult(to, flat, tn, ti);
      continue;
    }

    const msgs = extractMessages(attrs);
    if (msgs.length) {
      msgs.forEach(m => led.addMessage(m));
    } else {
      // Nothing recognized — keep it as an inspectable unknown step only if it
      // carries content-ish attributes; otherwise skip pure infrastructure spans.
      const hasContent = firstDefined(flat, ["input.value", "output.value", "input", "output"]) != null;
      if (hasContent) led.addUnknown(span.name || "span", pretty(firstDefined(flat, ["output.value", "input.value", "output", "input"])), flat);
    }
  }

  const steps = led.finalize();
  return {
    id: traceId,
    startNs: startNs === Infinity ? 0 : startNs,
    meta: {
      model: meta.model,
      agentName: meta.agentName,
      durationMs: endNs && startNs !== Infinity ? Math.round((endNs - startNs) / 1e6) : undefined,
      tokens: (meta.tokensIn || meta.tokensOut) ? { in: meta.tokensIn, out: meta.tokensOut } : undefined,
      status: meta.status,
    },
    steps: steps.length ? steps : [{ kind: "unknown", role: "trace", text: "(no readable content extracted — see raw)", raw: { spans } }],
  };
}

/* Group a flat list of spans into conversations by trace id. */
function groupSpans(spans) {
  const groups = new Map();
  let auto = 0;
  for (const s of spans) {
    let tid = getTraceId(s);
    if (!tid) tid = "trace-" + (auto++);
    if (!groups.has(tid)) groups.set(tid, []);
    groups.get(tid).push(s);
  }
  const convs = [];
  for (const [tid, group] of groups) convs.push(spansToConversation(tid, group));
  convs.sort((a, b) => a.startNs - b.startNs);
  return convs;
}

/* Plain [{role,content}] (or [[...],[...]]) conversation(s). */
function messagesToConversation(msgs, id) {
  const led = newLedger();
  msgs.map(m => normalizeMessage(m)).filter(Boolean).forEach(m => led.addMessage(m));
  return { id, startNs: 0, meta: {}, steps: led.finalize() };
}

/* Is this array element message-ish under any common field naming? */
function msgIshItem(x) {
  return x && typeof x === "object" &&
    (x.role || x.content || x.message || x.speaker || x.text || x.from || x.author || x.utterance);
}

/* Fallback: render any object as a timeline if we can find a message array
   under any common key, otherwise as a single inspectable JSON record. */
function objectToConversation(obj, id) {
  const convId = obj.id || obj.trace_id || obj.traceId || obj.request_id || obj.conversation_id || id;
  const meta = {
    model: obj.model || obj.engine || obj.llm || obj.model_name,
    agentName: obj.agent || obj.agent_name || obj.name || obj.service,
    durationMs: obj.latency_ms ?? obj.duration_ms ?? obj.durationMs,
  };
  for (const k of ["messages", "conversation", "conversations", "steps", "events", "turns", "dialog", "transcript", "history", "log", "chat", "exchanges"]) {
    if (Array.isArray(obj[k]) && obj[k].some(msgIshItem)) {
      const c = messagesToConversation(obj[k], convId);
      c.meta = meta;
      return c;
    }
  }
  return { id: convId, startNs: 0, meta, steps: [{ kind: "unknown", role: "record", text: pretty(obj), raw: obj }] };
}

/* ============================================================
   TOP-LEVEL DETECTION
   ============================================================ */
function looksLikeSpan(x) {
  return x && typeof x === "object" &&
    (getTraceId(x) || "attributes" in x || "span_id" in x || "spanId" in x || "startTimeUnixNano" in x);
}
function looksLikeMessage(x) {
  return x && typeof x === "object" && !Array.isArray(x) &&
    (typeof x.role === "string" || typeof x.content === "string" || (x.message && typeof x.message === "object"));
}

export function detectAndNormalize(data): ParseResult {
  // 1. OTLP export
  if (data && typeof data === "object" && Array.isArray(data.resourceSpans)) {
    const spans = [];
    data.resourceSpans.forEach(rs => {
      const scopes = rs.scopeSpans || rs.instrumentationLibrarySpans || [];
      scopes.forEach(sc => (sc.spans || []).forEach(sp => spans.push(sp)));
    });
    return { format: "OTLP export (resourceSpans)", conversations: groupSpans(spans) };
  }

  // 2. Langfuse-style export
  if (data && typeof data === "object" && Array.isArray(data.traces)) {
    const obs = data.observations || data.spans || [];
    const byTrace = new Map();
    data.traces.forEach(t => byTrace.set(t.id || t.traceId, { trace: t, obs: [] }));
    obs.forEach(o => {
      const tid = o.traceId || o.trace_id;
      if (!byTrace.has(tid)) byTrace.set(tid, { trace: { id: tid }, obs: [] });
      byTrace.get(tid).obs.push(o);
    });
    const convs = [];
    for (const [tid, g] of byTrace) {
      const steps = [];
      g.obs.sort((a, b) => (Date.parse(a.startTime || a.start_time || 0)) - (Date.parse(b.startTime || b.start_time || 0)));
      g.obs.forEach(o => {
        coerceMessages(o.input).forEach(m => steps.push({ kind: "message", role: m.role, text: m.content, raw: o.input }));
        const outMsgs = coerceMessages(o.output);
        if (outMsgs.length) outMsgs.forEach(m => steps.push({ kind: "message", role: m.role || "assistant", text: m.content, raw: o.output }));
        else if (o.type === "TOOL" || o.name) {
          if (o.output != null || o.type === "TOOL")
            steps.push({ kind: "tool_call", role: "tool", toolName: o.name || "tool", toolInput: o.input, toolOutput: o.output, raw: o });
        }
      });
      convs.push({ id: tid, startNs: 0, meta: { model: g.trace.model, agentName: g.trace.name }, steps: steps.length ? steps : [{ kind: "unknown", role: "trace", text: pretty(g.trace), raw: g }] });
    }
    return { format: "Langfuse export", conversations: convs };
  }

  // 3. Arrays
  if (Array.isArray(data)) {
    if (data.length === 0) return { format: "empty", conversations: [] };

    if (data.every(looksLikeSpan)) {
      const convs = groupSpans(data);
      const attrKind = data.some(s => { const a = getSpanAttrs(s); return a["openinference.span.kind"] || a["llm.input_messages.0.message.role"]; })
        ? "OpenInference / gen_ai spans" : "span array";
      return { format: attrKind, conversations: convs };
    }
    if (data.every(looksLikeMessage)) {
      return { format: "conversation ([{role, content}])", conversations: [messagesToConversation(data, "conversation-1")] };
    }
    // array of arrays of messages
    if (data.every(x => Array.isArray(x) && x.some(looksLikeMessage))) {
      return { format: "array of conversations", conversations: data.map((c, i) => messagesToConversation(c, "conversation-" + (i + 1))) };
    }
    // array of conversation objects / arbitrary records -> fallback per item
    return { format: "records (fallback)", conversations: data.map((o, i) => objectToConversation(o, "record-" + (i + 1))) };
  }

  // 4. Single object
  if (data && typeof data === "object") {
    return { format: "single record (fallback)", conversations: [objectToConversation(data, "record-1")] };
  }

  return { format: "unknown", conversations: [] };
}

/* ============================================================
   LOAD
   ============================================================ */
export function parseText(text) {
  text = text.trim();
  if (!text) throw new Error("empty file");
  // Try plain JSON
  try { return JSON.parse(text); } catch {}
  // Try NDJSON (one JSON object per line)
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const arr = [];
  for (const l of lines) {
    try { arr.push(JSON.parse(l)); } catch { throw new Error("Could not parse as JSON or NDJSON"); }
  }
  return arr;
}
