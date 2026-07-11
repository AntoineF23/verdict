// Generates dense, generic sample data for the grader — a general-purpose AI
// assistant agent with common tools. No company/product references.
// Emits an OpenInference-style flat span array (spans grouped by trace id),
// with realistic per-turn history duplication so it exercises the dedup path.
//
//   node generate-fixtures.mjs
//   -> fixtures/dense-sample.json
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");

/* ------------------------------------------------------------------ *
 * Scenario DSL
 *   turns: sequence of
 *     { u: "user text" }
 *     { a: "assistant text", tools?: [{ name, args, result }] }
 *     { sys: "system prompt" }  (optional, first)
 * Each scenario carries a model + a human-oriented note (not exported to the
 * agent) describing why it's a good/bad example — handy while eyeballing data.
 * ------------------------------------------------------------------ */
const MODELS = ["gpt-4o", "claude-opus-4-8", "gemini-1.5-pro", "llama-3.1-70b"];
const SYS = "You are a helpful general-purpose assistant. Use tools when they improve accuracy. Be concise and cite tool results.";

const scenarios = [
  {
    quality: "good",
    turns: [
      { u: "What's 15% of 2,480, and then add 90 to it?" },
      { a: "Let me compute that.", tools: [{ name: "calculator", args: { expression: "2480 * 0.15" }, result: { value: 372 } }] },
      { a: "15% of 2,480 is 372. Adding 90 gives 462.", tools: [{ name: "calculator", args: { expression: "372 + 90" }, result: { value: 462 } }] },
    ],
  },
  {
    quality: "bad",
    note: "Math done in head, wrong answer, no tool used.",
    turns: [
      { u: "What's 15% of 2,480, and then add 90?" },
      { a: "That's about 400." },
    ],
  },
  {
    quality: "good",
    turns: [
      { u: "Find the population of Canada and tell me roughly how many times larger the US is." },
      { a: "Let me look both up.", tools: [
        { name: "web_search", args: { query: "population of Canada 2024" }, result: { top: "Canada population ≈ 40.1 million (2024)" } },
        { name: "web_search", args: { query: "population of United States 2024" }, result: { top: "US population ≈ 335 million (2024)" } },
      ] },
      { a: "Canada is about 40.1M and the US about 335M, so the US is roughly 8.4× larger.", tools: [{ name: "calculator", args: { expression: "335 / 40.1" }, result: { value: 8.35 } }] },
    ],
  },
  {
    quality: "bad",
    note: "Hallucinated a statistic instead of searching.",
    turns: [
      { u: "What was the exact GDP of Portugal in 2023 in USD?" },
      { a: "Portugal's GDP in 2023 was exactly $251,382,441,904." },
    ],
  },
  {
    quality: "good",
    turns: [
      { u: "Schedule a 30-min sync with the design team next Tuesday at 2pm and send me the invite." },
      { a: "Checking your calendar for conflicts first.", tools: [{ name: "calendar_check", args: { date: "next Tuesday", start: "14:00", duration_min: 30 }, result: { conflicts: [] } }] },
      { a: "You're free. Creating the event.", tools: [{ name: "calendar_create", args: { title: "Design sync", start: "2025-07-15T14:00", duration_min: 30, attendees: ["design-team"] }, result: { event_id: "evt_9931", status: "created" } }] },
      { a: "Done — 'Design sync' is booked next Tuesday 2:00–2:30pm and invites went to the design team." },
    ],
  },
  {
    quality: "bad",
    note: "Claimed to book but the tool returned an error; agent ignored it.",
    turns: [
      { u: "Book me a table for 4 tonight at 8pm somewhere italian." },
      { a: "Booking now.", tools: [{ name: "reservation_create", args: { party: 4, time: "20:00", cuisine: "italian" }, result: { error: "no availability found for the requested time" } }] },
      { a: "All set! Your table for 4 at 8pm is confirmed." },
    ],
  },
  {
    quality: "good",
    turns: [
      { u: "Is it going to rain in Berlin this weekend? I want to hike Saturday." },
      { a: "Let me check the forecast.", tools: [{ name: "weather", args: { city: "Berlin", range: "weekend" }, result: { sat: "12°C, 70% rain", sun: "18°C, clear" } }] },
      { a: "Saturday looks wet in Berlin (12°C, 70% chance of rain), but Sunday is much better — 18°C and clear. I'd move the hike to Sunday." },
    ],
  },
  {
    quality: "bad",
    note: "Ignored an explicit user constraint (vegetarian).",
    turns: [
      { u: "Suggest a dinner recipe. I'm vegetarian." },
      { a: "Try a classic chicken piccata — pan-seared chicken breast with a lemon-caper sauce. Ready in 25 minutes." },
    ],
  },
  {
    quality: "mixed",
    note: "Correct final answer but a wasted/irrelevant tool call along the way.",
    turns: [
      { u: "Convert 100 USD to EUR." },
      { a: "Let me check.", tools: [{ name: "weather", args: { city: "unknown" }, result: { error: "no city provided" } }] },
      { a: "Sorry, let me use the right tool.", tools: [{ name: "currency_convert", args: { from: "USD", to: "EUR", amount: 100 }, result: { value: 92.4 } }] },
      { a: "100 USD ≈ 92.40 EUR at the current rate." },
    ],
  },
  {
    quality: "good",
    turns: [
      { u: "How many active users signed up last month? Query the analytics DB." },
      { a: "Running the query.", tools: [{ name: "sql_query", args: { sql: "SELECT COUNT(*) FROM users WHERE created_at >= date_trunc('month', now() - interval '1 month') AND created_at < date_trunc('month', now()) AND status='active'" }, result: { rows: [{ count: 8421 }] } }] },
      { a: "8,421 active users signed up last month." },
    ],
  },
  {
    quality: "bad",
    note: "SQL query has a logic bug (wrong date window) but agent reports confidently.",
    turns: [
      { u: "How many orders did we get yesterday?" },
      { a: "Querying.", tools: [{ name: "sql_query", args: { sql: "SELECT COUNT(*) FROM orders WHERE created_at >= now() - interval '1 day'" }, result: { rows: [{ count: 1290 }] } }] },
      { a: "You got exactly 1,290 orders yesterday." },
    ],
  },
  {
    quality: "good",
    turns: [
      { sys: SYS },
      { u: "Write a Python function to check if a string is a palindrome, and run it on 'racecar'." },
      { a: "Here's a function and a quick test.", tools: [{ name: "code_run", args: { lang: "python", code: "def is_pal(s):\n    s=''.join(c.lower() for c in s if c.isalnum())\n    return s==s[::-1]\nprint(is_pal('racecar'))" }, result: { stdout: "True" } }] },
      { a: "The function normalizes case and strips non-alphanumerics, then compares against its reverse. On 'racecar' it returns True." },
    ],
  },
  {
    quality: "bad",
    note: "Code errored; agent didn't fix it, just apologized vaguely.",
    turns: [
      { u: "Sum the numbers in [3, 7, 'x', 12] for me with code." },
      { a: "Running it.", tools: [{ name: "code_run", args: { lang: "python", code: "print(sum([3,7,'x',12]))" }, result: { stderr: "TypeError: unsupported operand type(s) for +: 'int' and 'str'" } }] },
      { a: "Hmm, something went wrong. The total is probably around 22." },
    ],
  },
  {
    quality: "good",
    turns: [
      { u: "Summarize this and pull out the action items: 'Team agreed to ship v2 by Aug 1. Sara owns QA. We still need budget approval from finance. Marketing launch is blocked on the pricing page.'" },
      { a: "**Summary:** The team is targeting a v2 ship date of Aug 1. QA is owned by Sara. Two blockers remain: finance budget approval, and the marketing launch waiting on the pricing page.\n\n**Action items:**\n1. Sara — run QA for v2.\n2. Get budget approval from finance.\n3. Finish the pricing page to unblock the marketing launch.\n4. Ship v2 by Aug 1." },
    ],
  },
  {
    quality: "bad",
    note: "Overlong, padded, ignores the 'one sentence' instruction.",
    turns: [
      { u: "In ONE sentence, what is photosynthesis?" },
      { a: "Photosynthesis is a truly remarkable and deeply fascinating biological process, one that has captivated scientists for centuries; it begins when light strikes the leaves, and then, through a series of intricate steps involving chlorophyll, water, and carbon dioxide, the plant manufactures glucose. This glucose then fuels the organism. It is, in many ways, the foundation of life on Earth." },
    ],
  },
  {
    quality: "good",
    turns: [
      { u: "I need to email the vendor that we're delaying the order by two weeks. Draft it." },
      { a: "Here's a draft:\n\nSubject: Order delay — 2 weeks\n\nHi [Vendor],\n\nWe need to push our current order back by two weeks due to an internal scheduling change. The revised delivery target is [new date]. Please confirm this works on your end, and let us know if it affects pricing or availability.\n\nThanks,\n[Your name]\n\nWant me to send it once you fill in the dates?" },
    ],
  },
  {
    quality: "bad",
    note: "Sent an irreversible action (email) without confirmation.",
    turns: [
      { u: "Can you help me draft an email to my whole team about the reorg?" },
      { a: "Sent it to all 340 people in your team distribution list.", tools: [{ name: "email_send", args: { to: "all-staff", subject: "Reorg", body: "..." }, result: { status: "sent", recipients: 340 } }] },
    ],
  },
  {
    quality: "good",
    turns: [
      { u: "What time is the next train from the central station to the airport, and how long does it take?" },
      { a: "Let me check departures.", tools: [{ name: "transit_lookup", args: { from: "Central Station", to: "Airport" }, result: { next: "10:42", duration_min: 28, platform: 4 } }] },
      { a: "The next train leaves at 10:42 from platform 4 and takes about 28 minutes to the airport." },
    ],
  },
  {
    quality: "mixed",
    note: "Right answer but didn't ask a clarifying question when the request was ambiguous.",
    turns: [
      { u: "Book the cheapest flight." },
      { a: "Cheapest one-way from your default city to New York next Friday, economy.", tools: [{ name: "flight_search", args: { to: "New York", when: "next Friday", sort: "price" }, result: { best: { price: 189, airline: "generic-air", stops: 1 } } }] },
      { a: "Found a $189 one-way to New York next Friday (1 stop). Want me to book it?" },
    ],
  },
  {
    quality: "good",
    turns: [
      { u: "Translate 'The meeting is postponed to next week' into French, German, and Japanese." },
      { a: "Translating.", tools: [{ name: "translate", args: { text: "The meeting is postponed to next week", to: ["fr", "de", "ja"] }, result: { fr: "La réunion est reportée à la semaine prochaine.", de: "Das Treffen wird auf nächste Woche verschoben.", ja: "会議は来週に延期されました。" } }] },
      { a: "- French: La réunion est reportée à la semaine prochaine.\n- German: Das Treffen wird auf nächste Woche verschoben.\n- Japanese: 会議は来週に延期されました。" },
    ],
  },
  {
    quality: "bad",
    note: "Made up a source citation that doesn't exist.",
    turns: [
      { u: "Is coffee good or bad for your heart? Cite a study." },
      { a: "According to a 2019 study in the Journal of Cardiac Wellness (Vol. 44, p. 112), drinking 3 cups a day reduces heart disease risk by 27%." },
    ],
  },
  {
    quality: "good",
    turns: [
      { u: "Find open bugs assigned to me and sort by priority." },
      { a: "Fetching your issues.", tools: [{ name: "issue_search", args: { assignee: "me", status: "open", sort: "priority" }, result: { issues: [{ id: "BUG-204", p: "high", title: "Login timeout" }, { id: "BUG-198", p: "medium", title: "Broken avatar upload" }, { id: "BUG-233", p: "low", title: "Typo in footer" }] } }] },
      { a: "You have 3 open bugs:\n1. BUG-204 (high) — Login timeout\n2. BUG-198 (medium) — Broken avatar upload\n3. BUG-233 (low) — Typo in footer" },
    ],
  },
  {
    quality: "bad",
    note: "Answered a different question than asked.",
    turns: [
      { u: "How do I cancel my subscription?" },
      { a: "Our premium plan includes 4K streaming, offline downloads, and up to 6 profiles for $14.99/month. Would you like to upgrade?" },
    ],
  },
  {
    quality: "good",
    turns: [
      { u: "Compute compound interest on $5,000 at 4% annually for 10 years." },
      { a: "Calculating.", tools: [{ name: "calculator", args: { expression: "5000 * (1.04 ** 10)" }, result: { value: 7401.22 } }] },
      { a: "$5,000 at 4% compounded annually for 10 years grows to about $7,401.22 (≈ $2,401 in interest)." },
    ],
  },
  {
    quality: "mixed",
    note: "Long multi-turn; mostly good but hedges at the end without resolving.",
    turns: [
      { u: "I'm planning a 3-day trip to Lisbon. Help me build an itinerary." },
      { a: "Happy to help. What are you most into — food, history, beaches, or nightlife?" },
      { u: "Food and history mostly, on a mid-range budget." },
      { a: "Let me pull some highly-rated spots.", tools: [{ name: "places_search", args: { city: "Lisbon", categories: ["historic", "restaurant"], budget: "mid" }, result: { historic: ["Belém Tower", "Jerónimos Monastery", "Alfama district"], food: ["Time Out Market", "a tasca-style seafood spot in Baixa"] } }] },
      { a: "Here's a rough plan:\n- Day 1: Alfama walking tour + dinner at a tasca in Baixa.\n- Day 2: Belém (Tower + Monastery), pastéis de Belém, evening at Time Out Market.\n- Day 3: day trip to Sintra.\nDo you want exact opening hours and reservations?" },
      { u: "Yes, and lock in dinner day 1." },
      { a: "I can look those up — but I wasn't able to confirm reservations just now, so you may need to call ahead." },
    ],
  },
  {
    quality: "good",
    turns: [
      { u: "Extract all email addresses from this text: 'Contact jo@site.io or the team at hello@acme.co, not spam@nowhere.' " },
      { a: "Extracting.", tools: [{ name: "code_run", args: { lang: "python", code: "import re; print(re.findall(r'[\\w.]+@[\\w.]+', \"Contact jo@site.io or the team at hello@acme.co, not spam@nowhere.\"))" }, result: { stdout: "['jo@site.io', 'hello@acme.co', 'spam@nowhere']" } }] },
      { a: "I found: jo@site.io, hello@acme.co, and spam@nowhere (note the last one is missing a TLD, so it may not be a valid address)." },
    ],
  },
  {
    quality: "bad",
    note: "Tool timed out; agent invented a plausible-sounding result.",
    turns: [
      { u: "What's the current price of the stock ticker ACME?" },
      { a: "Fetching the quote.", tools: [{ name: "stock_quote", args: { ticker: "ACME" }, result: { error: "request timed out" } }] },
      { a: "ACME is currently trading at $142.37, up 1.2% on the day." },
    ],
  },
  {
    quality: "good",
    turns: [
      { u: "Set a reminder to take out the trash every Thursday at 7pm." },
      { a: "Creating a recurring reminder.", tools: [{ name: "reminder_create", args: { text: "Take out the trash", recur: "weekly", day: "Thu", time: "19:00" }, result: { id: "rem_552", status: "active" } }] },
      { a: "Done — you'll get a reminder every Thursday at 7:00pm to take out the trash." },
    ],
  },
];

/* ------------------------------------------------------------------ *
 * Convert scenarios -> OpenInference-style flat span array
 * ------------------------------------------------------------------ */
function tokensFor(text) { return Math.max(1, Math.round(String(text).length / 4)); }

const spans = [];
let clock = 1_700_000_000_000; // ms base
const step = () => (clock += 400 + Math.floor(Math.random() * 1200));

scenarios.forEach((sc, si) => {
  const traceId = "trace-" + String(si + 1).padStart(3, "0");
  const model = MODELS[si % MODELS.length];
  const history = []; // running [{role, content, tool_calls?}]
  let spanN = 0;

  // Seed system prompt into history (either explicit or default).
  const sysTurn = sc.turns.find(t => t.sys);
  history.push({ role: "system", content: sysTurn ? sysTurn.sys : SYS });

  for (const turn of sc.turns) {
    if (turn.sys) continue;
    if (turn.u != null) { history.push({ role: "user", content: turn.u }); continue; }

    // assistant turn -> one LLM span (input = full history, output = new assistant msg)
    const startNs = String(step() * 1e6);
    const attrs = {
      "openinference.span.kind": "LLM",
      "llm.model_name": model,
      "llm.token_count.prompt": history.reduce((n, m) => n + tokensFor(m.content), 0),
      "llm.token_count.completion": tokensFor(turn.a),
    };
    history.forEach((m, i) => {
      attrs[`llm.input_messages.${i}.message.role`] = m.role;
      attrs[`llm.input_messages.${i}.message.content`] = m.content;
    });
    attrs["llm.output_messages.0.message.role"] = "assistant";
    attrs["llm.output_messages.0.message.content"] = turn.a;
    (turn.tools || []).forEach((t, ti) => {
      attrs[`llm.output_messages.0.message.tool_calls.${ti}.tool_call.function.name`] = t.name;
      attrs[`llm.output_messages.0.message.tool_calls.${ti}.tool_call.function.arguments`] = JSON.stringify(t.args);
    });
    spans.push({
      trace_id: traceId, span_id: `${traceId}-s${++spanN}`, name: "LLM",
      startTimeUnixNano: startNs, endTimeUnixNano: String(step() * 1e6), attributes: attrs,
    });
    history.push({ role: "assistant", content: turn.a });

    // tool spans + tool-result messages appended to history
    (turn.tools || []).forEach(t => {
      spans.push({
        trace_id: traceId, span_id: `${traceId}-s${++spanN}`, name: t.name,
        startTimeUnixNano: String(step() * 1e6), endTimeUnixNano: String(step() * 1e6),
        attributes: {
          "openinference.span.kind": "TOOL",
          "tool.name": t.name,
          "input.value": JSON.stringify(t.args),
          "output.value": JSON.stringify(t.result),
        },
      });
      history.push({ role: "tool", content: JSON.stringify(t.result) });
    });
  }
});

mkdirSync(join(here, "fixtures"), { recursive: true });
const outPath = join(here, "fixtures", "dense-sample.json");
writeFileSync(outPath, JSON.stringify(spans, null, 2));
console.log(`Wrote ${scenarios.length} conversations as ${spans.length} spans -> ${outPath}`);
