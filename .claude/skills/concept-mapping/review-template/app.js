// Concept Mapping — Review app
// Reads ../state.json (written by the concept-mapping skill).
// Pure static, no build step.

const $ = (id) => document.getElementById(id);
const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString());
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);

function showError(msg) {
  const el = $("error-banner");
  el.textContent = msg;
  el.classList.remove("hidden");
}

function setActiveTab(name) {
  document.querySelectorAll(".tab-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === name);
  });
  document.querySelectorAll(".tab-panel").forEach((p) => {
    p.classList.toggle("hidden", p.id !== `tab-${name}`);
  });
}

document.querySelectorAll(".tab-btn").forEach((b) => {
  b.addEventListener("click", () => setActiveTab(b.dataset.tab));
});
setActiveTab("overview");

function renderProgressBars(c) {
  const total = c.sourceConceptsTotal || 0;
  const rows = [
    { label: "Embeddings",  num: c.withSourceEmbeddings || 0, denom: total },
    { label: "Scores",      num: c.withScores || 0,          denom: total },
    { label: "Mapped",      num: (c.mapped && c.mapped.total) || 0, denom: total },
  ];
  const html = rows.map((r) => {
    const p = pct(r.num, r.denom);
    return `
      <div class="progress-row">
        <div class="progress-label">${r.label}</div>
        <div class="progress-track"><div class="progress-fill" style="width:${p}%"></div></div>
        <div class="progress-num">${fmt(r.num)} / ${fmt(r.denom)} <span class="text-slate-400">(${p}%)</span></div>
      </div>`;
  }).join("");
  $("progress-bars").innerHTML = html;
}

function renderStatusBreakdown(mapped) {
  const total = mapped.total || 0;
  const by = mapped.byStatus || {};
  const keys = ["unchecked", "approved", "rejected", "flagged", "invalid", "ignored", "suggested"];
  const rows = keys.filter((k) => by[k]).map((k) => {
    const n = by[k];
    return `
      <div class="flex items-center justify-between text-sm">
        <span class="status-pill status-${k}">${k}</span>
        <span class="font-mono">${fmt(n)} <span class="text-slate-400">(${pct(n, total)}%)</span></span>
      </div>`;
  }).join("") || `<div class="text-sm text-slate-500">No mappings yet.</div>`;
  $("status-breakdown").innerHTML = rows;
}

function renderMethods(methods) {
  const order = ["syntactic/jaro-winkler", "syntactic/token-sort", "syntactic/ngram-idf", "semantic/biolord"];
  const html = order.map((name) => {
    const m = methods[name] || { computed: false, coverage: 0 };
    const dot = m.computed
      ? `<span class="dot-yes">●</span> yes`
      : `<span class="dot-no">○</span> not yet`;
    return `
      <tr class="border-t border-slate-100">
        <td class="py-2 font-mono">${name}</td>
        <td>${dot}</td>
        <td class="font-mono">${m.computed ? fmt(m.coverage) + " concepts" : "—"}</td>
      </tr>`;
  }).join("");
  $("methods-body").innerHTML = html;
}

function renderSessions(sessions) {
  if (!sessions || !sessions.length) {
    $("sessions-list").innerHTML = `<div class="text-slate-500">No sessions recorded yet. The skill writes one entry per batch.</div>`;
    return;
  }
  const html = sessions.slice().reverse().map((s) => {
    const concepts = Array.isArray(s.concepts) ? s.concepts.length : (s.conceptsCount || "?");
    const outcomes = s.outcomes ? Object.entries(s.outcomes).map(([k, v]) => `${k}: ${v}`).join(" · ") : "";
    return `
      <div class="border border-slate-200 rounded p-3">
        <div class="flex items-center justify-between">
          <div class="font-medium">${s.subSkill || "session"}</div>
          <div class="text-xs text-slate-500 font-mono">${s.recordedAt || s.startedAt || ""}</div>
        </div>
        <div class="text-xs text-slate-500 mt-1">${concepts} concepts · ${outcomes}</div>
      </div>`;
  }).join("");
  $("sessions-list").innerHTML = html;
}

function renderFiles(state) {
  const f = state.files || {};
  const rows = [
    ["project.json",                   f.projectJson,        ""],
    ["source-concepts.csv",            f.sourceConceptsCsv,  `${fmt(state.counts.sourceConceptsTotal)} concepts`],
    ["mappings.json",                  f.mappingsJson,       `${fmt(state.counts.mapped.total)} mappings`],
    ["similarity-scores.parquet",      f.similarityScores,   state.scoresInfo ? `${fmt(state.scoresInfo.rows)} rows, ${(state.scoresInfo.sizeBytes/1024).toFixed(0)} KB` : ""],
    ["source_embeddings.parquet",      f.sourceEmbeddings,   `${fmt(state.counts.withSourceEmbeddings)} embeddings`],
    ["concept_embeddings.parquet (vocab)", f.omopEmbeddings, `${fmt(state.counts.omopEmbeddings)} OMOP embeddings`],
  ];
  $("files-body").innerHTML = rows.map(([name, present, details]) => `
    <tr class="border-t border-slate-100">
      <td class="py-2 font-mono">${name}</td>
      <td>${present ? `<span class="dot-yes">●</span> yes` : `<span class="dot-no">○</span> no`}</td>
      <td class="text-slate-600">${details}</td>
    </tr>`).join("");
  $("project-dir").textContent = state.projectDir || "—";
  $("vocab-dir").textContent   = state.vocabDir   || "—";
}

async function load() {
  let state;
  try {
    const res = await fetch("../state.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state = await res.json();
  } catch (e) {
    showError(`Could not load ../state.json (${e.message}). Run update_state.py to generate it.`);
    return;
  }

  $("project-name").textContent = state.projectName || "(unnamed)";
  $("last-updated").textContent = state.lastUpdatedAt || "—";

  const c = state.counts || {};
  $("kpi-source").textContent      = fmt(c.sourceConceptsTotal);
  $("kpi-source-sub").textContent  = (c.sourceVocabularies || []).join(", ") || "—";
  $("kpi-scores").textContent      = fmt(c.withScores);
  $("kpi-scores-sub").textContent  = `${pct(c.withScores, c.sourceConceptsTotal)}% of source`;
  $("kpi-embeddings").textContent  = fmt(c.withSourceEmbeddings);
  $("kpi-embeddings-sub").textContent = `${pct(c.withSourceEmbeddings, c.sourceConceptsTotal)}% of source`;
  const mapped = c.mapped || { total: 0, byStatus: {} };
  $("kpi-mapped").textContent      = fmt(mapped.total);
  $("kpi-mapped-sub").textContent  = `${pct(mapped.total, c.sourceConceptsTotal)}% · ${fmt(c.remaining)} remaining`;

  renderProgressBars(c);
  renderStatusBreakdown(mapped);
  renderMethods(state.methods || {});
  renderSessions(state.sessions);
  renderFiles(state);
}

load();
