# Verdict — human-grounded evaluation for AI features

**Verdict is a local-first tool for judging whether your AI feature's outputs are actually
good.** Load the traces from any AI agent, chatbot, or LLM feature; review each conversation and
mark it **Pass / Fail** with a comment; discover *what kinds* of failures happen (grounded-theory
error coding); then build and **validate an LLM-as-judge** against your human labels — and export
that judge to monitor quality in production.

No backend, no accounts, no data leaving your machine (unless you choose to call an LLM API).
It runs as a single self-contained web page.

> **Why this exists.** Shipping an AI feature and eyeballing a few outputs ("vibe checks") doesn't
> tell you if it's good, or *how* it fails, or whether it's getting better. Real evaluation is a
> loop: **look at your data → label it → find the failure modes → measure them → automate the
> measurement**. Verdict is a purpose-built tool for running that loop.

---

## Credit & inspiration

This tool is heavily inspired by **[Hamel Husain](https://hamel.dev/)**'s work on AI evaluations —
in particular the approach of *looking at your data*, doing **error analysis** with open/axial
coding, and only trusting an **LLM-as-judge once it agrees with human labels** (measured with true
positive / true negative rates). If you want the theory behind this tool, watch:

📺 **[AI Evals Crash Course in 50 minutes (Hamel Husain)](https://creatoreconomy.so/p/ai-evaluations-crash-course-in-50-minutes-hamel-husain)**

Verdict is an independent, unaffiliated implementation of these ideas as a hands-on tool.

---

## The evaluation loop (the mental model)

```
   ┌─────────────────────────────────────────────────────────────┐
   │  1. LOOK      Read real traces from your AI feature           │
   │  2. LABEL     Pass / Fail + a comment on each                 │
   │  3. CODE      Tag *why* each failure happened (open coding)   │
   │  4. CLUSTER   Group those tags into failure categories (axial)│
   │  5. JUDGE     Build an LLM judge per category                 │
   │  6. VALIDATE  Does the judge agree with humans? (TPR/TNR, κ)   │
   │  7. SHIP      Export the trusted judge → monitor production    │
   └─────────────────────────────────────────────────────────────┘
                 ▲                                        │
                 └────────  iterate as you learn  ◀───────┘
```

Steps 1–4 are **human** work (Verdict makes them fast). Steps 5–7 let you **scale** that judgment
to conversations no human has time to read — but only after the judge has proven it matches your
reviewers.

---

## What Verdict does

- **Reads traces from anything.** Format-agnostic ingest: OpenTelemetry (OTLP) exports,
  OpenInference / `gen_ai` / OpenLLMetry spans, Langfuse exports, plain `[{role, content}]`
  conversations, NDJSON, and a graceful fallback that renders *any* JSON as a gradable timeline.
- **Renders conversations, not raw JSON.** A clean chat timeline: user / assistant messages and
  tool calls with collapsible inputs/outputs — with a "show raw" escape hatch on every step.
- **Fast human review.** A queue with progress + filters, Pass/Fail + comment, and keyboard
  shortcuts built for blitzing through hundreds of conversations. Autosaves to your browser.
- **Grounded-theory error analysis.** Add free-text **open codes** to failures, then have an LLM
  **axial-code** them into a failure taxonomy with per-category counts.
- **LLM-as-judge, validated.** One binary judge per failure category, each with a tunable, versioned
  prompt and a model you choose. Validate against your human labels with a **train/test split** and
  a full **confusion matrix + TPR / TNR / precision / F1 / accuracy / Cohen's κ**. Export the judge
  (prompt + model + metrics) to run in production.
- **Anonymization.** Redact PII (emails, phones, IPs, URLs, cards, IBANs, plus a name/company
  heuristic and your own term list) in the timeline, exports, and everything sent to an LLM.
- **Local-first & private.** Everything runs in the browser; feedback lives in `localStorage` and
  exports to CSV/JSON. The only network calls are the optional LLM API requests *you* trigger.

---

## Quick start

**Just use it (no install):** open the GitHub Pages URL for this repo, or download the built
`dist/index.html` and double-click it — it's a single self-contained file that works offline.

**Run from source:**
```bash
npm install
npm run dev        # dev server with hot reload
npm run build      # -> dist/index.html (one self-contained file)
npm test           # unit + DOM tests
npm run typecheck
```

**Try it immediately with the included sample data** (see [Sample data](#sample-data-try-it-now)).

---

## Tutorial for Product Managers: assess the quality of any AI feature

You don't need to be technical to run a real evaluation. This walkthrough uses the **bundled
100-conversation demo** so you can do the whole loop in ~20 minutes, then repeat it on your own
feature's traces.

### 0. Get some traces
An AI feature (agent, chatbot, RAG assistant, classifier…) produces **conversations/outputs**. Your
engineers can usually export these as JSON from your observability stack (OpenTelemetry, Langfuse,
Arize/Phoenix, LangSmith, or a plain log). Verdict reads all of these. **No export yet? Use the
demo files** — `test-files/demo-100-conversations.json` and `test-files/demo-100-feedback.json`.

### 1. Look at your data (the most important step)
Open Verdict → **Load export** → pick `demo-100-conversations.json`. Read a few conversations end to
end. Hamel's #1 rule: *look at your data.* You'll immediately start noticing patterns — the agent
makes things up, ignores instructions, mishandles tools, etc.

### 2. Label Pass / Fail + a comment
For each conversation decide: **did the AI do its job?** Hit **Pass** or **Fail** and write a short
comment on *why*. Keep it binary — "good enough to ship to a user?" — resist 1–5 scales; they hide
disagreement. Speed shortcuts: `j`/`k` to move, `p`/`f` to grade, `/` to jump to the comment.
*(For the demo you can skip manual labeling and jump to step 4 by importing the ready-made labels —
see the tip below.)*

### 3. Open-code the failures (name what went wrong)
Set the queue filter to **Fail**. On each failure, add one or more short **error codes** in the
feedback bar — e.g. `hallucinated figure`, `ignored constraint`, `ignored tool error`. Invent the
words that fit; previously used codes autocomplete so wording stays consistent. This is **open
coding** — bottom-up, no predefined categories. Tick **"fully coded"** once you've captured every
problem in that conversation.

### 4. Axial-code into a failure taxonomy
Click **Analyze fails**. You'll see every distinct open code and its frequency. Now cluster them
into higher-level **failure categories**:
- **With an API key:** click **Run with API** (configure a key in ⚙ Settings first).
- **Without a key:** click **Copy prompt**, paste it into ChatGPT/Claude, and paste the JSON back.

Verdict shows the resulting categories with conversation counts; click **filter queue →** on any
category to review just those failures. *(This is "axial coding" — organizing raw codes into themes.)*

### 5. Build & validate an LLM judge per category
Click **Judges**. There's one tab per failure category. For a category:
1. Pick the **model** (any your API key unlocks).
2. Review/edit the **judge prompt** (a good default is provided).
3. Click **Validate on labeled set** — the judge labels your conversations and Verdict compares it
   to your human labels.

Read the **confusion matrix** and metrics (there's a **"How to read these numbers"** guide in the
panel). The headline number is **Cohen's κ** on the **Test split**:
- **κ ≥ 0.6** — the judge substantially agrees with your reviewers. Usable.
- **High FP** (false positives) — it over-flags; tighten the prompt.
- **High FN** (false negatives) — it misses cases; broaden the prompt.

Edit the prompt, save a **new version**, re-validate, and watch the numbers move. This is the key
discipline: **don't trust a judge until it agrees with humans on held-out data.**

### 6. Ship the judge to monitor production
Once a judge is good enough, click **Export judge** (or **Export all judges**). You get an artifact
with the exact prompt, model, and measured metrics — hand it to engineering to run on the
*thousands* of production conversations no human will read, and track your failure rate per
category over time.

### PM tips (distilled from Hamel's approach)
- **Look at data before dashboards.** Reading 30–100 real traces teaches you more than any metric.
- **Binary Pass/Fail.** It forces a real decision and makes disagreement visible.
- **One judge per failure mode**, not one mega-judge. Narrow judges are easier to validate and fix.
- **A judge is only as trustworthy as its agreement with humans.** Report TPR/TNR/κ, not vibes.
- **Watch the rare-class trap.** If a failure is rare, "95% accuracy" can mean the judge never
  catches it — look at TPR and κ, not accuracy.
- **Re-validate whenever you change the prompt or model.** Verdict clears a version's metrics when
  you edit it, so stale numbers never mislead you.

---

## Sample data (try it now)

Everything below lives in this repo so anyone can exercise the tool without their own data.

**`test-files/` — one dense, ready-to-drag sample per input format** (same conversations in
different shapes, so you can confirm they all parse identically):

| File | Format |
|------|--------|
| `01-otlp-genai.json` | OTLP export (`resourceSpans`) with `gen_ai.*` attributes |
| `02-openinference-spans.json` | Flat OpenInference span array |
| `03-langfuse-export.json` | Langfuse `{traces, observations}` |
| `04-plain-conversation.json` | A single `[{role, content}]` conversation |
| `05-array-of-conversations.json` | An array of plain conversations |
| `06-ndjson-spans.ndjson` | NDJSON — one span per line |
| `07-custom-fallback.json` | A made-up custom shape → the readable fallback |

**`test-files/demo-100-*.json` — the tutorial dataset (100 conversations):**
- `demo-100-conversations.json` — 100 agent traces
- `demo-100-feedback.json` — the matching human labels (45 fail / 55 pass) already **open-coded**
  with 12 codes across ~5 failure categories

**To run the full loop on the demo:** **Load export** → `demo-100-conversations.json`, then
**Import feedback** → `demo-100-feedback.json`. You now have coded failures — go straight to
**Analyze fails** and **Judges**. To skip the API for axial coding, paste this into *Analyze fails →
step 3*:

```json
{"categories":[
 {"name":"Fabrication","description":"Invents facts, figures, sources, or tool results.","codes":["hallucinated figure","fake citation","invented tool result"]},
 {"name":"Tool misuse","description":"Wrong tool, or ignores tool failures.","codes":["ignored tool error","wrong tool used"]},
 {"name":"Reasoning error","description":"Bad arithmetic or wrong conclusions.","codes":["math error","wrong conclusion"]},
 {"name":"Instruction following","description":"Ignores constraints, format, or the question.","codes":["ignored constraint","answered wrong question","ignored format"]},
 {"name":"Safety & refusal","description":"Over-refuses benign asks or gives unsafe advice.","codes":["over-refusal","unsafe advice"]}
]}
```

Regenerate any of these with `npm run gen:testfiles` and `node scripts/generate-demo.mjs`.

---

## Supported trace formats (auto-detected)

OTLP (`resourceSpans`) · OpenInference / `gen_ai` / OpenLLMetry spans · Langfuse exports · plain
`[{role, content}]` (with `tool_calls`) · arrays of conversations · NDJSON · and a fallback that
renders any other JSON as readable, gradable records (recovering message arrays under keys like
`messages` / `dialog` / `transcript`). A banner shows the detected format after loading, and every
step has a **"show raw"** toggle. If a field is missed, the attribute-key dictionaries at the top of
`src/parser.ts` are the place to extend.

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `j` / `k` | next / previous conversation |
| `p` / `f` | Pass / Fail (and jump to next unreviewed) |
| `/` | focus the comment box |
| `c` | focus the error-code box (on a failure) |
| `⌘/Ctrl + Enter` | save comment & jump to next unreviewed |

## API key, anonymization & judges (details)

- **⚙ Settings → LLM connection** — choose a provider (Anthropic — default, latest Claude; OpenAI;
  or any OpenAI-compatible `baseUrl`, incl. a gateway/local model), model, key, and max output
  tokens. **Security:** the key is stored in your browser's `localStorage` — fine for a reviewer
  running locally with their own key; **do not host publicly with a shared key.**
- **⚙ Settings → Anonymization / the Anonymize toggle** — redact PII with consistent placeholder
  tokens everywhere, including LLM payloads. Offline rules + a dictionary-filtered capitalized-word
  name/company heuristic + your own term/allow lists (with a "scan dataset for names" helper).
- **Judges** — one validated judge per category; see the tutorial above. Exports carry the prompt,
  model, and metrics so the judge is reproducible outside this tool.

## Exports

**CSV**: `conversation_id, verdict, comment, codes, axial_category, reviewed_at, model, agent, num_steps`.
**JSON**: `{ feedback: [...], axial }` — re-importable to resume, restoring codes and the taxonomy.

---

## Project structure

```
index.html            app shell (markup)
src/
  app.ts              state, rendering, DOM wiring
  parser.ts           format-agnostic trace parser — pure, no DOM  (unit-tested)
  coding.ts           open → axial coding logic — pure             (unit-tested)
  judge.ts            judge prompt / verdict / run / export         (unit-tested)
  metrics.ts          confusion matrix, TPR/TNR/precision/F1/κ, split (unit-tested)
  anonymize.ts        PII detection + redaction — pure             (unit-tested)
  llm.ts              configurable browser LLM client              (unit-tested, mocked fetch)
  dict.ts             common-word dictionary for the name heuristic
  types.ts            shared types · styles.css  theme + design
test/                 Vitest suites + a jsdom app smoke test
scripts/              sample-data generators
fixtures/ test-files/ sample exports (see above)
```

Built with **Vite + TypeScript**; the risky logic (parsing, coding, metrics, judging) is pure and
fully unit-tested, and `npm run build` inlines everything into one offline `dist/index.html`.

## Deploying

`.github/workflows/deploy.yml` publishes `dist/` to **GitHub Pages** on every push to `main` (enable
Pages → "GitHub Actions" in repo settings). `.github/workflows/ci.yml` runs typecheck + tests +
build on every push and PR.

## Contributing

Issues and PRs welcome. Keep parsing/coding/metrics/judge logic pure (no DOM) so it stays testable,
put DOM/rendering in `app.ts`, and add a test for any new format or behavior. Keep CI green:
`npm run typecheck && npm test && npm run build`.

## License

MIT — see [LICENSE](LICENSE). Inspired by the AI-evaluation methodology of Hamel Husain; not
affiliated with or endorsed by him.
