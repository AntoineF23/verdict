// @vitest-environment jsdom
// End-to-end smoke test: mount the real index.html markup, import the real app
// module (which runs all DOM wiring), and drive it a little. Catches missing-element
// wiring bugs that unit tests on pure modules cannot.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

describe("app boots against real markup", () => {
  beforeAll(async () => {
    const html = readFileSync(join(here, "..", "index.html"), "utf8");
    const body = html.slice(html.indexOf("<body>") + 6, html.indexOf("<script"));
    document.body.innerHTML = body;
    await import("../src/app"); // runs all wiring; throws if an element id is missing
  });

  it("wires without error and shows the empty state", () => {
    expect(document.getElementById("queueList")).toBeTruthy();
    expect(document.getElementById("emptyState")).toBeTruthy();
  });

  it("opens and closes the analysis modal, rendering its body", () => {
    const modal = document.getElementById("analysis")!;
    expect(modal.classList.contains("hidden")).toBe(true);

    document.getElementById("analyzeBtn")!.dispatchEvent(new Event("click"));
    expect(modal.classList.contains("hidden")).toBe(false);
    // With no coded fails yet, it should render the guidance message.
    expect(document.getElementById("analysisBody")!.innerHTML).toMatch(/No open codes yet/);

    document.getElementById("closeAnalysis")!.dispatchEvent(new Event("click"));
    expect(modal.classList.contains("hidden")).toBe(true);
  });

  it("opens the Settings modal and renders the LLM + anonymization form", () => {
    const modal = document.getElementById("settings")!;
    document.getElementById("settingsBtn")!.dispatchEvent(new Event("click"));
    expect(modal.classList.contains("hidden")).toBe(false);
    const html = document.getElementById("settingsBody")!.innerHTML;
    expect(html).toMatch(/LLM connection/);
    expect(html).toMatch(/Anonymization/);
    expect(document.getElementById("setProvider")).toBeTruthy();
    document.getElementById("closeSettings")!.dispatchEvent(new Event("click"));
    expect(modal.classList.contains("hidden")).toBe(true);
  });

  it("opens the Judges modal, showing the empty-state before categories exist", () => {
    const modal = document.getElementById("judges")!;
    document.getElementById("judgesBtn")!.dispatchEvent(new Event("click"));
    expect(modal.classList.contains("hidden")).toBe(false);
    expect(document.getElementById("judgesBody")!.innerHTML).toMatch(/No axial categories yet/);
    document.getElementById("closeJudges")!.dispatchEvent(new Event("click"));
  });

  it("toggles anonymization on/off from the header", () => {
    const btn = document.getElementById("anonBtn")!;
    const lbl = () => btn.querySelector(".lbl")!.textContent;
    expect(lbl()).toBe("Anonymize");
    btn.dispatchEvent(new Event("click"));
    expect(lbl()).toBe("Anonymized");
    expect(btn.classList.contains("on")).toBe(true);
    btn.dispatchEvent(new Event("click"));
    expect(lbl()).toBe("Anonymize");
  });

  it("injects inline SVG icons into header buttons (no emoji)", () => {
    expect(document.getElementById("settingsBtn")!.querySelector("svg")).toBeTruthy();
    expect(document.getElementById("analyzeBtn")!.querySelector("svg")).toBeTruthy();
  });
});
