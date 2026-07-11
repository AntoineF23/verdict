// Pure, offline PII detection + redaction. No DOM, no network, no storage — just
// strings in, detections/tokens out — so it is trivially unit-testable and can run
// before a prompt ever leaves the browser. Detection is deliberately deterministic
// (no randomness, no clock).
import type { AnonSettings, Conversation, Detection, DetectionKind, RedactionMap, Step } from "./types";

/* ============================================================
   REGEX DETECTORS (rules)
   ============================================================ */

// Note: all these are `g`lobal; `collect()` resets lastIndex before each use.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_RE = /https?:\/\/[^\s<>()"']+/g;
const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g;
// IPv6: full form, trailing "::" compression, and mid "::" compression.
const IPV6_RE = /(?:[A-Fa-f0-9]{1,4}:){2,7}[A-Fa-f0-9]{1,4}|(?:[A-Fa-f0-9]{1,4}:){1,7}:|::(?:[A-Fa-f0-9]{1,4}:){0,6}[A-Fa-f0-9]{1,4}/g;
// IBAN: 2-letter country code + 2 check digits + 11–30 alphanumerics (uppercase).
const IBAN_RE = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g;
// Card candidate: 13–19 digits, optionally grouped by single spaces or dashes.
const CARD_RE = /\b\d(?:[ -]?\d){12,18}\b/g;
// Phone candidate: an optional +, then digits/separators. Validated afterwards to
// require a real separator (or +) and a 7–15 digit count so plain integers are skipped.
const PHONE_RE = /(?<![\d.])\+?\d[\d\s().-]{5,}\d/g;

/** Luhn checksum — used to cut random 16-digit strings that aren't real cards. */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** Run a global regex over text, pushing a Detection per (optionally validated) match. */
function collect(
  text: string,
  re: RegExp,
  kind: DetectionKind,
  out: Detection[],
  validate?: (value: string) => boolean,
): void {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const value = m[0];
    if (!validate || validate(value)) {
      out.push({ kind, start: m.index, end: m.index + value.length, value });
    }
    if (m.index === re.lastIndex) re.lastIndex++; // guard against zero-length matches
  }
}

/**
 * Regex detectors for email, phone, ip (v4/v6), url, card (Luhn-checked) and iban.
 * Returns non-overlapping detections; on overlap the earlier/longer (then higher
 * priority) match wins.
 */
export function ruleDetections(text: string): Detection[] {
  const out: Detection[] = [];

  // URL first, trimming trailing sentence punctuation off the greedy match.
  URL_RE.lastIndex = 0;
  let um: RegExpExecArray | null;
  while ((um = URL_RE.exec(text)) !== null) {
    const raw = um[0];
    const trimmed = raw.replace(/[.,;:!?)\]}'"]+$/, "");
    if (trimmed) out.push({ kind: "url", start: um.index, end: um.index + trimmed.length, value: trimmed });
    if (um.index === URL_RE.lastIndex) URL_RE.lastIndex++;
  }

  collect(text, EMAIL_RE, "email", out);
  collect(text, IPV4_RE, "ip", out);
  collect(text, IPV6_RE, "ip", out);
  collect(text, IBAN_RE, "iban", out);
  collect(text, CARD_RE, "card", out, (v) => {
    const d = v.replace(/\D/g, "");
    return d.length >= 13 && d.length <= 19 && luhnValid(d);
  });
  collect(text, PHONE_RE, "phone", out, (v) => {
    const d = v.replace(/\D/g, "");
    return d.length >= 7 && d.length <= 15 && /[+\s().-]/.test(v);
  });

  return dedupeOverlaps(out);
}

/* ============================================================
   HEURISTIC NAME / ORG DETECTION
   ============================================================ */

// Letter runs incl. accents (French names) with inner apostrophes/hyphens.
const NAME_TOKEN_RE = /[A-Za-zÀ-ÖØ-öø-ÿ]+(?:['’-][A-Za-zÀ-ÖØ-öø-ÿ]+)*/g;
const CORP_SUFFIX = new Set(["inc", "llc", "ltd", "corp", "gmbh", "sa", "sas"]);

// All-caps tokens that are decidedly NOT people/orgs and must never be flagged:
// ISO 4217 currency codes, a few crypto tickers, and ubiquitous time/measure acronyms.
// Compared case-insensitively. (Currency codes like USD/EUR were the reported false positive.)
const NON_PII_TOKENS = new Set(
  ("USD EUR GBP JPY CHF CAD AUD NZD CNY RMB HKD SGD SEK NOK DKK INR BRL MXN ZAR RUB KRW " +
   "TRY PLN CZK HUF RON BGN ILS CLP COP ARS PEN UYU AED SAR QAR KWD BHD OMR JOD THB IDR " +
   "MYR PHP VND TWD PKR BDT LKR EGP NGN GHS KES TZS MAD DZD TND ISK UAH KZT NGN " +
   "BTC ETH USDT USDC XRP " +
   "GMT UTC EST EDT CST CDT MST PST PDT CET CEST AM PM")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean),
);

interface Tok {
  value: string;
  start: number;
  end: number;
}

function isCapitalized(w: string): boolean {
  return /^[A-ZÀ-ÖØ-Þ]/.test(w);
}
function isAllCaps(w: string): boolean {
  return /[A-ZÀ-ÖØ-Þ]/.test(w) && w === w.toUpperCase();
}

/** Is the token at `start` the first word of the text or right after . ! ? or a newline? */
function isSentenceStart(text: string, start: number): boolean {
  let i = start - 1;
  while (i >= 0 && (text[i] === " " || text[i] === "\t")) i--;
  if (i < 0) return true;
  const c = text[i];
  return c === "." || c === "!" || c === "?" || c === "\n" || c === "\r";
}

/**
 * Lower-precision CANDIDATE detector: capitalized single words and consecutive
 * Capitalized Multi-Word sequences become `name` (or `org` when a corp suffix like
 * Inc/LLC/Ltd/Corp/GmbH/SA/SAS is present). Excludes sentence-initial words,
 * dictionary words, single-letter all-caps, and pure numbers (favor recall — a
 * human confirms these later).
 */
export function heuristicNameDetections(text: string, dict: Set<string>): Detection[] {
  NAME_TOKEN_RE.lastIndex = 0;
  const toks: Tok[] = [];
  let m: RegExpExecArray | null;
  while ((m = NAME_TOKEN_RE.exec(text)) !== null) {
    toks.push({ value: m[0], start: m.index, end: m.index + m[0].length });
  }

  const qualifies = (t: Tok): boolean => {
    if (!isCapitalized(t.value)) return false;
    if (dict.has(t.value.toLowerCase())) return false;
    if (NON_PII_TOKENS.has(t.value.toLowerCase())) return false; // currency codes, tickers, GMT/AM…
    if (t.value.length < 2 && isAllCaps(t.value)) return false; // stray single-letter caps ("I")
    if (isSentenceStart(text, t.start)) return false;
    return true;
  };

  const out: Detection[] = [];
  let group: Tok[] = [];
  const flush = (): void => {
    if (!group.length) return;
    const start = group[0].start;
    const end = group[group.length - 1].end;
    // A corp suffix, or a SINGLE standalone all-caps token (acronym like NASA/SNCF, or a
    // currency/ticker), is an `org` candidate — never a person. But a multi-word group is a
    // name even if a part (or all) of it is ALL-CAPS, so a capitalized surname is captured:
    // "Antoine FORNAS" and "ANTOINE FORNAS" both → name.
    const isOrg =
      group.some((t) => CORP_SUFFIX.has(t.value.toLowerCase())) ||
      (group.length === 1 && isAllCaps(group[0].value));
    out.push({ kind: isOrg ? "org" : "name", start, end, value: text.slice(start, end) });
    group = [];
  };

  for (const t of toks) {
    if (!qualifies(t)) {
      flush();
      continue;
    }
    if (group.length) {
      // Merge only when separated purely by spaces (no punctuation / newline between).
      const gap = text.slice(group[group.length - 1].end, t.start);
      if (/^ +$/.test(gap)) {
        group.push(t);
        continue;
      }
      flush();
    }
    group = [t];
  }
  flush();
  return out;
}

/* ============================================================
   USER TERM DETECTION
   ============================================================ */

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Case-insensitive whole-word matches of user-supplied terms, kind `custom`. */
export function termDetections(text: string, terms: string[]): Detection[] {
  const out: Detection[] = [];
  for (const term of terms || []) {
    const t = (term || "").trim();
    if (!t) continue;
    const re = new RegExp(`\\b${escapeRegExp(t)}\\b`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      out.push({ kind: "custom", start: m.index, end: m.index + m[0].length, value: m[0] });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  return out;
}

/* ============================================================
   MERGE / DE-OVERLAP
   ============================================================ */

// Higher wins when detections overlap on the same span. User terms and precise
// rule matches beat the lower-precision name/org heuristic.
const PRIORITY: Record<DetectionKind, number> = {
  custom: 6,
  iban: 5,
  card: 5,
  email: 5,
  url: 5,
  ip: 5,
  phone: 4,
  org: 2,
  name: 1,
};

/** Keep non-overlapping detections: earlier start, then longer, then higher priority. */
function dedupeOverlaps(dets: Detection[]): Detection[] {
  const sorted = [...dets].sort(
    (a, b) =>
      a.start - b.start ||
      b.end - b.start - (a.end - a.start) ||
      PRIORITY[b.kind] - PRIORITY[a.kind],
  );
  const kept: Detection[] = [];
  for (const d of sorted) {
    if (kept.some((k) => d.start < k.end && d.end > k.start)) continue; // overlaps a kept one
    kept.push(d);
  }
  kept.sort((a, b) => a.start - b.start);
  return kept;
}

/**
 * Run rule + term detection (and, if enabled, the name/org heuristic), drop values
 * on the allow-list (case-insensitive), then merge/de-overlap and sort by start.
 */
export function detectAll(text: string, settings: AnonSettings, dict: Set<string>): Detection[] {
  const dets: Detection[] = [...ruleDetections(text), ...termDetections(text, settings.termList || [])];
  if (settings.heuristicNames) dets.push(...heuristicNameDetections(text, dict));
  const allow = new Set((settings.allowList || []).map((s) => s.toLowerCase()));
  const filtered = dets.filter((d) => !allow.has(d.value.toLowerCase()));
  return dedupeOverlaps(filtered);
}

/* ============================================================
   REDACT / UNREDACT
   ============================================================ */

const PREFIX: Record<DetectionKind, string> = {
  email: "EMAIL",
  phone: "PHONE",
  ip: "IP",
  url: "URL",
  card: "CARD",
  iban: "IBAN",
  name: "PERSON",
  org: "ORG",
  custom: "TERM",
};

const TOKEN_RE = /^\[([A-Z]+)_(\d+)\]$/;

/**
 * Replace each DISTINCT detection value with a stable token like `[EMAIL_1]`.
 * Same value → same token, and when an existing `map` is passed the same entity keeps
 * its token across calls (consistent redaction over a whole dataset). Replacement is
 * applied right-to-left so offsets stay valid. Returns the redacted text + extended map.
 */
export function redact(
  text: string,
  detections: Detection[],
  map: RedactionMap = {},
): { text: string; map: RedactionMap } {
  const out: RedactionMap = { ...map };
  const valueToToken = new Map<string, string>();
  const counters: Record<string, number> = {};
  for (const [token, value] of Object.entries(out)) {
    valueToToken.set(value, token);
    const tm = TOKEN_RE.exec(token);
    if (tm) counters[tm[1]] = Math.max(counters[tm[1]] || 0, Number(tm[2]));
  }

  // Assign tokens in first-appearance order for deterministic numbering.
  for (const d of [...detections].sort((a, b) => a.start - b.start)) {
    if (!valueToToken.has(d.value)) {
      const prefix = PREFIX[d.kind];
      const n = (counters[prefix] = (counters[prefix] || 0) + 1);
      const token = `[${prefix}_${n}]`;
      valueToToken.set(d.value, token);
      out[token] = d.value;
    }
  }

  // Apply right-to-left so earlier offsets remain valid.
  let result = text;
  for (const d of [...detections].sort((a, b) => b.start - a.start)) {
    const token = valueToToken.get(d.value)!;
    result = result.slice(0, d.start) + token + result.slice(d.end);
  }
  return { text: result, map: out };
}

/** Reverse redaction tokens back to their originals (for a local reveal). */
export function unredact(text: string, map: RedactionMap): string {
  let result = text;
  // Longest tokens first so e.g. [EMAIL_10] is handled before [EMAIL_1].
  for (const token of Object.keys(map).sort((a, b) => b.length - a.length)) {
    result = result.split(token).join(map[token]);
  }
  return result;
}

/** Convenience: detect + redact a raw string (e.g. right before sending a prompt). */
export function redactText(
  text: string,
  settings: AnonSettings,
  dict: Set<string>,
  map: RedactionMap = {},
): { text: string; map: RedactionMap } {
  return redact(text, detectAll(text, settings, dict), map);
}

/* ============================================================
   CONVERSATION-LEVEL REDACTION
   ============================================================ */

function deepClone<T>(v: T): T {
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(v);
    } catch {
      /* fall through */
    }
  }
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Redact one string-or-object step field in place, threading the shared map. */
function redactField(step: Step, key: "toolInput" | "toolOutput", settings: AnonSettings, dict: Set<string>, map: RedactionMap): RedactionMap {
  const v = step[key];
  if (v == null) return map;
  let s: string;
  if (typeof v === "string") s = v;
  else {
    try {
      s = JSON.stringify(v);
    } catch {
      return map; // un-stringifiable — leave as-is
    }
  }
  const r = redactText(s, settings, dict, map);
  step[key] = r.text;
  return r.map;
}

/**
 * Deep-clone a Conversation and redact every human-readable string (step.text, and
 * string OR stringified-object tool I/O), reusing one shared `map` so tokens are
 * consistent across the whole conversation and dataset. The input is never mutated.
 * NOTE: `step.raw` is intentionally left untouched (it is the escape hatch and is NOT redacted).
 */
export function anonymizeConversation(
  conv: Conversation,
  settings: AnonSettings,
  dict: Set<string>,
  map: RedactionMap = {},
): { conv: Conversation; map: RedactionMap } {
  const cloned = deepClone(conv);
  let m: RedactionMap = { ...map };
  for (const step of cloned.steps) {
    if (typeof step.text === "string" && step.text) {
      const r = redactText(step.text, settings, dict, m);
      step.text = r.text;
      m = r.map;
    }
    m = redactField(step, "toolInput", settings, dict, m);
    m = redactField(step, "toolOutput", settings, dict, m);
    // step.raw deliberately not redacted.
  }
  return { conv: cloned, map: m };
}
