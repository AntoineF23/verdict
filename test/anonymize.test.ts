import { describe, it, expect } from "vitest";
import {
  ruleDetections,
  heuristicNameDetections,
  termDetections,
  detectAll,
  redact,
  unredact,
  redactText,
  anonymizeConversation,
  luhnValid,
} from "../src/anonymize";
import { defaultDict } from "../src/dict";
import type { AnonSettings, Conversation } from "../src/types";

const dict = defaultDict();

const settings = (over: Partial<AnonSettings> = {}): AnonSettings => ({
  enabled: true,
  termList: [],
  allowList: [],
  heuristicNames: false,
  ...over,
});

// A real Visa test number (passes Luhn).
const VALID_CARD = "4111111111111111";
// 16 digits that do NOT pass Luhn.
const BAD_CARD = "1234567812345678";

describe("ruleDetections", () => {
  it("detects emails, phones, IPv4 and URLs with correct kinds", () => {
    const text =
      "Reach me at jane.doe@example.com or +1 (555) 123-4567. Server 192.168.0.1, docs at https://example.com/path.";
    const kinds = ruleDetections(text);
    const byKind = (k: string) => kinds.filter((d) => d.kind === k);
    expect(byKind("email")[0].value).toBe("jane.doe@example.com");
    expect(byKind("phone").length).toBe(1);
    expect(byKind("ip")[0].value).toBe("192.168.0.1");
    expect(byKind("url")[0].value).toBe("https://example.com/path");
  });

  it("detects an IBAN", () => {
    const dets = ruleDetections("Wire to GB82WEST12345698765432 today.");
    const iban = dets.find((d) => d.kind === "iban");
    expect(iban?.value).toBe("GB82WEST12345698765432");
  });

  it("keeps start/end offsets aligned to the source text", () => {
    const text = "email: a@b.com";
    const d = ruleDetections(text)[0];
    expect(text.slice(d.start, d.end)).toBe(d.value);
  });
});

describe("Luhn card detection", () => {
  it("flags a valid Luhn card but not a random non-Luhn 16-digit string", () => {
    expect(luhnValid(VALID_CARD)).toBe(true);
    expect(luhnValid(BAD_CARD)).toBe(false);

    const good = ruleDetections(`card ${VALID_CARD} end`);
    expect(good.some((d) => d.kind === "card" && d.value === VALID_CARD)).toBe(true);

    const bad = ruleDetections(`card ${BAD_CARD} end`);
    expect(bad.some((d) => d.kind === "card")).toBe(false);
  });
});

describe("termDetections", () => {
  it("matches user terms case-insensitively on whole words", () => {
    const dets = termDetections("Project Falcon and falcon-wing are secret.", ["Falcon"]);
    expect(dets).toHaveLength(2);
    expect(dets.every((d) => d.kind === "custom")).toBe(true);
  });
});

describe("heuristicNameDetections", () => {
  it("flags a mid-sentence multi-word name", () => {
    const dets = heuristicNameDetections("I met John Smith yesterday.", dict);
    expect(dets.some((d) => d.kind === "name" && d.value === "John Smith")).toBe(true);
  });

  it("does NOT flag the sentence-initial word", () => {
    const dets = heuristicNameDetections("Yesterday was fine.", dict);
    expect(dets.some((d) => d.value === "Yesterday")).toBe(false);
  });

  it("does NOT flag dictionary words", () => {
    const dets = heuristicNameDetections("We met on Monday in January.", dict);
    expect(dets.some((d) => d.value === "Monday" || d.value === "January")).toBe(false);
  });

  it("classifies a corp-suffixed sequence as org", () => {
    const dets = heuristicNameDetections("We signed with Acme Corp last week.", dict);
    expect(dets.some((d) => d.kind === "org" && d.value === "Acme Corp")).toBe(true);
  });

  it("does NOT flag currency codes (USD/EUR/…) as names", () => {
    const dets = heuristicNameDetections("The fee is 100 USD or about 90 EUR or 12000 JPY.", dict);
    expect(dets.some((d) => /USD|EUR|JPY/.test(d.value))).toBe(false);
  });

  it("flags a real name next to a currency, but not the currency", () => {
    const dets = heuristicNameDetections("We paid Marie Dupont 100 USD today.", dict);
    const values = dets.map((d) => d.value);
    expect(values).toContain("Marie Dupont");
    expect(values.join(" ")).not.toMatch(/USD/);
  });

  it("treats a single standalone ALL-CAPS acronym as org, not a person", () => {
    const dets = heuristicNameDetections("Please contact NASA about it.", dict);
    expect(dets.some((d) => d.value === "NASA" && d.kind === "name")).toBe(false);
  });

  it("captures a Title-case first name + ALL-CAPS surname as one name", () => {
    const dets = heuristicNameDetections("My name is Antoine FORNAS and I agree.", dict);
    expect(dets.some((d) => d.kind === "name" && d.value === "Antoine FORNAS")).toBe(true);
  });

  it("captures a fully ALL-CAPS multi-word name", () => {
    const dets = heuristicNameDetections("Signed by ANTOINE FORNAS yesterday.", dict);
    expect(dets.some((d) => d.kind === "name" && d.value === "ANTOINE FORNAS")).toBe(true);
  });
});

describe("detectAll", () => {
  it("respects the allowList (case-insensitive)", () => {
    const text = "Contact John Smith at john@acme.com.";
    const withName = detectAll(text, settings({ heuristicNames: true }), dict);
    expect(withName.some((d) => d.value === "John Smith")).toBe(true);

    const allowed = detectAll(text, settings({ heuristicNames: true, allowList: ["john smith"] }), dict);
    expect(allowed.some((d) => d.value === "John Smith")).toBe(false);
    // the email is still redacted
    expect(allowed.some((d) => d.kind === "email")).toBe(true);
  });
});

describe("redact / unredact", () => {
  it("gives the same value the same stable token, reusing an existing map", () => {
    const text = "mail a@b.com then a@b.com and c@d.com";
    const dets = detectAll(text, settings(), dict);
    const r1 = redact(text, dets);
    // both occurrences of a@b.com share one token
    expect(r1.text.match(/\[EMAIL_1\]/g)?.length).toBe(2);
    expect(r1.text).toContain("[EMAIL_2]");

    // a second call with the returned map reuses the same token
    const text2 = "again a@b.com";
    const r2 = redact(text2, detectAll(text2, settings(), dict), r1.map);
    expect(r2.text).toBe("again [EMAIL_1]");
  });

  it("round-trips via unredact", () => {
    const text = "Ping jane@x.io on 192.168.1.9 at https://x.io/y.";
    const { text: red, map } = redactText(text, settings(), dict);
    expect(red).not.toContain("jane@x.io");
    expect(unredact(red, map)).toBe(text);
  });
});

describe("anonymizeConversation", () => {
  const conv: Conversation = {
    id: "t1",
    startNs: 0,
    meta: {},
    steps: [
      { kind: "message", role: "user", text: "email me at bob@corp.com", raw: { orig: "bob@corp.com" } },
      { kind: "tool_call", role: "tool", toolName: "lookup", toolInput: { email: "bob@corp.com" }, toolOutput: "found bob@corp.com" },
    ],
  };

  it("redacts step.text and string/object tool I/O, shares tokens, and does not mutate input", () => {
    const snapshot = JSON.stringify(conv);
    const { conv: out, map } = anonymizeConversation(conv, settings(), dict);

    // input untouched
    expect(JSON.stringify(conv)).toBe(snapshot);

    // text redacted
    expect(out.steps[0].text).toBe("email me at [EMAIL_1]");
    // object tool input stringified + redacted
    expect(typeof out.steps[1].toolInput).toBe("string");
    expect(out.steps[1].toolInput).toContain("[EMAIL_1]");
    // string tool output redacted, same token (shared map)
    expect(out.steps[1].toolOutput).toBe("found [EMAIL_1]");
    // raw untouched
    expect(out.steps[0].raw).toEqual({ orig: "bob@corp.com" });
    // single distinct value in the map
    expect(map["[EMAIL_1]"]).toBe("bob@corp.com");
  });
});
