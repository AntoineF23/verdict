// Pure statistics for judge evaluation: confusion matrix, derived rates, and a
// deterministic stratified train/test split. No DOM, no network, no Date, no
// Math.random — everything is a function of its inputs (splits use a seeded PRNG).
import type { Metrics } from "./types";

export interface Confusion {
  tp: number;
  fp: number;
  tn: number;
  fn: number;
}

/**
 * Count a confusion matrix from paired human/LLM boolean labels.
 * tp: human && llm, fp: !human && llm, fn: human && !llm, tn: !human && !llm.
 */
export function confusion(pairs: { human: boolean; llm: boolean }[]): Confusion {
  const cm: Confusion = { tp: 0, fp: 0, tn: 0, fn: 0 };
  for (const p of pairs) {
    if (p.human && p.llm) cm.tp++;
    else if (!p.human && p.llm) cm.fp++;
    else if (p.human && !p.llm) cm.fn++;
    else cm.tn++;
  }
  return cm;
}

/** Divide guarding against a zero denominator (returns 0 instead of NaN/Infinity). */
const div = (num: number, den: number): number => (den === 0 ? 0 : num / den);

/** Derive rates + Cohen's kappa from a confusion matrix. All divide-by-zero → 0. */
export function rates(cm: Confusion): Metrics {
  const { tp, fp, tn, fn } = cm;
  const total = tp + fp + tn + fn;

  const tpr = div(tp, tp + fn);
  const tnr = div(tn, tn + fp);
  const precision = div(tp, tp + fp);
  const f1 = div(2 * precision * tpr, precision + tpr);
  const accuracy = div(tp + tn, total);

  // Cohen's kappa: chance-corrected agreement between human and LLM labels.
  const po = accuracy;
  const pe = div((tp + fn) * (tp + fp) + (fn + tn) * (fp + tn), total * total);
  const kappa = div(po - pe, 1 - pe);

  return {
    tp,
    fp,
    tn,
    fn,
    tpr,
    tnr,
    precision,
    f1,
    accuracy,
    kappa,
    support: { positives: tp + fn, negatives: tn + fp, total },
  };
}

/** Compose confusion + rates over paired labels. */
export function metricsFromPairs(pairs: { human: boolean; llm: boolean }[]): Metrics {
  return rates(confusion(pairs));
}

/** Small seeded PRNG (mulberry32). Deterministic for a given 32-bit seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** In-place Fisher–Yates shuffle driven by a seeded PRNG. Returns the array. */
function shuffle<T>(arr: T[], rand: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

/**
 * Deterministic stratified train/test split. Positives and negatives are
 * shuffled independently with the seeded PRNG, then round(n*testRatio) of each
 * stratum goes to `test` and the rest to `train`, preserving class balance.
 */
export function splitStratified<T>(
  items: T[],
  isPositive: (t: T) => boolean,
  testRatio: number,
  seed: number,
): { train: T[]; test: T[] } {
  const rand = mulberry32(seed);
  const positives: T[] = [];
  const negatives: T[] = [];
  for (const it of items) (isPositive(it) ? positives : negatives).push(it);

  shuffle(positives, rand);
  shuffle(negatives, rand);

  const train: T[] = [];
  const test: T[] = [];
  for (const stratum of [positives, negatives]) {
    const nTest = Math.round(stratum.length * testRatio);
    for (let i = 0; i < stratum.length; i++) {
      (i < nTest ? test : train).push(stratum[i]);
    }
  }
  return { train, test };
}
