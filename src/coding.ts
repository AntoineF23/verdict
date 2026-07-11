// Pure, DOM-free logic for the open → axial coding workflow.
// These functions take plain data and return plain data, so they are easy to
// unit-test. All state/DOM wiring lives in app.ts.
import type { Axial, Category, CodeStat, FailInput } from "./types";

/** Normalize an open code for identity comparison. */
export const normCode = (s: string): string => String(s).trim().toLowerCase();

/** Distinct open codes across the given failures, with counts and example comments. */
export function codeStats(fails: FailInput[]): CodeStat[] {
  const m = new Map<string, { code: string; count: number; comments: Set<string> }>();
  for (const f of fails) {
    for (const code of f.codes || []) {
      if (!m.has(code)) m.set(code, { code, count: 0, comments: new Set() });
      const e = m.get(code)!;
      e.count++;
      if (f.comment) e.comments.add(f.comment);
    }
  }
  return [...m.values()]
    .map((e) => ({ code: e.code, count: e.count, comments: [...e.comments] }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

/** Build the copy-paste axial-coding prompt from the open-code statistics. */
export function buildAxialPrompt(stats: CodeStat[]): string {
  let s = "";
  s += "You are helping analyze failures of an AI agent using grounded-theory coding.\n\n";
  s += 'Human reviewers marked agent conversations as FAILURES and attached short free-text "open codes" describing what went wrong. Perform AXIAL CODING: cluster these open codes into a small number of higher-level error categories (themes).\n\n';
  s += "Rules:\n";
  s += "- Assign EVERY open code below to exactly one category.\n";
  s += "- Prefer 3–8 categories. Give each a concise name and a one-sentence description.\n";
  s += "- Base the grouping on the codes AND the reviewer comments given as context.\n";
  s += '- The "codes" arrays must reuse the open code strings VERBATIM so they can be matched back.\n';
  s += "- Output ONLY valid JSON (no prose, no markdown fences) matching exactly:\n";
  s += '{"categories":[{"name":"string","description":"string","codes":["<verbatim open code>"]}]}\n\n';
  s += "Open codes (frequency, with example reviewer comments):\n";
  stats.forEach((e, i) => {
    s += `${i + 1}. "${e.code}" (x${e.count})\n`;
    e.comments.slice(0, 4).forEach((cm) => (s += `     - ${String(cm).replace(/\s+/g, " ").slice(0, 220)}\n`));
  });
  return s;
}

/** Parse and validate the LLM's axial-coding JSON. Throws Error with a friendly message. */
export function parseAxialResult(text: string): Category[] {
  const cleaned = String(text).replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  let data: unknown;
  try {
    data = JSON.parse(cleaned);
  } catch {
    throw new Error("Invalid JSON — paste the model's JSON output.");
  }
  const raw = Array.isArray(data) ? data : (data as { categories?: unknown })?.categories;
  if (!Array.isArray(raw)) throw new Error("JSON must contain a 'categories' array.");
  const cats: Category[] = raw
    .filter((c: any) => c && c.name && Array.isArray(c.codes))
    .map((c: any) => ({ name: String(c.name), description: String(c.description || ""), codes: c.codes.map(String) }));
  if (!cats.length) throw new Error("No valid categories found in that JSON.");
  return cats;
}

/** normalized open code -> axial category name */
export function codeCategoryMap(axial: Axial | null): Map<string, string> {
  const m = new Map<string, string>();
  if (axial) axial.categories.forEach((cat) => cat.codes.forEach((code) => m.set(normCode(code), cat.name)));
  return m;
}

/** The axial categories a single conversation belongs to, via its open codes. */
export function convCategories(codes: string[], axial: Axial | null): string[] {
  if (!axial) return [];
  const map = codeCategoryMap(axial);
  const set = new Set<string>();
  codes.forEach((c) => {
    const cat = map.get(normCode(c));
    if (cat) set.add(cat);
  });
  return [...set];
}

/** Roll-up counts per category: how many conversations and code occurrences fall under each. */
export function categoryCounts(
  fails: { codes: string[] }[],
  axial: Axial | null,
): Record<string, { convs: number; occ: number }> {
  const map = codeCategoryMap(axial);
  const counts: Record<string, { convs: number; occ: number }> = {};
  (axial ? axial.categories : []).forEach((c) => (counts[c.name] = { convs: 0, occ: 0 }));
  for (const f of fails) {
    const cats = new Set<string>();
    (f.codes || []).forEach((code) => {
      const cat = map.get(normCode(code));
      if (cat && counts[cat]) {
        counts[cat].occ++;
        cats.add(cat);
      }
    });
    cats.forEach((cat) => counts[cat].convs++);
  }
  return counts;
}
