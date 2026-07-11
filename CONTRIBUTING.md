# Contributing to Verdict

Thanks for helping improve Verdict. Issues and pull requests are welcome, whether it is a bug fix,
a new trace format, a better judge prompt, docs, or design.

## Getting started

```bash
npm install
npm run dev        # local dev server with hot reload
npm test           # Vitest unit tests + a jsdom smoke test
npm run typecheck  # tsc, no emit
npm run build      # produces dist/index.html (one offline file)
```

Open the dev URL, load a file from `test-files/`, and you are running the app.

## How the code is organized

The guiding rule: **pure logic has no DOM, so it can be unit tested.** UI and wiring live in one
place.

* `src/parser.ts` — turns any trace export into a normalized conversation model. Pure.
* `src/coding.ts` — open and axial coding logic. Pure.
* `src/metrics.ts` — confusion matrix, TPR, TNR, precision, F1, accuracy, Cohen's kappa, and the
  stratified train/test split. Pure.
* `src/judge.ts` — judge prompt building, verdict parsing, running a judge over a set, and export.
  Pure except the injected `complete` function.
* `src/anonymize.ts` — PII detection and redaction. Pure.
* `src/llm.ts` — the browser LLM client (the only code that touches the network).
* `src/app.ts` — state, rendering, and all DOM wiring. This is the one impure module.

If you add behavior, put the logic in a pure module and the wiring in `app.ts`.

## Common contributions

* **Support a new trace format.** Extend `detectAndNormalize` in `src/parser.ts` (and the attribute
  key dictionaries at the top). Add a fixture in `fixtures/` and a case in `test/parser.test.ts`.
* **Improve PII detection.** Edit `src/anonymize.ts` and add cases to `test/anonymize.test.ts`.
* **Improve a metric or the default judge prompt.** Edit `src/metrics.ts` or `src/judge.ts` with a
  matching test.

## Pull request checklist

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes (add or update tests for your change)
- [ ] `npm run build` succeeds
- [ ] No em dashes in docs (the project style keeps prose plain)
- [ ] New pure logic lives in a pure module with a test; DOM code stays in `app.ts`

CI runs all three checks on every pull request, so match them locally first.

## Reporting bugs and ideas

Use the issue templates. For parsing bugs, a small anonymized sample that reproduces the problem is
the fastest path to a fix.

## Design and philosophy

Verdict follows the evaluation approach taught by Hamel Husain: look at your data, do error
analysis, and only trust an LLM judge once it agrees with human reviewers. Contributions that make
that loop faster or more honest are especially welcome.
