// Generates one drag-and-droppable sample per supported input format into
// ./test-files/, all built from the same generic scenario set so each file
// contains real, reviewable conversations. No company/product references.
//
//   node generate-test-files.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(here, "test-files");
mkdirSync(outDir, { recursive: true });

const SYS = "You are a helpful general-purpose assistant. Use tools when they improve accuracy. Be concise.";
const MODELS = ["gpt-4o", "claude-opus-4-8", "gemini-1.5-pro", "llama-3.1-70b"];

/* Shared scenarios: turns are { sys } | { u } | { a, tools:[{name,args,result}] } */
const scenarios = [
  { turns: [
    { u: "What's 15% of 2,480, then add 90?" },
    { a: "Computing that.", tools: [{ name: "calculator", args: { expression: "2480*0.15" }, result: { value: 372 } }] },
    { a: "15% of 2,480 is 372; plus 90 is 462.", tools: [{ name: "calculator", args: { expression: "372+90" }, result: { value: 462 } }] },
  ] },
  { turns: [
    { u: "Is it going to rain in Berlin this weekend? I want to hike Saturday." },
    { a: "Checking the forecast.", tools: [{ name: "weather", args: { city: "Berlin", range: "weekend" }, result: { sat: "12°C, 70% rain", sun: "18°C, clear" } }] },
    { a: "Saturday looks wet (12°C, 70% rain) but Sunday is clear and 18°C — better to hike Sunday." },
  ] },
  { turns: [
    { u: "Suggest a dinner recipe. I'm vegetarian." },
    { a: "Try a classic chicken piccata with a lemon-caper sauce, ready in 25 minutes." }, // BAD: ignores constraint
  ] },
  { turns: [
    { u: "Book me a table for 4 tonight at 8pm, italian." },
    { a: "Booking now.", tools: [{ name: "reservation_create", args: { party: 4, time: "20:00", cuisine: "italian" }, result: { error: "no availability at requested time" } }] },
    { a: "All set! Your table for 4 at 8pm is confirmed." }, // BAD: tool errored, claimed success
  ] },
  { turns: [
    { u: "How many active users signed up last month? Query the analytics DB." },
    { a: "Running the query.", tools: [{ name: "sql_query", args: { sql: "SELECT COUNT(*) FROM users WHERE created_at >= date_trunc('month', now()-interval '1 month') AND created_at < date_trunc('month', now()) AND status='active'" }, result: { rows: [{ count: 8421 }] } }] },
    { a: "8,421 active users signed up last month." },
  ] },
  { turns: [
    { u: "What's the current price of ticker ACME?" },
    { a: "Fetching the quote.", tools: [{ name: "stock_quote", args: { ticker: "ACME" }, result: { error: "request timed out" } }] },
    { a: "ACME is trading at $142.37, up 1.2% today." }, // BAD: invented data after timeout
  ] },
  { turns: [
    { u: "Translate 'The meeting is postponed to next week' into French and Japanese." },
    { a: "Translating.", tools: [{ name: "translate", args: { text: "The meeting is postponed to next week", to: ["fr", "ja"] }, result: { fr: "La réunion est reportée à la semaine prochaine.", ja: "会議は来週に延期されました。" } }] },
    { a: "- French: La réunion est reportée à la semaine prochaine.\n- Japanese: 会議は来週に延期されました。" },
  ] },
  { turns: [
    { u: "Write a Python palindrome check and run it on 'racecar'." },
    { a: "Here's a function and a test.", tools: [{ name: "code_run", args: { lang: "python", code: "def is_pal(s):\n s=''.join(c.lower() for c in s if c.isalnum())\n return s==s[::-1]\nprint(is_pal('racecar'))" }, result: { stdout: "True" } }] },
    { a: "It normalizes case/punctuation then compares to the reverse. On 'racecar' it returns True." },
  ] },
  { turns: [
    { u: "In ONE sentence, what is photosynthesis?" },
    { a: "Photosynthesis is a truly remarkable process that has fascinated scientists for centuries; it begins when light strikes the leaves, and through many intricate steps involving chlorophyll, water and CO2, the plant makes glucose. This fuels the organism. It is the foundation of life on Earth." }, // BAD: not one sentence
  ] },
  { turns: [
    { u: "Find open bugs assigned to me, sorted by priority." },
    { a: "Fetching your issues.", tools: [{ name: "issue_search", args: { assignee: "me", status: "open", sort: "priority" }, result: { issues: [{ id: "BUG-204", p: "high", title: "Login timeout" }, { id: "BUG-198", p: "medium", title: "Avatar upload broken" }] } }] },
    { a: "You have 2 open bugs:\n1. BUG-204 (high) — Login timeout\n2. BUG-198 (medium) — Avatar upload broken" },
  ] },
  { turns: [
    { u: "Convert 100 USD to EUR." },
    { a: "Let me check.", tools: [{ name: "currency_convert", args: { from: "USD", to: "EUR", amount: 100 }, result: { value: 92.4 } }] },
    { a: "100 USD ≈ 92.40 EUR at the current rate." },
  ] },
  { turns: [
    { u: "How do I cancel my subscription?" },
    { a: "Our premium plan includes 4K streaming and 6 profiles for $14.99/mo. Want to upgrade?" }, // BAD: wrong question answered
  ] },
];

/* Attach a model + trace id to each scenario. */
const withMeta = scenarios.map((s, i) => ({ ...s, model: MODELS[i % MODELS.length], traceId: "trace-" + String(i + 1).padStart(3, "0") }));

/* --- turn a scenario into an ordered event list (msgs + tool observations) --- */
function scenarioMessages(sc) {
  const msgs = [{ role: "system", content: sc.turns.find(t => t.sys)?.sys || SYS }];
  for (const t of sc.turns) {
    if (t.sys) continue;
    if (t.u != null) { msgs.push({ role: "user", content: t.u }); continue; }
    const asst = { role: "assistant", content: t.a };
    if (t.tools?.length) asst.tool_calls = t.tools.map(x => ({ function: { name: x.name, arguments: JSON.stringify(x.args) } }));
    msgs.push(asst);
    (t.tools || []).forEach(x => msgs.push({ role: "tool", name: x.name, content: JSON.stringify(x.result) }));
  }
  return msgs;
}

let clock = 1_700_000_000_000;
const tick = () => (clock += 500);
const tok = s => Math.max(1, Math.round(String(s).length / 4));

/* ============================================================
   1. OTLP export (resourceSpans) with gen_ai.* attributes
   ============================================================ */
function toOTLP() {
  const scopeSpans = [];
  withMeta.forEach(sc => {
    const spans = [];
    const history = [{ role: "system", content: SYS }];
    let n = 0;
    for (const t of sc.turns) {
      if (t.sys) { history[0].content = t.sys; continue; }
      if (t.u != null) { history.push({ role: "user", content: t.u }); continue; }
      const attrs = [
        { key: "gen_ai.request.model", value: { stringValue: sc.model } },
        { key: "gen_ai.usage.prompt_tokens", value: { intValue: String(history.reduce((a, m) => a + tok(m.content), 0)) } },
        { key: "gen_ai.usage.completion_tokens", value: { intValue: String(tok(t.a)) } },
      ];
      history.forEach((m, i) => {
        attrs.push({ key: `gen_ai.prompt.${i}.role`, value: { stringValue: m.role } });
        attrs.push({ key: `gen_ai.prompt.${i}.content`, value: { stringValue: m.content } });
      });
      attrs.push({ key: "gen_ai.completion.0.role", value: { stringValue: "assistant" } });
      attrs.push({ key: "gen_ai.completion.0.content", value: { stringValue: t.a } });
      (t.tools || []).forEach((x, ti) => {
        attrs.push({ key: `gen_ai.completion.0.tool_calls.${ti}.name`, value: { stringValue: x.name } });
        attrs.push({ key: `gen_ai.completion.0.tool_calls.${ti}.arguments`, value: { stringValue: JSON.stringify(x.args) } });
      });
      spans.push({ traceId: sc.traceId, spanId: `${sc.traceId}-${++n}`, name: "chat " + sc.model, startTimeUnixNano: String(tick() * 1e6), endTimeUnixNano: String(tick() * 1e6), attributes: attrs });
      history.push({ role: "assistant", content: t.a });
      (t.tools || []).forEach(x => {
        spans.push({ traceId: sc.traceId, spanId: `${sc.traceId}-${++n}`, name: x.name, startTimeUnixNano: String(tick() * 1e6), endTimeUnixNano: String(tick() * 1e6), attributes: [
          { key: "gen_ai.operation.name", value: { stringValue: "tool" } },
          { key: "gen_ai.tool.name", value: { stringValue: x.name } },
          { key: "input.value", value: { stringValue: JSON.stringify(x.args) } },
          { key: "output.value", value: { stringValue: JSON.stringify(x.result) } },
        ] });
        history.push({ role: "tool", content: JSON.stringify(x.result) });
      });
    }
    scopeSpans.push({ scope: { name: "openllmetry" }, spans });
  });
  return { resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "assistant-agent" } }] }, scopeSpans }] };
}

/* ============================================================
   2. OpenInference flat span array (attributes as an object)
   ============================================================ */
function toOpenInference() {
  const out = [];
  withMeta.forEach(sc => {
    const history = [{ role: "system", content: SYS }];
    let n = 0;
    for (const t of sc.turns) {
      if (t.sys) { history[0].content = t.sys; continue; }
      if (t.u != null) { history.push({ role: "user", content: t.u }); continue; }
      const a = {
        "openinference.span.kind": "LLM",
        "llm.model_name": sc.model,
        "llm.token_count.prompt": history.reduce((x, m) => x + tok(m.content), 0),
        "llm.token_count.completion": tok(t.a),
      };
      history.forEach((m, i) => {
        a[`llm.input_messages.${i}.message.role`] = m.role;
        a[`llm.input_messages.${i}.message.content`] = m.content;
      });
      a["llm.output_messages.0.message.role"] = "assistant";
      a["llm.output_messages.0.message.content"] = t.a;
      (t.tools || []).forEach((x, ti) => {
        a[`llm.output_messages.0.message.tool_calls.${ti}.tool_call.function.name`] = x.name;
        a[`llm.output_messages.0.message.tool_calls.${ti}.tool_call.function.arguments`] = JSON.stringify(x.args);
      });
      out.push({ trace_id: sc.traceId, span_id: `${sc.traceId}-${++n}`, name: "LLM", startTimeUnixNano: String(tick()), endTimeUnixNano: String(tick()), attributes: a });
      history.push({ role: "assistant", content: t.a });
      (t.tools || []).forEach(x => {
        out.push({ trace_id: sc.traceId, span_id: `${sc.traceId}-${++n}`, name: x.name, startTimeUnixNano: String(tick()), endTimeUnixNano: String(tick()), attributes: { "openinference.span.kind": "TOOL", "tool.name": x.name, "input.value": JSON.stringify(x.args), "output.value": JSON.stringify(x.result) } });
        history.push({ role: "tool", content: JSON.stringify(x.result) });
      });
    }
  });
  return out;
}

/* ============================================================
   3. Langfuse export ({traces, observations})
   ============================================================ */
function toLangfuse() {
  const traces = [], observations = [];
  withMeta.forEach(sc => {
    traces.push({ id: sc.traceId, name: "assistant run", model: sc.model });
    const history = [{ role: "system", content: SYS }];
    let n = 0;
    for (const t of sc.turns) {
      if (t.sys) { history[0].content = t.sys; continue; }
      if (t.u != null) { history.push({ role: "user", content: t.u }); continue; }
      observations.push({ id: `${sc.traceId}-o${++n}`, traceId: sc.traceId, type: "GENERATION", name: "llm", startTime: new Date(tick()).toISOString(),
        input: { messages: history.map(m => ({ role: m.role, content: m.content })) },
        output: { role: "assistant", content: t.a } });
      history.push({ role: "assistant", content: t.a });
      (t.tools || []).forEach(x => {
        observations.push({ id: `${sc.traceId}-o${++n}`, traceId: sc.traceId, type: "TOOL", name: x.name, startTime: new Date(tick()).toISOString(), input: x.args, output: x.result });
        history.push({ role: "tool", content: JSON.stringify(x.result) });
      });
    }
  });
  return { traces, observations };
}

/* ============================================================
   4/5. Plain conversation(s)
   ============================================================ */
function toPlainSingle() { return scenarioMessages(withMeta[0]); }           // one [{role,content}]
function toPlainMulti() { return withMeta.slice(0, 6).map(scenarioMessages); } // [[...],[...]]

/* ============================================================
   6. NDJSON — one OpenInference span per line
   ============================================================ */
function toNdjson() { return toOpenInference().map(s => JSON.stringify(s)).join("\n"); }

/* ============================================================
   7. Custom / unknown fallback records
   ============================================================ */
function toCustom() {
  return withMeta.slice(0, 6).map((sc, i) => ({
    request_id: sc.traceId,
    engine: sc.model,
    latency_ms: 1200 + i * 137,
    dialog: scenarioMessages(sc).map(m => ({ speaker: m.role, text: m.content, ...(m.name ? { tool: m.name } : {}) })),
    custom_metadata: { region: "eu-west", experiment: "A/B-" + (i % 2) },
  }));
}

/* ---- write everything ---- */
const files = [
  ["01-otlp-genai.json", JSON.stringify(toOTLP(), null, 2)],
  ["02-openinference-spans.json", JSON.stringify(toOpenInference(), null, 2)],
  ["03-langfuse-export.json", JSON.stringify(toLangfuse(), null, 2)],
  ["04-plain-conversation.json", JSON.stringify(toPlainSingle(), null, 2)],
  ["05-array-of-conversations.json", JSON.stringify(toPlainMulti(), null, 2)],
  ["06-ndjson-spans.ndjson", toNdjson()],
  ["07-custom-fallback.json", JSON.stringify(toCustom(), null, 2)],
];
for (const [name, content] of files) {
  writeFileSync(join(outDir, name), content);
  console.log(`wrote test-files/${name}  (${content.length.toLocaleString()} bytes)`);
}
