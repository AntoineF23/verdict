# Verdict

[![CI](https://github.com/AntoineF23/verdict/actions/workflows/ci.yml/badge.svg)](https://github.com/AntoineF23/verdict/actions/workflows/ci.yml)
[![Live demo](https://img.shields.io/badge/live%20demo-online-3E5641)](https://antoinef23.github.io/verdict/)
[![License: MIT](https://img.shields.io/badge/license-MIT-004D61)](LICENSE)
[![Built with Vite + TypeScript](https://img.shields.io/badge/built%20with-Vite%20%2B%20TypeScript-822659)](https://vitejs.dev/)

**Verdict is a local, open source tool for evaluating AI features.** Load the traces from any AI
agent, chatbot, RAG assistant, or LLM feature. Review each conversation and mark it **Pass or
Fail** with a comment. Discover *what kinds* of failures happen with grounded theory error
analysis. Then build and **validate an LLM as a judge** against your human labels, and export that
judge to monitor quality in production.

Everything runs in your browser. No backend, no accounts, and no data leaves your machine unless
you choose to call an LLM API. Ship it as a single web page that works offline.

**Live demo:** https://antoinef23.github.io/verdict/

> Why this exists: shipping an AI feature and eyeballing a few outputs (the "vibe check") does not
> tell you if it is good, how it fails, or whether it is improving. Real evaluation is a loop. You
> look at your data, label it, find the failure modes, measure them, then automate the measurement
> with a judge you have proven trustworthy. Verdict is a purpose built tool for running that loop.

## Credit and inspiration

This tool is heavily inspired by the AI evaluation methodology of **Hamel Husain**. The core ideas
come straight from his teaching: look at your data, run error analysis with open and axial coding,
and only trust an LLM judge once it has been shown to agree with human reviewers (measured with
true positive and true negative rates). If you want the theory behind Verdict, watch:

**AI Evals Crash Course in 50 minutes (Hamel Husain):**
https://creatoreconomy.so/p/ai-evaluations-crash-course-in-50-minutes-hamel-husain

Verdict is an independent implementation of these ideas. It is not affiliated with or endorsed by
Hamel Husain.

## The evaluation loop

1. **Look.** Read real traces from your AI feature.
2. **Label.** Mark each conversation Pass or Fail and write a short comment.
3. **Code.** Tag *why* each failure happened with short free text codes (open coding).
4. **Cluster.** Group those codes into failure categories (axial coding).
5. **Judge.** Build one LLM judge per failure category.
6. **Validate.** Prove the judge agrees with humans (confusion matrix, TPR, TNR, Cohen's kappa).
7. **Ship.** Export the trusted judge and run it on production traffic no human has time to read.

Steps 1 to 4 are human work, and Verdict makes them fast. Steps 5 to 7 let you scale that judgment
to conversations no human will read, but only after the judge has proven it matches your reviewers.

## What Verdict does

* **Reads traces from anything.** Format agnostic ingest: OpenTelemetry (OTLP) exports,
  OpenInference and gen_ai and OpenLLMetry spans, Langfuse exports, plain `[{role, content}]`
  conversations, NDJSON, and a fallback that renders any other JSON as a gradable timeline.
* **Renders conversations, not raw JSON.** A clean chat timeline with user and assistant messages
  and tool calls (collapsible inputs and outputs), plus a "show raw" toggle on every step.
* **Fast human review.** A queue with progress and filters, Pass or Fail plus a comment, and
  keyboard shortcuts built for moving through hundreds of conversations. Autosaves to your browser.
* **Grounded theory error analysis.** Add free text open codes to failures, then have an LLM
  cluster them into a failure taxonomy with per category counts.
* **LLM as a judge, validated.** One binary judge per failure category, each with a tunable,
  versioned prompt and a model you choose. Validate against your human labels with a train and test
  split and a full confusion matrix (TPR, TNR, precision, F1, accuracy, Cohen's kappa). Export the
  judge with its prompt, model, and metrics to run in production.
* **Anonymization.** Redact PII (emails, phones, IPs, URLs, cards, IBANs, plus a name and company
  heuristic and your own term list) in the timeline, in exports, and in everything sent to an LLM.
* **Local and private.** Everything runs in the browser. Feedback lives in local storage and
  exports to CSV or JSON. The only network calls are the optional LLM API requests you trigger.

## Quick start

Just use it, no install: open the live demo above, or download the built `dist/index.html` and open
it in any browser. It is one file and works offline.

Run from source:

```bash
npm install
npm run dev        # dev server with hot reload
npm run build      # produces dist/index.html, one self contained file
npm test           # unit and DOM tests
npm run typecheck
```

Try it right away with the bundled sample data (see [Sample data](#sample-data)).

## How the LLM judge is evaluated (the important part)

The whole point of a judge is to replace a human reviewer on data no human will read. That is only
safe if you can **prove the judge labels almost as well as a human**. Verdict does this the way any
classifier is evaluated: it treats your human labels as ground truth, has the judge label the same
conversations, and compares the two.

### Ground truth

Every conversation on this platform is labeled by a human. For a given failure category X, a
conversation is a **positive** if the reviewer's codes map to category X, and a **negative**
otherwise. The "fully coded" checkbox lets you mark a failure as exhaustively coded, so its
negatives for other categories are trustworthy.

### The confusion matrix

For one category, compare each conversation's human label to the judge's label. Every conversation
falls into one of four cells:

|                | Judge says YES | Judge says NO |
| -------------- | -------------- | ------------- |
| **Human YES**  | TP             | FN            |
| **Human NO**   | FP             | TN            |

* **TP** (true positive): both agree the failure is present.
* **TN** (true negative): both agree it is absent.
* **FP** (false positive): the judge flagged it, the human did not. The judge over flags.
* **FN** (false negative): the judge missed one the human caught. The judge under flags.

### The metrics

```
TPR (recall, sensitivity) = TP / (TP + FN)
TNR (specificity)         = TN / (TN + FP)
Precision                 = TP / (TP + FP)
F1                        = 2 * Precision * TPR / (Precision + TPR)
Accuracy                  = (TP + TN) / (TP + FP + FN + TN)
```

* **TPR** is the share of real failures the judge catches. Low TPR means it misses failures.
* **TNR** is the share of clean conversations the judge correctly leaves alone. Low TNR means it
  raises false alarms.
* **Precision** is how often the judge is right when it says YES.
* **F1** is a single number balancing precision and recall.
* **Accuracy** is the overall share correct. It is misleading when a failure is rare, because a
  judge that always says NO can still score high. Do not rely on accuracy alone.

### Cohen's kappa (the headline number)

Two labelers can agree a lot just by chance, especially when one class is rare. Cohen's kappa
corrects agreement for chance, so it is the best single "is the judge good enough" number.

```
po (observed agreement) = Accuracy
pe (chance agreement)   = ( (TP + FN) * (TP + FP) + (FN + TN) * (FP + TN) ) / N^2
kappa                   = (po - pe) / (1 - pe)
```

Rough reading: below 0.4 is weak, 0.4 to 0.6 is moderate, 0.6 to 0.8 is substantial, above 0.8 is
near perfect. Aim for high kappa together with high TPR.

### Why a train and test split

If you tune the judge prompt while looking at the same conversations you score on, you overfit and
the numbers lie. Verdict splits your labeled set into a train part and a held out test part
(stratified so both keep the same balance of positives). Tune on train, and trust the **test**
numbers. Verdict reports both and clears a version's metrics whenever you edit its prompt or model,
so stale numbers never mislead you.

### The decision

When a judge reaches strong agreement on the held out test set (high kappa, high TPR, acceptable
FP), it is a trustworthy stand in for a human on that category. Export it and run it on unlabeled
production traffic. If it does not reach that bar, keep improving the prompt or model, or keep a
human in the loop for that category.

## Tutorial for product managers

You do not need to be technical to run a real evaluation. This walkthrough uses the bundled 100
conversation demo, so you can do the whole loop in about 20 minutes, then repeat it on your own
feature's traces.

**0. Get some traces.** An AI feature (agent, chatbot, RAG assistant, classifier) produces
conversations. Your engineers can usually export these as JSON from your observability stack
(OpenTelemetry, Langfuse, Arize Phoenix, LangSmith, or a plain log). Verdict reads all of these. No
export yet? Use the demo files in `test-files/`.

**1. Look at your data.** This is the most important step. Open Verdict, click **Load export**, and
pick `demo-100-conversations.json`. Read a few conversations end to end. You will start noticing
patterns immediately: the agent makes things up, ignores instructions, mishandles tools.

**2. Label Pass or Fail plus a comment.** For each conversation decide: did the AI do its job? Hit
**Pass** or **Fail** and write a short comment on why. Keep it binary. "Good enough to ship to a
user?" beats a 1 to 5 score, which hides disagreement. Shortcuts: `j` and `k` to move, `p` and `f`
to grade, `/` to jump to the comment.

**3. Open code the failures.** Set the queue filter to **Fail**. On each failure, add one or more
short error codes in the feedback bar, for example `hallucinated figure`, `ignored constraint`,
`ignored tool error`. Invent the words that fit. Previously used codes autocomplete so wording
stays consistent. Tick **fully coded** once you have captured every problem in that conversation.

**4. Axial code into a failure taxonomy.** Click **Analyze fails**. You will see every distinct code
and its frequency. Cluster them into higher level failure categories. With an API key, click **Run
with API**. Without a key, click **Copy prompt**, paste it into ChatGPT or Claude, and paste the
JSON back. Verdict shows the categories with counts. Click **filter queue** on a category to review
just those failures.

**5. Build and validate a judge per category.** Click **Judges**. There is one tab per failure
category. Pick the model, review or edit the judge prompt, and click **Validate on labeled set**.
Read the confusion matrix and metrics (there is a "How to read these numbers" guide in the panel).
The headline is Cohen's kappa on the test split. High FP means it over flags, so tighten the prompt.
High FN means it misses cases, so broaden it. Save a new version, re validate, and watch the numbers
move.

**6. Ship the judge to monitor production.** Once a judge is good enough, click **Export judge** (or
**Export all judges**). You get an artifact with the exact prompt, model, and measured metrics. Hand
it to engineering to run on the thousands of production conversations no human will read, and track
your failure rate per category over time.

### Tips distilled from Hamel Husain's approach

* Look at data before dashboards. Reading 30 to 100 real traces teaches you more than any metric.
* Use binary Pass or Fail. It forces a real decision and makes disagreement visible.
* Build one judge per failure mode, not one giant judge. Narrow judges are easier to validate and fix.
* A judge is only as trustworthy as its agreement with humans. Report TPR, TNR, and kappa, not vibes.
* Watch the rare class trap. If a failure is rare, a high accuracy can hide that the judge never
  catches it. Look at TPR and kappa.
* Re validate whenever you change the prompt or model.

## Sample data

Everything below lives in this repo, so anyone can exercise the tool without their own data.

`test-files/` has one dense, ready to drag sample per input format (the same conversations in
different shapes, so you can confirm they all parse identically):

| File | Format |
| ---- | ------ |
| `01-otlp-genai.json` | OTLP export with gen_ai attributes |
| `02-openinference-spans.json` | Flat OpenInference span array |
| `03-langfuse-export.json` | Langfuse traces and observations |
| `04-plain-conversation.json` | A single `[{role, content}]` conversation |
| `05-array-of-conversations.json` | An array of plain conversations |
| `06-ndjson-spans.ndjson` | NDJSON, one span per line |
| `07-custom-fallback.json` | A made up custom shape, shown via the readable fallback |

`test-files/demo-100-*.json` is the tutorial dataset of 100 conversations:

* `demo-100-conversations.json`: 100 agent traces.
* `demo-100-feedback.json`: the matching human labels (45 fail, 55 pass) already open coded with 12
  codes across about 5 failure categories.

To run the full loop on the demo, click **Load export** and choose `demo-100-conversations.json`,
then **Import feedback** and choose `demo-100-feedback.json`. You now have coded failures, so go
straight to **Analyze fails** and **Judges**. To skip the API for axial coding, paste this into
Analyze fails, step 3:

```json
{"categories":[
 {"name":"Fabrication","description":"Invents facts, figures, sources, or tool results.","codes":["hallucinated figure","fake citation","invented tool result"]},
 {"name":"Tool misuse","description":"Wrong tool, or ignores tool failures.","codes":["ignored tool error","wrong tool used"]},
 {"name":"Reasoning error","description":"Bad arithmetic or wrong conclusions.","codes":["math error","wrong conclusion"]},
 {"name":"Instruction following","description":"Ignores constraints, format, or the question.","codes":["ignored constraint","answered wrong question","ignored format"]},
 {"name":"Safety and refusal","description":"Over refuses benign asks or gives unsafe advice.","codes":["over-refusal","unsafe advice"]}
]}
```

Regenerate these with `npm run gen:testfiles` and `node scripts/generate-demo.mjs`.

## Supported trace formats

OTLP (resourceSpans), OpenInference and gen_ai and OpenLLMetry spans, Langfuse exports, plain
`[{role, content}]` (with tool_calls), arrays of conversations, NDJSON, and a fallback that renders
any other JSON as readable, gradable records. This includes the current OpenTelemetry GenAI
convention (`gen_ai.input.messages` and `gen_ai.output.messages` with typed `parts`, as emitted by
the Vercel AI SDK v7) as well as the older `gen_ai.prompt` and `gen_ai.completion` style. A banner shows the detected format after loading, and
every step has a "show raw" toggle. If a field is missed, extend the attribute key dictionaries at
the top of `src/parser.ts`.

## Keyboard shortcuts

| Key | Action |
| --- | ------ |
| `j` / `k` | next or previous conversation |
| `p` / `f` | Pass or Fail (and jump to next unreviewed) |
| `/` | focus the comment box |
| `c` | focus the error code box (on a failure) |
| `Cmd/Ctrl + Enter` | save comment and jump to next unreviewed |

## API key, anonymization, and judges (details)

* **Settings, LLM connection.** Choose a provider (Anthropic with the latest Claude by default,
  OpenAI, or any OpenAI compatible base URL including a gateway or local model), a model, a key, and
  a max output tokens value.

  **Is your key safe on the hosted demo?** Yes. Verdict has no backend. Your key is held in your
  browser and is sent only to the provider you configure, directly over HTTPS. Nothing is collected
  by this project or any server we run. By default the key is kept for the current session only. If
  you tick "Remember the key in this browser" it is saved to this origin's local storage so you do
  not retype it. Local storage is not encrypted, so leave that box unchecked on shared computers,
  and never host a copy of this app with a shared key baked in. If you prefer full isolation,
  download `dist/index.html` and run it offline instead of using the hosted demo.
* **Anonymization.** Redact PII with consistent placeholder tokens everywhere, including LLM
  payloads. Offline rules plus a dictionary filtered capitalized word name and company heuristic
  plus your own term and allow lists, with a "scan dataset for names" helper.
* **Judges.** One validated judge per category. See the tutorial and the evaluation section above.
  Exports carry the prompt, model, and metrics so the judge is reproducible outside this tool.

## Exports

CSV columns: `conversation_id, verdict, comment, codes, axial_category, reviewed_at, model, agent,
num_steps`. JSON: `{ feedback: [...], axial }`, which you can re import to resume, restoring codes
and the taxonomy.

## Project structure

```
index.html            app shell (markup)
src/
  app.ts              state, rendering, DOM wiring
  parser.ts           format agnostic trace parser, pure, no DOM      (unit tested)
  coding.ts           open and axial coding logic, pure               (unit tested)
  judge.ts            judge prompt, verdict, run, export               (unit tested)
  metrics.ts          confusion matrix, TPR, TNR, precision, F1, kappa, split (unit tested)
  anonymize.ts        PII detection and redaction, pure               (unit tested)
  llm.ts              configurable browser LLM client                 (unit tested, mocked fetch)
  dict.ts             common word dictionary for the name heuristic
  types.ts            shared types. styles.css theme and design
test/                 Vitest suites and a jsdom app smoke test
scripts/              sample data generators
fixtures/ test-files/ sample exports (see above)
```

Built with Vite and TypeScript. The risky logic (parsing, coding, metrics, judging) is pure and
fully unit tested, and `npm run build` inlines everything into one offline `dist/index.html`.

## Deploying

`.github/workflows/deploy.yml` publishes `dist/` to GitHub Pages on every push to main. Enable Pages
with the GitHub Actions source in repo settings. `.github/workflows/ci.yml` runs typecheck, tests,
and build on every push and pull request.

## Contributing

Issues and pull requests are welcome. Keep parsing, coding, metrics, and judge logic pure (no DOM)
so it stays testable, put DOM and rendering in `app.ts`, and add a test for any new format or
behavior. Keep CI green: `npm run typecheck && npm test && npm run build`.

## License

MIT, see [LICENSE](LICENSE). Inspired by the AI evaluation methodology of Hamel Husain. Not
affiliated with or endorsed by him.
