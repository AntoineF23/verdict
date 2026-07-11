// @ts-nocheck
// App shell: state, localStorage, rendering and DOM wiring.
// Pure logic is imported from ./parser and ./coding (both unit-tested).

import "@fontsource/ubuntu/latin-400.css";
import "@fontsource/ubuntu/latin-500.css";
import "@fontsource/ubuntu/latin-700.css";
import "@fontsource/ubuntu-mono/latin-400.css";
import "./styles.css";
import { ICONS } from "./icons";
import { esc, pretty, parseText, detectAndNormalize } from "./parser";
import {
  normCode,
  codeStats as codeStatsPure,
  buildAxialPrompt as buildAxialPromptPure,
  parseAxialResult,
  convCategories as convCategoriesPure,
  categoryCounts as categoryCountsPure,
} from "./coding";
import { defaultDict } from "./dict";
import { anonymizeConversation, redactText, heuristicNameDetections } from "./anonymize";
import { PRESETS, llmComplete, loadLlmConfig, saveLlmConfig } from "./llm";
import { metricsFromPairs, splitStratified } from "./metrics";
import {
  DEFAULT_JUDGE_TEMPLATE,
  renderConversationForJudge,
  buildJudgePrompt,
  parseJudgeVerdict,
  runJudgeOverSet,
  exportJudge,
  newJudgeForCategory,
} from "./judge";

/* ============================================================
   STATE
   ============================================================ */
const LS_FEEDBACK = "llm-grader-feedback-v1";
const LS_REVIEWER = "llm-grader-reviewer";

const state = {
  conversations: [],
  feedback: loadFeedback(),   // { [convId]: {verdict, comment, tags, reviewedAt, reviewer} }
  currentId: null,
  filter: "all",
};

function loadFeedback() {
  try { return JSON.parse(localStorage.getItem(LS_FEEDBACK)) || {}; }
  catch { return {}; }
}
function saveFeedback() {
  try { localStorage.setItem(LS_FEEDBACK, JSON.stringify(state.feedback)); } catch {}
}

/* ---- v2 state: anonymization, LLM config, judges ---- */
const LS_ANON = "llm-grader-anon-v1";
const LS_JUDGES = "llm-grader-judges-v1";
const DICT = defaultDict();
state.anon = (() => {
  try { return JSON.parse(localStorage.getItem(LS_ANON)) || null; } catch { return null; }
})() || { enabled: false, termList: [], allowList: [], heuristicNames: true };
state.llm = loadLlmConfig();
state.judges = (() => { try { return JSON.parse(localStorage.getItem(LS_JUDGES)) || {}; } catch { return {}; } })();
state.anonMap = {};       // dataset-wide RedactionMap (consistent tokens across conversations)
state.viewCache = {};     // id -> anonymized conversation (invalidated on data/settings change)

function saveAnon() { try { localStorage.setItem(LS_ANON, JSON.stringify(state.anon)); } catch {} }
function saveJudges() { try { localStorage.setItem(LS_JUDGES, JSON.stringify(state.judges)); } catch {} }
function saveLlm() { saveLlmConfig(state.llm); }

/* The conversation as shown/sent: redacted when anonymization is on, else the original. */
function viewConv(c) {
  if (!state.anon || !state.anon.enabled) return c;
  if (state.viewCache[c.id]) return state.viewCache[c.id];
  const { conv, map } = anonymizeConversation(c, state.anon, DICT, state.anonMap);
  state.anonMap = map;
  state.viewCache[c.id] = conv;
  return conv;
}
function invalidateView() { state.viewCache = {}; state.anonMap = {}; }
/* Redact an arbitrary string with current settings (used before any LLM payload). */
function redactForLlm(text) {
  if (!state.anon || !state.anon.enabled) return text;
  return redactText(text, state.anon, DICT, state.anonMap).text;
}

function ingest(text, filename) {
  let data;
  try { data = parseText(text); }
  catch (e) { setBanner("Parse error: " + e.message, "warn"); return; }

  let result;
  try { result = detectAndNormalize(data); }
  catch (e) { setBanner("Normalize error: " + e.message, "warn"); return; }

  if (!result.conversations.length) { setBanner("No conversations found in file", "warn"); return; }

  state.conversations = result.conversations;
  invalidateView(); // fresh dataset -> rebuild the redaction map lazily
  // attach saved feedback
  const totalSteps = result.conversations.reduce((n, c) => n + c.steps.length, 0);
  setBanner(`Detected: ${result.format} — ${result.conversations.length} conversation(s), ${totalSteps} step(s)`, "ok");
  state.currentId = result.conversations[0].id;
  document.getElementById("emptyState")?.remove();
  renderAll();
  selectConversation(state.currentId);
}

/* ============================================================
   RENDER — queue
   ============================================================ */
function fb(id) { return state.feedback[id] || {}; }

function convPreview(c) {
  const v = viewConv(c);
  const firstUser = v.steps.find(s => s.kind === "message" && s.role === "user");
  const any = firstUser || v.steps.find(s => s.text) || v.steps[0];
  return (any && (any.text || any.toolName)) ? String(any.text || any.toolName) : "(no text)";
}

function passesFilter(c) {
  const f = state.filter, v = fb(c.id).verdict;
  const base = f === "all" ? true : f === "unreviewed" ? !v : v === f;
  if (!base) return false;
  if (state.categoryFilter) return convCategories(c.id).includes(state.categoryFilter);
  return true;
}
function renderQueue() {
  renderCatFilterNote();
  const list = document.getElementById("queueList");
  const items = state.conversations.filter(passesFilter);
  list.innerHTML = items.map(c => {
    const v = fb(c.id).verdict;
    const dot = v === "pass" ? "pass" : v === "fail" ? "fail" : "";
    const active = c.id === state.currentId ? "active" : "";
    const nCodes = getCodes(c.id).length;
    return `<div class="qitem ${active}" data-id="${esc(c.id)}">
      <div class="dot ${dot}"></div>
      <div class="qmeta">
        <div class="qprev">${esc(convPreview(c))}</div>
        <div class="qid">${esc(String(c.id).slice(0, 28))}</div>
        <div class="qsub">${c.steps.length} steps${c.meta.model ? " · " + esc(c.meta.model) : ""}${fb(c.id).comment ? " · " + MSG_ICON : ""}${nCodes ? ` · ${nCodes} code${nCodes > 1 ? "s" : ""}` : ""}</div>
      </div>
    </div>`;
  }).join("") || `<div style="padding:16px;color:var(--muted)">No conversations match this filter.</div>`;

  list.querySelectorAll(".qitem").forEach(el =>
    el.addEventListener("click", () => selectConversation(el.dataset.id)));
  renderCounts();
}
function renderCatFilterNote() {
  const note = document.getElementById("catFilterNote");
  if (state.categoryFilter) {
    note.innerHTML = `<div class="filter-note">Category: <b>${esc(state.categoryFilter)}</b> <button id="clearCat">clear</button></div>`;
    note.querySelector("#clearCat").onclick = () => { state.categoryFilter = null; renderQueue(); };
  } else note.innerHTML = "";
}

function renderCounts() {
  const total = state.conversations.length;
  let pass = 0, fail = 0, rev = 0;
  state.conversations.forEach(c => {
    const v = fb(c.id).verdict;
    if (v === "pass") pass++;
    if (v === "fail") fail++;
    if (v) rev++;
  });
  document.getElementById("totalCount").textContent = total;
  document.getElementById("revCount").textContent = rev;
  document.getElementById("passCount").textContent = pass;
  document.getElementById("failCount").textContent = fail;
}

/* ============================================================
   RENDER — detail
   ============================================================ */
function stepHtml(s) {
  const rawBlock = `<details class="raw"><summary>show raw</summary><pre class="code">${esc(pretty(s.raw))}</pre></details>`;
  if (s.kind === "tool_call") {
    const inBlock = s.toolInput != null && s.toolInput !== "" ? `<div class="io-label">Input</div><pre class="code">${esc(pretty(s.toolInput))}</pre>` : "";
    const outBlock = s.toolOutput != null && s.toolOutput !== "" ? `<div class="io-label">Output</div><pre class="code">${esc(pretty(s.toolOutput))}</pre>` : "";
    return `<div class="step tool-step">
      <details class="tool" open>
        <summary><span class="badge">tool</span> ${esc(s.toolName || "tool")}</summary>
        <div class="tool-body">${inBlock}${outBlock}${rawBlock}</div>
      </details>
    </div>`;
  }
  if (s.kind === "unknown") {
    return `<div class="step">
      <div class="role-label">${esc(s.role || "record")}</div>
      <div class="bubble system"><pre class="code" style="max-height:none">${esc(s.text || "")}</pre></div>
      ${rawBlock}
    </div>`;
  }
  const role = s.role || "assistant";
  const cls = role === "user" ? "user" : role === "system" ? "system" : "assistant";
  return `<div class="step ${cls}">
    <div class="role-label">${esc(role)}</div>
    <div class="bubble ${cls}">${esc(s.text || "")}</div>
    ${rawBlock}
  </div>`;
}

function renderDetail(c) {
  const v = viewConv(c);
  const head = document.getElementById("detailHead");
  const m = c.meta || {};
  const bits = [];
  bits.push(`<div class="mtag">id <b>${esc(String(c.id).slice(0, 36))}</b></div>`);
  if (m.model) bits.push(`<div class="mtag">model <b>${esc(m.model)}</b></div>`);
  if (m.agentName) bits.push(`<div class="mtag">agent <b>${esc(m.agentName)}</b></div>`);
  if (m.durationMs != null) bits.push(`<div class="mtag">duration <b>${m.durationMs} ms</b></div>`);
  if (m.tokens) bits.push(`<div class="mtag">tokens <b>${m.tokens.in}→${m.tokens.out}</b></div>`);
  if (m.status) bits.push(`<div class="mtag" style="color:var(--fail)">status <b>${esc(m.status)}</b></div>`);
  bits.push(`<div class="mtag">${c.steps.length} steps</div>`);
  head.innerHTML = bits.join("");

  const tl = document.getElementById("timeline");
  tl.innerHTML = v.steps.map(stepHtml).join("");
  tl.scrollTop = 0;
}

function renderFeedback(c) {
  const panel = document.getElementById("feedback");
  panel.classList.remove("hidden");
  const f = fb(c.id);
  document.getElementById("btnPass").classList.toggle("on", f.verdict === "pass");
  document.getElementById("btnFail").classList.toggle("on", f.verdict === "fail");
  const ta = document.getElementById("comment");
  ta.value = f.comment || "";
  document.getElementById("codeInput").value = "";
  renderCodes(c.id);
  updateSaveNote(c.id);
}

/* ---- open coding: per-conversation error codes ---- */
function getCodes(id) { const f = state.feedback[id]; return (f && (f.codes || f.tags)) || []; }
function allCodes() {
  const set = new Set();
  Object.values(state.feedback).forEach(f => (f.codes || f.tags || []).forEach(c => set.add(c)));
  return [...set].sort((a, b) => a.localeCompare(b));
}
function renderCodes(id) {
  const wrap = document.getElementById("fbCodes");
  wrap.classList.toggle("hidden", fb(id).verdict !== "fail");
  const fc = document.getElementById("fullyCoded");
  if (fc) fc.checked = !!fb(id).fullyCoded;
  const chips = document.getElementById("codeChips");
  chips.innerHTML = getCodes(id).map(c =>
    `<span class="chip">${esc(c)}<button data-code="${esc(c)}" title="remove">×</button></span>`).join("");
  chips.querySelectorAll("button").forEach(b => b.addEventListener("click", () => removeCode(id, b.dataset.code)));
  renderCodeSuggestions();
}
function renderCodeSuggestions() {
  document.getElementById("codeSuggestions").innerHTML =
    allCodes().map(c => `<option value="${esc(c)}"></option>`).join("");
}
function addCode(id, code) {
  code = String(code).trim();
  if (!code) return;
  const r = ensureRecord(id);
  if (!r.codes.some(c => normCode(c) === normCode(code))) r.codes.push(code);
  stampRecord(r);
  saveFeedback();
  renderCodes(id);
  renderQueue();
}
function removeCode(id, code) {
  const r = ensureRecord(id);
  r.codes = r.codes.filter(c => c !== code);
  saveFeedback();
  renderCodes(id);
  renderQueue();
}

function updateSaveNote(id) {
  const f = fb(id);
  const note = document.getElementById("saveNote");
  if (f.reviewedAt) {
    note.innerHTML = `saved ${esc(new Date(f.reviewedAt).toLocaleString())}${f.reviewer ? " · " + esc(f.reviewer) : ""}`;
  } else {
    note.textContent = "";
  }
}

/* ============================================================
   SELECTION + FEEDBACK MUTATION
   ============================================================ */
function currentConv() { return state.conversations.find(c => c.id === state.currentId); }

function selectConversation(id) {
  state.currentId = id;
  const c = currentConv();
  if (!c) return;
  renderDetail(c);
  renderFeedback(c);
  // update active highlight without full re-render
  document.querySelectorAll(".qitem").forEach(el =>
    el.classList.toggle("active", el.dataset.id === id));
  // ensure visible
  const el = document.querySelector(`.qitem[data-id="${cssEsc(id)}"]`);
  el && el.scrollIntoView({ block: "nearest" });
}
function cssEsc(s) { return String(s).replace(/["\\]/g, "\\$&"); }

function ensureRecord(id) {
  if (!state.feedback[id]) state.feedback[id] = { verdict: null, comment: "", codes: [], reviewedAt: null, reviewer: null };
  if (!state.feedback[id].codes) state.feedback[id].codes = state.feedback[id].tags || [];
  return state.feedback[id];
}

function setVerdict(id, verdict, advance) {
  const r = ensureRecord(id);
  r.verdict = r.verdict === verdict ? null : verdict; // toggle off if same
  stampRecord(r);
  saveFeedback();
  renderQueue();
  renderFeedback(currentConv());
  if (advance && r.verdict) goNextUnreviewed();
}

function setComment(id, text) {
  const r = ensureRecord(id);
  r.comment = text;
  stampRecord(r);
  saveFeedback();
  updateSaveNote(id);
  // update 💬 indicator lazily
  const el = document.querySelector(`.qitem[data-id="${cssEsc(id)}"] .qsub`);
  // (cheap partial update omitted; full renderQueue on blur)
}

function stampRecord(r) {
  r.reviewedAt = new Date().toISOString();
  r.reviewer = r.reviewer || null;
}

/* ============================================================
   NAVIGATION
   ============================================================ */
function visibleConvs() {
  const f = state.filter;
  return state.conversations.filter(c => {
    const v = fb(c.id).verdict;
    if (f === "all") return true;
    if (f === "unreviewed") return !v;
    return v === f;
  });
}
function move(delta) {
  const list = state.conversations;
  const i = list.findIndex(c => c.id === state.currentId);
  const ni = Math.min(list.length - 1, Math.max(0, i + delta));
  if (list[ni]) selectConversation(list[ni].id);
}
function goNextUnreviewed() {
  const list = state.conversations;
  const i = list.findIndex(c => c.id === state.currentId);
  for (let j = i + 1; j < list.length; j++) {
    if (!fb(list[j].id).verdict) { selectConversation(list[j].id); return; }
  }
  // none after; try from start
  for (let j = 0; j < list.length; j++) {
    if (!fb(list[j].id).verdict) { selectConversation(list[j].id); return; }
  }
}

/* ============================================================
   EXPORT / IMPORT
   ============================================================ */
function download(filename, text, type) {
  const blob = new Blob([text], { type: type || "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function exportCsv() {
  const cols = ["conversation_id", "verdict", "comment", "codes", "axial_category", "reviewed_at", "model", "agent", "num_steps"];
  const rows = [cols.join(",")];
  state.conversations.forEach(c => {
    const f = fb(c.id);
    rows.push([
      c.id, f.verdict || "", f.comment || "", getCodes(c.id).join("|"), convCategories(c.id).join("|"),
      f.reviewedAt || "", c.meta.model || "", c.meta.agentName || "", c.steps.length
    ].map(csvCell).join(","));
  });
  download("llm-grader-feedback.csv", rows.join("\n"), "text/csv");
}
function exportJson() {
  const out = state.conversations.map(c => {
    const f = fb(c.id);
    return {
      conversation_id: c.id,
      verdict: f.verdict || null,
      comment: f.comment || "",
      codes: getCodes(c.id),
      axial_categories: convCategories(c.id),
      reviewed_at: f.reviewedAt || null,
      model: c.meta.model || null,
      agent: c.meta.agentName || null,
      num_steps: c.steps.length,
    };
  });
  const payload = { feedback: out, axial: state.axial || null };
  download("llm-grader-feedback.json", JSON.stringify(payload, null, 2), "application/json");
}
function importFeedback(text) {
  let data;
  try { data = JSON.parse(text); } catch { setBanner("Import: invalid JSON", "warn"); return; }
  const arr = Array.isArray(data) ? data : (data.feedback || []);
  let n = 0;
  arr.forEach(rec => {
    const id = rec.conversation_id || rec.id;
    if (!id) return;
    state.feedback[id] = {
      verdict: rec.verdict || null,
      comment: rec.comment || "",
      codes: rec.codes || rec.tags || [],
      fullyCoded: rec.fullyCoded || rec.fully_coded || false,
      reviewedAt: rec.reviewed_at || rec.reviewedAt || null,
      reviewer: rec.reviewer || null,
    };
    n++;
  });
  if (!Array.isArray(data) && data.axial) { state.axial = data.axial; saveAxial(); }
  saveFeedback();
  renderQueue();
  if (currentConv()) renderFeedback(currentConv());
  setBanner(`Imported feedback for ${n} conversation(s)`, "ok");
}

/* ============================================================
   RENDER ALL
   ============================================================ */
function renderAll() {
  renderQueue();
}
function setBanner(text, cls) {
  const b = document.getElementById("banner");
  b.textContent = text;
  b.className = "banner" + (cls ? " " + cls : "");
  b.title = text;
}

/* ============================================================
   AXIAL CODING (open codes -> LLM -> categories, offline bridge)
   ============================================================ */
const LS_AXIAL = "llm-grader-axial-v1";
state.axial = (() => { try { return JSON.parse(localStorage.getItem(LS_AXIAL)) || null; } catch { return null; } })();
state.categoryFilter = null;
function saveAxial() {
  try { state.axial ? localStorage.setItem(LS_AXIAL, JSON.stringify(state.axial)) : localStorage.removeItem(LS_AXIAL); } catch {}
}

function failConvs() { return state.conversations.filter(c => fb(c.id).verdict === "fail"); }

/* Thin wrappers that feed app state into the pure, tested functions in ./coding. */
function codeStats() {
  return codeStatsPure(failConvs().map(c => ({ comment: fb(c.id).comment, codes: getCodes(c.id) })));
}
function convCategories(id) {
  return convCategoriesPure(getCodes(id), state.axial);
}
function categoryCounts() {
  return categoryCountsPure(failConvs().map(c => ({ codes: getCodes(c.id) })), state.axial);
}
function buildAxialPrompt() {
  return buildAxialPromptPure(codeStats());
}

function applyAxial(text) {
  let cats;
  try { cats = parseAxialResult(text); }
  catch (e) { setAnalysisMsg(e.message || "Invalid JSON — paste the model's JSON output.", "warn"); return; }
  state.axial = { categories: cats, generatedAt: new Date().toISOString() };
  saveAxial();
  renderAnalysis();
  renderQueue();
}

function setAnalysisMsg(text, cls) {
  const m = document.getElementById("analysisMsg");
  if (!m) return;
  m.textContent = text; m.className = "banner " + (cls || ""); m.style.display = "inline-block";
}
function copyText(text, btn) {
  const done = () => { if (btn) { const t = btn.textContent; btn.textContent = "Copied!"; setTimeout(() => btn.textContent = t, 1200); } };
  const fallback = () => { const ta = document.getElementById("promptArea"); if (ta) { ta.classList.remove("hidden"); ta.focus(); ta.select(); try { document.execCommand("copy"); done(); } catch {} } };
  try { navigator.clipboard.writeText(text).then(done, fallback); } catch { fallback(); }
}
function syncFilterButtons() {
  document.querySelectorAll("#filters button").forEach(b => b.classList.toggle("active", b.dataset.f === state.filter));
}

function openAnalysis() { document.getElementById("analysis").classList.remove("hidden"); renderAnalysis(); }
function closeAnalysis() { document.getElementById("analysis").classList.add("hidden"); }

function renderAnalysis() {
  const body = document.getElementById("analysisBody");
  const stats = codeStats();
  const nFail = failConvs().length;
  const coded = failConvs().filter(c => getCodes(c.id).length).length;
  let html = `<div id="analysisMsg" class="banner" style="display:none;margin-bottom:10px"></div>`;
  html += `<p style="margin-top:0;color:var(--muted);font-size:13px">${nFail} fail(s) · ${coded} coded · ${nFail - coded} uncoded · ${stats.length} distinct open code(s)</p>`;

  if (!stats.length) {
    html += `<p>No open codes yet. Mark conversations <b>Fail</b> and add error codes in the feedback bar (filter the queue to <b>Fail</b> for a focused coding pass), then reopen this panel.</p>`;
    body.innerHTML = html; return;
  }

  html += `<h3>1 · Open codes</h3><table class="code-table"><tbody>`;
  stats.forEach(e => html += `<tr><td>${esc(e.code)}</td><td class="n">${e.count}</td></tr>`);
  html += `</tbody></table>`;

  html += `<h3>2 · Axial-coding prompt</h3>`;
  html += `<p style="font-size:13px;color:var(--muted);margin:0 0 8px">Copy this into any LLM and paste its JSON into step 3 — or run it directly with your API key (Settings ⚙).${state.anon?.enabled ? "" : " <b>Note:</b> anonymization is off, so raw text would be sent."}</p>`;
  html += `<button class="btn-primary" id="runAxialApi">Run with API</button> <button id="copyPrompt">Copy prompt</button> <button id="togglePrompt">Show / hide prompt</button>`;
  html += `<textarea class="mono-area hidden" id="promptArea" readonly>${esc(buildAxialPrompt())}</textarea>`;

  html += `<h3>3 · Paste axial result (JSON)</h3>`;
  html += `<textarea class="mono-area" id="pasteArea" placeholder='{"categories":[{"name":"...","description":"...","codes":["..."]}]}'></textarea>`;
  html += `<div style="margin-top:8px"><button class="btn-primary" id="applyAxial">Apply categories</button></div>`;

  if (state.axial) {
    const counts = categoryCounts();
    const codeCount = {}; stats.forEach(e => codeCount[normCode(e.code)] = e.count);
    html += `<h3>4 · Axial categories <span style="text-transform:none;font-weight:400;color:var(--muted)">— applied ${esc(new Date(state.axial.generatedAt).toLocaleString())}</span></h3>`;
    const sorted = state.axial.categories.slice().sort((a, b) => (counts[b.name]?.convs || 0) - (counts[a.name]?.convs || 0));
    sorted.forEach(cat => {
      const cc = counts[cat.name] || { convs: 0 };
      html += `<div class="axial-cat"><h4>${esc(cat.name)} <span class="catcount">${cc.convs} conv</span><button class="filterCat" data-cat="${esc(cat.name)}">filter queue →</button></h4>`;
      if (cat.description) html += `<p>${esc(cat.description)}</p>`;
      html += `<div class="memchips">` + cat.codes.map(code =>
        `<span class="memchip">${esc(code)}${codeCount[normCode(code)] ? " ·" + codeCount[normCode(code)] : ""}</span>`).join("") + `</div></div>`;
    });
    const assigned = new Set();
    state.axial.categories.forEach(c => c.codes.forEach(cd => assigned.add(normCode(cd))));
    const un = stats.filter(e => !assigned.has(normCode(e.code)));
    if (un.length) {
      html += `<div class="axial-cat"><h4>Unassigned <span class="catcount" style="background:var(--muted)">${un.length}</span></h4><div class="memchips">` +
        un.map(e => `<span class="memchip">${esc(e.code)} ·${e.count}</span>`).join("") + `</div></div>`;
    }
  }

  body.innerHTML = html;
  const q = id => document.getElementById(id);
  q("runAxialApi")?.addEventListener("click", () => runAxialViaApi(q("runAxialApi")));
  q("copyPrompt")?.addEventListener("click", () => copyText(buildAxialPrompt(), q("copyPrompt")));
  q("togglePrompt")?.addEventListener("click", () => q("promptArea").classList.toggle("hidden"));
  q("applyAxial")?.addEventListener("click", () => applyAxial(q("pasteArea").value));
  body.querySelectorAll(".filterCat").forEach(b => b.addEventListener("click", () => {
    state.categoryFilter = b.dataset.cat; state.filter = "fail"; syncFilterButtons(); renderQueue(); closeAnalysis();
  }));
}

async function runAxialViaApi(btn) {
  if (!state.llm || !state.llm.apiKey) { setAnalysisMsg("Set an API key in Settings (⚙) first.", "warn"); return; }
  const prompt = redactForLlm(buildAxialPrompt());
  const orig = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "Running…"; }
  setAnalysisMsg(`Calling ${state.llm.model}…`, "");
  try {
    const out = await llmComplete(state.llm, { prompt });
    applyAxial(out); // re-renders the panel; sets its own message on parse error
  } catch (e) {
    setAnalysisMsg("API error: " + (e && e.message ? e.message : e), "warn");
  } finally {
    if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = orig; }
  }
}

/* ============================================================
   SETTINGS (LLM connection + anonymization)
   ============================================================ */
function openSettings() {
  state._draft = {
    llm: state.llm ? { ...state.llm } : { provider: "anthropic", model: PRESETS.anthropic.defaultModel, apiKey: "", baseUrl: "" },
    anon: { enabled: state.anon.enabled, heuristicNames: state.anon.heuristicNames, termList: [...state.anon.termList], allowList: [...state.anon.allowList] },
  };
  document.getElementById("settings").classList.remove("hidden");
  renderSettings();
}
function closeSettings() { document.getElementById("settings").classList.add("hidden"); state._draft = null; }

function renderSettings() {
  const d = state._draft;
  const body = document.getElementById("settingsBody");
  const preset = PRESETS[d.llm.provider];
  const modelField = d.llm.provider === "custom"
    ? `<input type="text" id="setModel" value="${esc(d.llm.model || "")}" placeholder="model id" />`
    : `<select id="setModel">${preset.models.map(m => `<option value="${esc(m)}" ${m === d.llm.model ? "selected" : ""}>${esc(m)}</option>`).join("")}</select>`;
  let html = `<div id="settingsMsg" class="banner" style="display:none;margin-bottom:10px"></div>`;
  html += `<h3>LLM connection</h3>`;
  html += `<p style="font-size:12px;color:var(--fail);margin:0 0 8px">⚠ Your API key is stored in this browser only. Fine for local use with your own key — do not host this publicly with a shared key.</p>`;
  html += `<div class="form-row"><label>Provider</label><select id="setProvider">` +
    Object.keys(PRESETS).map(p => `<option value="${p}" ${p === d.llm.provider ? "selected" : ""}>${esc(PRESETS[p].label || p)}</option>`).join("") + `</select></div>`;
  html += `<div class="form-row"><label>Model</label>${modelField}</div>`;
  if (d.llm.provider === "custom") html += `<div class="form-row"><label>Base URL</label><input type="text" id="setBaseUrl" value="${esc(d.llm.baseUrl || "")}" placeholder="https://…/v1" /></div>`;
  html += `<div class="form-row"><label>API key</label><input type="password" id="setKey" value="${esc(d.llm.apiKey || "")}" placeholder="sk-… / paste key" /></div>`;
  html += `<div class="form-row"><label>Max output tokens</label><input type="text" id="setMaxTokens" value="${d.llm.maxTokens ?? ""}" placeholder="4096" /></div>`;
  html += `<p style="font-size:12px;color:var(--muted);margin:-2px 0 8px">Raise this if a thinking/gateway model complains that max_tokens must exceed its thinking budget.</p>`;

  html += `<h3>Anonymization</h3>`;
  html += `<label class="chk"><input type="checkbox" id="setAnonEnabled" ${d.anon.enabled ? "checked" : ""} /> Enable — redact PII in the timeline, exports, and everything sent to an LLM</label>`;
  html += `<label class="chk"><input type="checkbox" id="setHeuristic" ${d.anon.heuristicNames ? "checked" : ""} /> Also flag capitalized words that look like names/orgs (dictionary-filtered heuristic)</label>`;
  html += `<div class="form-row col"><label>Always redact these terms (one per line — names, companies, codenames)</label><textarea id="setTerms" class="mono-area" style="min-height:80px">${esc(d.anon.termList.join("\n"))}</textarea></div>`;
  html += `<div class="form-row col"><label>Never redact these (allow-list, one per line)</label><textarea id="setAllow" class="mono-area" style="min-height:60px">${esc(d.anon.allowList.join("\n"))}</textarea></div>`;
  html += `<div><button id="scanNames" ${state.conversations.length ? "" : "disabled"}>Scan dataset for names/orgs →</button> <span style="font-size:12px;color:var(--muted)">adds confirmed candidates to the term list</span></div>`;
  html += `<div id="scanResults"></div>`;

  html += `<div style="margin-top:16px;display:flex;gap:8px"><button class="btn-primary" id="saveSettings">Save</button><button id="clearKey">Clear key</button></div>`;
  body.innerHTML = html;

  const q = id => document.getElementById(id);
  q("setProvider").addEventListener("change", e => { d.llm.provider = e.target.value; d.llm.model = PRESETS[d.llm.provider].defaultModel; renderSettings(); });
  q("setModel").addEventListener("change", e => { d.llm.model = e.target.value; });
  q("setModel").addEventListener("input", e => { d.llm.model = e.target.value; });
  q("setBaseUrl")?.addEventListener("input", e => { d.llm.baseUrl = e.target.value; });
  q("setKey").addEventListener("input", e => { d.llm.apiKey = e.target.value; });
  q("setMaxTokens").addEventListener("input", e => { const n = parseInt(e.target.value, 10); d.llm.maxTokens = Number.isFinite(n) && n > 0 ? n : undefined; });
  q("setAnonEnabled").addEventListener("change", e => { d.anon.enabled = e.target.checked; });
  q("setHeuristic").addEventListener("change", e => { d.anon.heuristicNames = e.target.checked; });
  q("setTerms").addEventListener("input", e => { d.anon.termList = e.target.value.split("\n").map(s => s.trim()).filter(Boolean); });
  q("setAllow").addEventListener("input", e => { d.anon.allowList = e.target.value.split("\n").map(s => s.trim()).filter(Boolean); });
  q("scanNames").addEventListener("click", scanNames);
  q("saveSettings").addEventListener("click", saveSettings);
  q("clearKey").addEventListener("click", () => { d.llm.apiKey = ""; renderSettings(); });
}

function scanNames() {
  const d = state._draft;
  const seen = new Map(); // normalized -> {value, count}
  for (const c of state.conversations) {
    for (const s of c.steps) {
      const text = [s.text, typeof s.toolInput === "string" ? s.toolInput : "", typeof s.toolOutput === "string" ? s.toolOutput : ""].filter(Boolean).join("\n");
      if (!text) continue;
      for (const det of heuristicNameDetections(text, DICT)) {
        const k = det.value.toLowerCase();
        if (!seen.has(k)) seen.set(k, { value: det.value, count: 0 });
        seen.get(k).count++;
      }
    }
  }
  const known = new Set([...d.anon.termList, ...d.anon.allowList].map(t => t.toLowerCase()));
  const cands = [...seen.values()].filter(c => !known.has(c.value.toLowerCase())).sort((a, b) => b.count - a.count).slice(0, 100);
  const box = document.getElementById("scanResults");
  if (!cands.length) { box.innerHTML = `<p style="font-size:12px;color:var(--muted)">No new name/org candidates found.</p>`; return; }
  box.innerHTML = `<div class="scan-box"><p style="font-size:12px;color:var(--muted);margin:8px 0 4px">Check the ones that are PII, then "Add checked":</p>` +
    cands.map((c, i) => `<label class="chk"><input type="checkbox" data-v="${esc(c.value)}" ${i < 0 ? "checked" : ""}/> ${esc(c.value)} <span style="color:var(--muted)">·${c.count}</span></label>`).join("") +
    `<div style="margin-top:8px"><button id="addScanned" class="btn-primary">Add checked to term list</button></div></div>`;
  document.getElementById("addScanned").addEventListener("click", () => {
    const picks = [...box.querySelectorAll("input[type=checkbox]:checked")].map(i => i.dataset.v);
    const set = new Set(d.anon.termList);
    picks.forEach(p => set.add(p));
    d.anon.termList = [...set];
    renderSettings();
  });
}

function saveSettings() {
  const d = state._draft;
  state.llm = { ...d.llm };
  state.anon = { ...d.anon };
  saveLlm();
  saveAnon();
  invalidateView();
  if (state.currentId) { renderDetail(currentConv()); }
  renderQueue();
  syncAnonToggle();
  closeSettings();
}

function syncAnonToggle() {
  const b = document.getElementById("anonBtn");
  if (!b) return;
  b.classList.toggle("on", !!state.anon.enabled);
  const lbl = b.querySelector(".lbl");
  if (lbl) lbl.textContent = state.anon.enabled ? "Anonymized" : "Anonymize";
}

/* Inject inline SVG icons into buttons (keeps any .lbl span for label updates). */
const MSG_ICON = `<span class="qico">${ICONS.message}</span>`;
function applyIcons() {
  const map = {
    loadBtn: ICONS.upload, importBtn: ICONS.importIcon, anonBtn: ICONS.shield,
    analyzeBtn: ICONS.layers, judgesBtn: ICONS.scale, exportCsv: ICONS.download,
    exportJson: ICONS.download, settingsBtn: ICONS.settings,
    closeAnalysis: ICONS.x, closeSettings: ICONS.x, closeJudges: ICONS.x,
  };
  for (const [id, svg] of Object.entries(map)) {
    const b = document.getElementById(id);
    if (!b) continue;
    if (b.querySelector(".lbl")) b.insertAdjacentHTML("afterbegin", svg);
    else b.innerHTML = svg;
  }
}
function toggleAnon() {
  state.anon.enabled = !state.anon.enabled;
  saveAnon();
  invalidateView();
  if (state.currentId) renderDetail(currentConv());
  renderQueue();
  syncAnonToggle();
}

/* ============================================================
   JUDGES (LLM-as-judge per category — validate vs human, export)
   ============================================================ */
function pct(x) { return (100 * (x || 0)).toFixed(0) + "%"; }
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
function judgeMsg(text, cls) { const m = document.getElementById("judgeMsg"); if (m) { m.textContent = text; m.className = "banner " + (cls || ""); m.style.display = "inline-block"; } }

function labeledConvs() {
  let list = state.conversations.filter(c => fb(c.id).verdict); // reviewed only
  if (state._judgeFullyCodedOnly) list = list.filter(c => fb(c.id).verdict === "pass" || fb(c.id).fullyCoded);
  return list;
}
function ensureJudge(cat) {
  if (!state.judges[cat.name]) {
    const provider = (state.llm && state.llm.provider) || "anthropic";
    const model = (state.llm && state.llm.model) || PRESETS[provider].defaultModel;
    const j = newJudgeForCategory(cat, provider, model, cat.name + ":" + Date.now());
    j.versions[0].createdAt = new Date().toISOString();
    state.judges[cat.name] = j;
    saveJudges();
  }
  return state.judges[cat.name];
}
function activeVersion(j) { return j.versions.find(v => v.id === j.activeVersionId) || j.versions[j.versions.length - 1]; }

function openJudges() { document.getElementById("judges").classList.remove("hidden"); renderJudges(); }
function closeJudges() { document.getElementById("judges").classList.add("hidden"); }

function kappaTone(m) { if (!m) return "none"; const k = m.kappa; return k >= 0.6 ? "good" : k >= 0.4 ? "ok" : "bad"; }

const JUDGE_HELP = `<details class="help"><summary>How to read these numbers</summary>
  <div class="help-body">
    <p><b>The matrix</b> — rows are what your reviewers labeled, columns are what the judge predicted:</p>
    <ul>
      <li><b>TP</b>: both say this category applies · <b>TN</b>: both say it doesn't.</li>
      <li><b>FP</b>: judge flagged it, humans didn't (false alarm) · <b>FN</b>: judge missed one humans flagged.</li>
    </ul>
    <p><b>The rates</b>:</p>
    <ul>
      <li><b>TPR</b> (recall) — of the cases humans put in this category, how many the judge caught. Low ⇒ it misses failures.</li>
      <li><b>TNR</b> (specificity) — of the cases humans left out, how many the judge correctly left out. Low ⇒ it over-flags.</li>
      <li><b>Precision</b> — when the judge says “yes”, how often it’s right.</li>
      <li><b>F1</b> — one number balancing precision and recall.</li>
      <li><b>Accuracy</b> — overall % correct. Looks high when a category is rare, so don’t judge on this alone.</li>
      <li><b>κ (Cohen’s kappa)</b> — agreement corrected for chance; the headline “good enough?” number. Rough guide: &lt;0.4 weak · 0.4–0.6 moderate · 0.6–0.8 substantial · 0.8+ near-perfect.</li>
    </ul>
    <p><b>Test vs Train split</b> — trust the <b>Test</b> column: those conversations were held out while you tuned the prompt, so the numbers aren’t inflated by overfitting. The dot on each tab reflects the test κ (<span class="sdot good"></span> strong · <span class="sdot ok"></span> moderate · <span class="sdot bad"></span> weak · <span class="sdot none"></span> not validated).</p>
  </div></details>`;

function confusionHtml(m, label) {
  if (!m) return `<div class="cm-wrap"><div class="cm-label">${label}</div><p style="font-size:12px;color:var(--muted)">not validated yet</p></div>`;
  return `<div class="cm-wrap"><div class="cm-label">${label} · n=${m.support.total}, ${m.support.positives} positive</div>
    <table class="confusion"><tr><td class="corner"></td><th>judge +</th><th>judge −</th></tr>
    <tr><th>human +</th><td class="tp" title="true positive">${m.tp}<small>TP</small></td><td class="fn" title="false negative — judge missed it">${m.fn}<small>FN</small></td></tr>
    <tr><th>human −</th><td class="fp" title="false positive — judge over-flagged">${m.fp}<small>FP</small></td><td class="tn" title="true negative">${m.tn}<small>TN</small></td></tr></table>
    <div class="rates">TPR <b>${pct(m.tpr)}</b> · TNR <b>${pct(m.tnr)}</b> · Prec ${pct(m.precision)} · F1 ${pct(m.f1)} · Acc ${pct(m.accuracy)} · κ <b>${(m.kappa).toFixed(2)}</b></div></div>`;
}

function renderJudges() {
  const body = document.getElementById("judgesBody");
  let html = `<div id="judgeMsg" class="banner" style="display:none;margin-bottom:10px"></div>`;
  if (!state.axial || !state.axial.categories.length) {
    body.innerHTML = html + `<p>No axial categories yet. Use <b>Analyze fails</b> to build the taxonomy first — you get one judge per category here.</p>`;
    return;
  }
  const cats = state.axial.categories;
  if (!state._judgeTab || !cats.some(c => c.name === state._judgeTab)) state._judgeTab = cats[0].name;
  const reviewed = state.conversations.filter(c => fb(c.id).verdict).length;

  html += `<div class="judges-top">
    <span class="muted">${reviewed} labeled conversations as ground truth</span>
    <label class="chk"><input type="checkbox" id="fcOnly" ${state._judgeFullyCodedOnly ? "checked" : ""}/> only “fully-coded” fails</label>
    <span class="jspacer"></span>
    <button id="exportAllJudges">Export all</button>
  </div>`;
  html += JUDGE_HELP;

  html += `<div class="tabbar">` + cats.map(c => {
    const j = state.judges[c.name];
    const m = j ? activeVersion(j).metrics : null;
    const on = c.name === state._judgeTab ? "active" : "";
    return `<button class="tab ${on}" data-cat="${esc(c.name)}"><span class="sdot ${kappaTone(m)}"></span>${esc(c.name)}${m ? ` <span class="kbadge">κ ${m.kappa.toFixed(2)}</span>` : ""}</button>`;
  }).join("") + `</div>`;

  const cat = cats.find(c => c.name === state._judgeTab);
  const j = ensureJudge(cat);
  const ver = activeVersion(j);
  html += `<div class="judge-card" data-cat="${esc(cat.name)}">
    ${cat.description ? `<p class="muted" style="margin:0 0 10px">${esc(cat.description)}</p>` : ""}
    <div class="judge-controls">
      <label>Version</label>
      <select class="jVersion">${j.versions.map(v => `<option value="${v.id}" ${v.id === ver.id ? "selected" : ""}>${esc(v.label)}${v.metrics ? " · κ " + v.metrics.kappa.toFixed(2) : ""}</option>`).join("")}</select>
      <button class="jNewVersion">+ new version</button>
      <label>Provider</label>
      <select class="jProvider">${Object.keys(PRESETS).map(p => `<option value="${p}" ${p === ver.provider ? "selected" : ""}>${esc(PRESETS[p].label || p)}</option>`).join("")}</select>
      <label>Model</label>
      <input class="jModel" type="text" value="${esc(ver.model)}" />
    </div>
    <label class="fieldlabel">Judge prompt</label>
    <textarea class="jTemplate mono-area" style="min-height:130px">${esc(ver.template)}</textarea>
    <div class="judge-actions">
      <button class="btn-primary jValidate">Validate on labeled set</button>
      <button class="jExport">Export judge</button>
      <span class="jProgress" style="font-size:12px;color:var(--muted)"></span>
    </div>
    <div class="cm-row">${confusionHtml(ver.metrics, "Test split")}${confusionHtml(ver.trainMetrics, "Train split")}</div>
  </div>`;
  body.innerHTML = html;

  const q = id => document.getElementById(id);
  q("fcOnly").addEventListener("change", e => { state._judgeFullyCodedOnly = e.target.checked; });
  q("exportAllJudges").addEventListener("click", exportAllJudges);
  body.querySelectorAll(".tab").forEach(t => t.addEventListener("click", () => { state._judgeTab = t.dataset.cat; renderJudges(); }));

  const card = body.querySelector(".judge-card");
  card.querySelector(".jVersion").addEventListener("change", e => { j.activeVersionId = e.target.value; saveJudges(); renderJudges(); });
  card.querySelector(".jNewVersion").addEventListener("click", () => {
    const n = j.versions.length + 1;
    const nv = { id: cat.name + ":" + Date.now(), label: "v" + n, template: ver.template, provider: ver.provider, model: ver.model, createdAt: new Date().toISOString() };
    j.versions.push(nv); j.activeVersionId = nv.id; saveJudges(); renderJudges();
  });
  card.querySelector(".jProvider").addEventListener("change", e => { ver.provider = e.target.value; ver.model = PRESETS[ver.provider].defaultModel; ver.metrics = undefined; ver.trainMetrics = undefined; saveJudges(); renderJudges(); });
  card.querySelector(".jModel").addEventListener("change", e => { ver.model = e.target.value; ver.metrics = undefined; ver.trainMetrics = undefined; saveJudges(); });
  card.querySelector(".jTemplate").addEventListener("change", e => { ver.template = e.target.value; ver.metrics = undefined; ver.trainMetrics = undefined; saveJudges(); });
  card.querySelector(".jValidate").addEventListener("click", () => validateJudge(cat, card));
  card.querySelector(".jExport").addEventListener("click", () => doExportJudge(cat));
}

async function validateJudge(cat, card) {
  if (!state.llm || !state.llm.apiKey) { judgeMsg("Set an API key in Settings (⚙) first.", "warn"); return; }
  const j = ensureJudge(cat); const ver = activeVersion(j);
  const convs = labeledConvs();
  if (convs.length < 4) { judgeMsg("Need at least ~4 labeled conversations to validate.", "warn"); return; }
  const items = convs.map(c => ({ id: c.id, convText: redactForLlm(renderConversationForJudge(viewConv(c))) }));
  const truth = {}; convs.forEach(c => { truth[c.id] = convCategories(c.id).includes(cat.name); });
  const prog = card.querySelector(".jProgress");
  const cfg = { ...state.llm, provider: ver.provider, model: ver.model };
  const btn = card.querySelector(".jValidate"); btn.disabled = true;
  judgeMsg(`Validating "${cat.name}" with ${ver.model} over ${items.length} conversations…`, "");
  try {
    const results = await runJudgeOverSet({
      cfg, template: ver.template, category: cat, items,
      complete: (c, r) => llmComplete(c, r), concurrency: 4,
      onProgress: (done, total) => { if (prog) prog.textContent = `${done}/${total}`; },
    });
    const pred = {}; let errs = 0;
    results.forEach(r => { pred[r.id] = r.label; if (r.error) errs++; });
    const pairs = items.map(i => ({ id: i.id, human: !!truth[i.id], llm: !!pred[i.id] }));
    const { train, test } = splitStratified(pairs, p => p.human, 0.3, 42);
    ver.metrics = metricsFromPairs(test.map(p => ({ human: p.human, llm: p.llm })));
    ver.trainMetrics = metricsFromPairs(train.map(p => ({ human: p.human, llm: p.llm })));
    saveJudges();
    renderJudges();
    judgeMsg(`Validated "${cat.name}"${errs ? ` (${errs} item error(s))` : ""}. Test κ ${ver.metrics.kappa.toFixed(2)}, TPR ${pct(ver.metrics.tpr)}, TNR ${pct(ver.metrics.tnr)}.`, "ok");
  } catch (e) {
    judgeMsg("API error: " + (e && e.message ? e.message : e), "warn");
    if (btn) btn.disabled = false;
  }
}

function doExportJudge(cat) {
  const j = state.judges[cat.name];
  if (!j) return;
  let art;
  try { art = exportJudge(j, cat); } catch (e) { judgeMsg(e.message || "Nothing to export", "warn"); return; }
  art.json.exportedAt = new Date().toISOString();
  download(`judge-${slug(cat.name)}.json`, JSON.stringify(art.json, null, 2), "application/json");
}
function exportAllJudges() {
  const out = [];
  (state.axial ? state.axial.categories : []).forEach(cat => {
    const j = state.judges[cat.name];
    if (!j) return;
    try { const art = exportJudge(j, cat); art.json.exportedAt = new Date().toISOString(); out.push(art.json); } catch {}
  });
  if (!out.length) { judgeMsg("No validated judges to export yet.", "warn"); return; }
  download("judges.json", JSON.stringify(out, null, 2), "application/json");
}

/* ============================================================
   WIRING
   ============================================================ */
function readFile(file, cb) {
  const r = new FileReader();
  r.onload = () => cb(r.result, file.name);
  r.readAsText(file);
}

document.getElementById("loadBtn").addEventListener("click", () => document.getElementById("fileInput").click());
document.getElementById("fileInput").addEventListener("change", e => {
  const f = e.target.files[0]; if (f) readFile(f, ingest); e.target.value = "";
});
document.getElementById("importBtn").addEventListener("click", () => document.getElementById("fbInput").click());
document.getElementById("fbInput").addEventListener("change", e => {
  const f = e.target.files[0]; if (f) readFile(f, t => importFeedback(t)); e.target.value = "";
});
document.getElementById("exportCsv").addEventListener("click", exportCsv);
document.getElementById("exportJson").addEventListener("click", exportJson);

// Analysis modal
document.getElementById("analyzeBtn").addEventListener("click", openAnalysis);
document.getElementById("closeAnalysis").addEventListener("click", closeAnalysis);
document.getElementById("analysis").addEventListener("click", e => { if (e.target.id === "analysis") closeAnalysis(); });

// Settings modal
document.getElementById("settingsBtn").addEventListener("click", openSettings);
document.getElementById("closeSettings").addEventListener("click", closeSettings);
document.getElementById("settings").addEventListener("click", e => { if (e.target.id === "settings") closeSettings(); });

// Anonymize toggle
document.getElementById("anonBtn").addEventListener("click", toggleAnon);

// "fully coded" flag
document.getElementById("fullyCoded").addEventListener("change", e => {
  if (!state.currentId) return;
  ensureRecord(state.currentId).fullyCoded = e.target.checked;
  saveFeedback();
});

// Judges modal
document.getElementById("judgesBtn").addEventListener("click", openJudges);
document.getElementById("closeJudges").addEventListener("click", closeJudges);
document.getElementById("judges").addEventListener("click", e => { if (e.target.id === "judges") closeJudges(); });

applyIcons();
syncAnonToggle();

// Open-coding input: Enter or comma adds a code
const codeInput = document.getElementById("codeInput");
codeInput.addEventListener("keydown", e => {
  if (e.key === "Enter" || e.key === ",") {
    e.preventDefault();
    if (state.currentId) addCode(state.currentId, codeInput.value.replace(/,$/, ""));
    codeInput.value = "";
  }
});

// Clicking a verdict stays on the conversation (so you can add a comment).
// The p/f keyboard shortcuts still auto-advance for fast triage.
document.getElementById("btnPass").addEventListener("click", () => state.currentId && setVerdict(state.currentId, "pass", false));
document.getElementById("btnFail").addEventListener("click", () => state.currentId && setVerdict(state.currentId, "fail", false));

const commentEl = document.getElementById("comment");
commentEl.addEventListener("input", () => state.currentId && setComment(state.currentId, commentEl.value));
commentEl.addEventListener("blur", renderQueue);
commentEl.addEventListener("keydown", e => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); commentEl.blur(); goNextUnreviewed(); }
});

// Filters
document.getElementById("filters").addEventListener("click", e => {
  const btn = e.target.closest("button"); if (!btn) return;
  state.filter = btn.dataset.f;
  document.querySelectorAll("#filters button").forEach(b => b.classList.toggle("active", b === btn));
  renderQueue();
});

// Keyboard shortcuts
function anyModalOpen() {
  return ["analysis", "settings", "judges"].filter(id => !document.getElementById(id).classList.contains("hidden"));
}
document.addEventListener("keydown", e => {
  const open = anyModalOpen();
  if (open.length) {
    if (e.key === "Escape") open.forEach(id => document.getElementById(id).classList.add("hidden"));
    return;
  }
  const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
  if (e.key === "/" && !typing) { e.preventDefault(); commentEl.focus(); return; }
  if (e.key === "c" && !typing && fb(state.currentId).verdict === "fail") { e.preventDefault(); codeInput.focus(); return; }
  if (typing) return;
  if (!state.conversations.length) return;
  if (e.key === "j") { e.preventDefault(); move(1); }
  else if (e.key === "k") { e.preventDefault(); move(-1); }
  else if (e.key === "p") { e.preventDefault(); setVerdict(state.currentId, "pass", true); }
  else if (e.key === "f") { e.preventDefault(); setVerdict(state.currentId, "fail", true); }
  else if (e.key === "Enter") { e.preventDefault(); goNextUnreviewed(); }
});

// Drag & drop
const drop = document.getElementById("drop");
let dragDepth = 0;
window.addEventListener("dragenter", e => { e.preventDefault(); dragDepth++; drop.classList.add("show"); });
window.addEventListener("dragover", e => e.preventDefault());
window.addEventListener("dragleave", e => { dragDepth--; if (dragDepth <= 0) drop.classList.remove("show"); });
window.addEventListener("drop", e => {
  e.preventDefault(); dragDepth = 0; drop.classList.remove("show");
  const f = e.dataTransfer.files[0]; if (f) readFile(f, ingest);
});
