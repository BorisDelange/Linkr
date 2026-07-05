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
    { label: "Authored mappings", num: (c.mapped && c.mapped.total) || 0, denom: total },
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
  const keys = ["unchecked", "approved", "rejected", "flagged", "invalid", "ignored"];
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

const EQUIV_ORDER = ["skos:exactMatch", "skos:closeMatch", "skos:broadMatch", "skos:narrowMatch", "skos:relatedMatch"];
const equivShort = (k) => k.replace(/^skos:/, "").replace(/Match$/, "");

function renderAiSuggestions(ai, sourceTotal) {
  ai = ai || { concepts: 0, rows: 0, byEquivalence: {}, models: [], dictionaryConcepts: 0, dictionarySets: 0, dictionaryRepos: [] };
  $("kpi-ai-concepts").textContent = fmt(ai.concepts);
  $("kpi-ai-concepts-sub").textContent = sourceTotal > 0
    ? `${pct(ai.concepts, sourceTotal)}% of source · ${fmt(ai.rows)} candidate rows`
    : `${fmt(ai.rows)} candidate rows`;

  const models = ai.models || [];
  $("kpi-ai-model").textContent = models.length ? models.map((m) => m.replace(/^ai\//, "")).join(", ") : "—";
  $("kpi-ai-model-sub").textContent = "awaiting review in the Linkr UI";

  const byEquiv = ai.byEquivalence || {};
  const equivKeys = EQUIV_ORDER.filter((k) => byEquiv[k]).concat(
    Object.keys(byEquiv).filter((k) => !EQUIV_ORDER.includes(k))
  );
  const equivHtml = equivKeys.length
    ? equivKeys.map((k) => `
        <div class="flex items-center justify-between text-sm">
          <span class="equiv-pill equiv-${equivShort(k)}">${equivShort(k)}</span>
          <span class="font-mono">${fmt(byEquiv[k])}</span>
        </div>`).join("")
    : `<div class="text-sm text-slate-500">No AI suggestions yet. Run /concept-mapping-ai in suggestions mode.</div>`;
  $("ai-equiv-breakdown").innerHTML = equivHtml;

  const dictEl = $("ai-dictionary");
  if (ai.dictionaryConcepts > 0) {
    const repos = (ai.dictionaryRepos || []).join(", ");
    dictEl.innerHTML = `
      <div class="flex items-center justify-between">
        <span class="text-slate-600">Dictionary-aligned</span>
        <span class="font-mono">${fmt(ai.dictionaryConcepts)} concepts · ${fmt(ai.dictionarySets)} sets</span>
      </div>
      <div class="flex items-center justify-between">
        <span class="text-slate-600">Outside dictionary</span>
        <span class="font-mono">${fmt(Math.max(ai.concepts - ai.dictionaryConcepts, 0))} concepts</span>
      </div>
      ${repos ? `<div class="text-xs text-slate-400 mt-1">repos: ${repos}</div>` : ""}`;
    dictEl.classList.remove("hidden");
  } else {
    dictEl.classList.add("hidden");
  }
}

function renderMethods(methods, sourceTotal) {
  const order = ["syntactic/jaro-winkler", "syntactic/token-sort", "syntactic/ngram-idf", "semantic/biolord"];
  const extras = Object.keys(methods).filter((k) => !order.includes(k)).sort();
  const html = order.concat(extras).map((name) => {
    const m = methods[name] || { computed: false, coverage: 0 };
    const dot = m.computed
      ? `<span class="dot-yes">●</span> yes`
      : `<span class="dot-no">○</span> not yet`;
    const cov = m.coverage || 0;
    const p = sourceTotal > 0 ? pct(cov, sourceTotal) : 0;
    const barColor = !m.computed
      ? "bg-slate-200"
      : p >= 100
        ? "bg-emerald-500"
        : p > 0
          ? "bg-amber-500"
          : "bg-slate-200";
    const coverageCell = m.computed
      ? `<div class="flex items-center gap-2">
           <div class="flex-1 max-w-[160px] h-2 bg-slate-100 rounded overflow-hidden">
             <div class="h-full ${barColor}" style="width:${p}%"></div>
           </div>
           <div class="font-mono whitespace-nowrap">${fmt(cov)} / ${fmt(sourceTotal)} <span class="text-slate-400">(${p}%)</span></div>
         </div>`
      : `<span class="text-slate-400">—</span>`;
    return `
      <tr class="border-t border-slate-100">
        <td class="py-2 font-mono">${name}</td>
        <td>${dot}</td>
        <td>${coverageCell}</td>
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

function renderOmopEmbeddings(state) {
  const c = state.counts || {};
  const info = state.omopEmbeddingsInfo || null;
  const present = !!(state.files && state.files.omopEmbeddings);
  const have = c.omopEmbeddings || 0;
  const total = c.omopConceptsTotal || 0;

  let status, statusClass, sub;
  if (!present || have === 0) {
    status = "Not started";
    statusClass = "text-slate-500";
    sub = "Run embed_concepts.py";
  } else if (total > 0 && have < total) {
    status = "In progress";
    statusClass = "text-amber-600";
    sub = `${fmt(total - have)} concepts remaining`;
  } else if (total > 0 && have >= total) {
    status = "Complete";
    statusClass = "text-emerald-600";
    sub = "All OMOP concepts embedded";
  } else {
    status = "Present";
    statusClass = "text-emerald-600";
    sub = "CONCEPT.parquet not found — coverage unknown";
  }

  const statusEl = $("kpi-omop-status");
  statusEl.textContent = status;
  statusEl.className = `card-value ${statusClass}`;
  $("kpi-omop-status-sub").textContent = sub;

  $("kpi-omop-count").textContent = fmt(have);
  $("kpi-omop-count-sub").textContent = total > 0 ? `of ${fmt(total)} OMOP concepts` : "OMOP total unknown";

  const models = (info && info.model_ids) || [];
  $("kpi-omop-model").textContent = models.length ? models.join(", ") : "—";
  $("kpi-omop-model-sub").textContent = info && info.sizeBytes
    ? `${(info.sizeBytes / (1024 * 1024 * 1024)).toFixed(2)} GB on disk`
    : "—";

  const p = total > 0 ? pct(have, total) : (have > 0 ? 100 : 0);
  $("omop-progress-fill").style.width = `${p}%`;
  $("omop-progress-num").innerHTML = total > 0
    ? `${fmt(have)} / ${fmt(total)} <span class="text-slate-400">(${p}%)</span>`
    : `${fmt(have)} <span class="text-slate-400">embeddings</span>`;
}

function renderFiles(state) {
  const f = state.files || {};
  const omopInfo = state.omopEmbeddingsInfo;
  const omopDetails = omopInfo
    ? `${fmt(state.counts.omopEmbeddings)} / ${fmt(state.counts.omopConceptsTotal)} embeddings · ${(omopInfo.sizeBytes / (1024*1024*1024)).toFixed(2)} GB${omopInfo.model_ids ? ` · ${omopInfo.model_ids.join(", ")}` : ""}`
    : `${fmt(state.counts.omopEmbeddings)} OMOP embeddings`;
  const rows = [
    ["project.json",                   f.projectJson,        ""],
    ["source-concepts.csv",            f.sourceConceptsCsv,  `${fmt(state.counts.sourceConceptsTotal)} concepts`],
    ["mappings.json",                  f.mappingsJson,       `${fmt(state.counts.mapped.total)} mappings`],
    ["similarity-scores.parquet",      f.similarityScores,   state.scoresInfo ? `${fmt(state.scoresInfo.rows)} rows, ${(state.scoresInfo.sizeBytes/1024).toFixed(0)} KB` : ""],
    ["source_embeddings.parquet",      f.sourceEmbeddings,   `${fmt(state.counts.withSourceEmbeddings)} embeddings`],
    ["concept_embeddings.parquet (vocab)", f.omopEmbeddings, omopDetails],
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

  renderOmopEmbeddings(state);
  renderProgressBars(c);
  renderStatusBreakdown(mapped);
  renderAiSuggestions(state.aiSuggestions, c.sourceConceptsTotal || 0);
  renderMethods(state.methods || {}, c.sourceConceptsTotal || 0);
  renderSessions(state.sessions);
  renderFiles(state);
}

load();
