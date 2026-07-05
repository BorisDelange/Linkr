// Concept Mapping — Review app.
// Reads ../state.json (written by update_state.py). Pure static, no build step.

const $ = (id) => document.getElementById(id);
const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US"));
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// project name / labels may be an i18n object like {en: "…", fr: "…"}
function i18n(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") return v.en || v.fr || Object.values(v)[0] || "";
  return String(v);
}

function showError(msg) {
  const el = $("error-banner");
  el.textContent = msg;
  el.classList.remove("hidden");
}

// ── date helpers ──────────────────────────────────────────────
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtDate(iso, withTime = true) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  const base = `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  if (!withTime) return base;
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${base}, ${hh}:${mm}`;
}
function relTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 90) return "just now";
  const m = s / 60;
  if (m < 90) return `${Math.round(m)} min ago`;
  const h = m / 60;
  if (h < 36) return `${Math.round(h)} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

// ── tabs ──────────────────────────────────────────────────────
function setTab(name) {
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab-link").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("hidden", p.id !== `tab-${name}`));
  window.scrollTo({ top: 0 });
}
function setSub(name) {
  document.querySelectorAll(".subtab").forEach((b) => b.classList.toggle("active", b.dataset.sub === name));
  document.querySelectorAll(".subpanel").forEach((p) => p.classList.toggle("hidden", p.id !== `sub-${name}`));
}
document.querySelectorAll(".tab-btn, .tab-link").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
document.querySelectorAll(".subtab").forEach((b) => b.addEventListener("click", () => setSub(b.dataset.sub)));
document.querySelectorAll("[data-goto]").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.goto)));

// ── method classification ─────────────────────────────────────
const KNOWN_METHODS = {
  "syntactic/jaro-winkler": { kind: "syntactic", label: "jaro-winkler" },
  "syntactic/token-sort":   { kind: "syntactic", label: "token-sort" },
  "syntactic/ngram-idf":    { kind: "syntactic", label: "ngram-idf" },
  "semantic/biolord":       { kind: "semantic",  label: "biolord" },
};
// category palette (shared across all pages)
const KIND_COLOR = {
  syntactic:   "#0ea5e9", // sky-500
  semantic:    "#8b5cf6", // violet-500
  statistical: "#f97316", // orange-500
  agentic:     "#10b981", // emerald-500
};

// ── overview ──────────────────────────────────────────────────
function stageStatus(done, total, hasAny) {
  if (total > 0 && done >= total) return { txt: "Complete", cls: "status-done", p: 100 };
  if (hasAny || done > 0) {
    const p = total > 0 ? pct(done, total) : (done > 0 ? 60 : 0);
    return { txt: total > 0 ? `In progress · ${p}%` : "In progress", cls: "status-run", p };
  }
  return { txt: "Not started", cls: "status-idle", p: 0 };
}
const li = (label, value) => `<li><span class="sl-label">${label}</span><span class="sl-value tnum">${value}</span></li>`;
function renderOverview(state) {
  const c = state.counts || {};
  const total = c.sourceConceptsTotal || 0;
  const vocabs = (c.sourceVocabularies || []).slice().sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }));
  const vocabTip = vocabs.length
    ? ` <span class="tip" tabindex="0" aria-label="${esc(vocabs.join(", "))}">?<span class="tip-box">${esc(vocabs.join(", "))}</span></span>`
    : "";

  // stage 1 — embeddings
  const emb = stageStatus(c.omopEmbeddings || 0, c.omopConceptsTotal || 0, (c.omopEmbeddings || 0) > 0);
  $("ov-emb-status").textContent = emb.txt; $("ov-emb-status").className = "stage-status " + emb.cls;
  $("ov-emb-lines").innerHTML =
    li("OMOP concepts", fmt(c.omopConceptsTotal)) +
    li("Embedded", fmt(c.omopEmbeddings));
  $("ov-emb-fill").style.width = emb.p + "%";

  // stage 2 — suggestions
  const sug = stageStatus(c.withScores || 0, total, (c.withScores || 0) > 0);
  $("ov-sug-status").textContent = sug.txt; $("ov-sug-status").className = "stage-status " + sug.cls;
  $("ov-sug-lines").innerHTML =
    li(`Source concepts${vocabTip}`, fmt(total)) +
    li("With a suggestion", `${fmt(c.withScores)} <span class="muted">(${pct(c.withScores, total)}%)</span>`);
  $("ov-sug-types").innerHTML = renderTypeLines(state.methods || {}, total);
  $("ov-sug-fill").style.width = sug.p + "%";

  // stage 3 — mappings
  const mapped = c.mapped || { total: 0 };
  const map = stageStatus(mapped.total || 0, total, (mapped.total || 0) > 0);
  $("ov-map-status").textContent = map.txt; $("ov-map-status").className = "stage-status " + map.cls;
  $("ov-map-lines").innerHTML =
    li("Authored", fmt(mapped.total)) +
    li("Remaining", fmt(c.remaining));
  $("ov-map-fill").style.width = map.p + "%";
}

// ── stage 1: embeddings ───────────────────────────────────────
function renderEmbeddings(state) {
  const c = state.counts || {};
  const info = state.omopEmbeddingsInfo || null;
  const present = !!(state.files && state.files.omopEmbeddings);
  const have = c.omopEmbeddings || 0;
  const total = c.omopConceptsTotal || 0;

  let status, cls, sub;
  if (!present || have === 0) { status = "Not started"; cls = "status-idle"; sub = "Run embed_concepts.py"; }
  else if (total > 0 && have < total) { status = "In progress"; cls = "status-run"; sub = `${fmt(total - have)} concepts remaining`; }
  else if (total > 0 && have >= total) { status = "Complete"; cls = "status-done"; sub = "All OMOP concepts embedded"; }
  else { status = "Present"; cls = "status-done"; sub = "CONCEPT.parquet not found — coverage unknown"; }

  $("emb-status").textContent = status; $("emb-status").className = "card-value " + cls;
  $("emb-status-sub").textContent = sub;
  $("emb-count").textContent = fmt(have);
  $("emb-count-sub").textContent = total > 0 ? `of ${fmt(total)} OMOP concepts` : "OMOP total unknown";

  const models = (info && info.model_ids) || [];
  $("emb-model").textContent = models.length ? models.join(", ") : "—";
  $("emb-model-sub").textContent = info && info.sizeBytes ? `${(info.sizeBytes / 1073741824).toFixed(2)} GB on disk` : "—";

  const p = total > 0 ? pct(have, total) : (have > 0 ? 100 : 0);
  $("emb-fill").style.width = p + "%";
  $("emb-num").innerHTML = total > 0
    ? `${fmt(have)} / ${fmt(total)} <span class="muted">(${p}%)</span>`
    : `${fmt(have)} <span class="muted">embeddings</span>`;

  const vd = state.vocabDir;
  $("emb-path").textContent = vd ? `${vd.replace(/\/$/, "")}/concept_embeddings.parquet` : "concept_embeddings.parquet";
}

// ── stage 2: suggestions ──────────────────────────────────────
function renderSuggestions(state) {
  const c = state.counts || {};
  const total = c.sourceConceptsTotal || 0;
  const ai = state.aiSuggestions || { concepts: 0, byEquivalence: {}, models: [], dictionaryConcepts: 0, dictionarySets: 0, dictionaryRepos: [] };
  const methods = state.methods || {};

  $("sug-covered").textContent = fmt(c.withScores);
  $("sug-covered-sub").textContent = `${pct(c.withScores, total)}% of source concepts`;
  $("sug-ai").textContent = fmt(ai.concepts || 0);
  $("sug-ai-sub").textContent = ai.concepts ? `${pct(ai.concepts, total)}% of source concepts` : "no AI suggestions yet";
  const models = (ai.models || []).map((m) => m.replace(/^ai\//, ""));
  if (models.length <= 1) {
    $("sug-model").textContent = models[0] || "—";
    $("sug-model-sub").textContent = ai.concepts ? "agentic review" : "—";
  } else {
    $("sug-model").innerHTML =
      `${esc(models[0])} <span class="tip tip-dark" tabindex="0" aria-label="${esc(models.join(", "))}">+${models.length - 1}<span class="tip-box">All models: ${esc(models.join(", "))}</span></span>`;
    $("sug-model-sub").textContent = `${models.length} models contributed`;
  }

  renderMethodCategories(methods, total);
  renderEquiv(ai);
}

// four fixed categories, each with the methods it can hold
const METHOD_CATEGORIES = [
  { key: "syntactic", label: "Syntactic", desc: "string similarity on names",
    methods: ["syntactic/jaro-winkler", "syntactic/token-sort", "syntactic/ngram-idf"] },
  { key: "semantic",  label: "Semantic",  desc: "meaning via BioLORD embeddings",
    methods: ["semantic/biolord"] },
  { key: "statistical", label: "Statistical", desc: "compares value distributions",
    methods: [], soon: true },
  { key: "agentic",   label: "Agentic (AI)", desc: "Claude reasons about the target",
    methods: [] /* ai/* filled dynamically */ },
];
const CHIP_LABEL = { syntactic: "Syntactic", semantic: "Semantic", statistical: "Statistical", agentic: "Agentic (AI)" };
function renderTypeLines(methods, total) {
  return METHOD_CATEGORIES.map((cat) => {
    const memberNames = cat.key === "agentic"
      ? Object.keys(methods).filter((n) => n.startsWith("ai/"))
      : cat.methods;
    // best coverage among computed methods in this category
    const covs = memberNames.filter((n) => methods[n] && methods[n].computed).map((n) => methods[n].coverage || 0);
    const best = covs.length ? Math.max(...covs) : 0;
    const color = KIND_COLOR[cat.key];
    let value;
    if (cat.soon) value = `<span class="muted">soon</span>`;
    else if (covs.length) value = `${pct(best, total)}%`;
    else value = `<span class="muted">—</span>`;
    return `<li style="--bullet:${color}">
      <span class="sl-label">${CHIP_LABEL[cat.key]}</span>
      <span class="sl-value tnum">${value}</span>
    </li>`;
  }).join("");
}

function renderMethodCategories(methods, total) {
  // split known/ai methods
  const aiMethods = Object.keys(methods).filter((n) => n.startsWith("ai/"));
  const html = METHOD_CATEGORIES.map((cat) => {
    const memberNames = cat.key === "agentic" ? aiMethods : cat.methods;
    const rows = memberNames.map((name) => {
      const meta = methods[name] || { computed: false, coverage: 0 };
      const label = name.startsWith("ai/") ? name.replace(/^ai\//, "") : (KNOWN_METHODS[name]?.label || name);
      const denom = total > 0 ? total : meta.coverage;
      const p = meta.computed && denom > 0 ? Math.min(pct(meta.coverage, denom), 100) : 0;
      const color = KIND_COLOR[cat.key] || "#94a3b8";
      const count = meta.computed
        ? `${fmt(meta.coverage)} <span class="muted">(${p}%)</span>`
        : "<span class='muted'>not run</span>";
      return `<div class="method-row">
        <span class="method-dot ${meta.computed ? "on" : ""}"></span>
        <span class="method-name">${esc(label)}</span>
        <span class="method-bar"><div style="width:${p}%;background:${color}"></div></span>
        <span class="method-count tnum">${count}</span>
      </div>`;
    }).join("");
    const anyComputed = memberNames.some((n) => methods[n] && methods[n].computed);
    const badge = cat.soon
      ? `<span class="cat-badge cat-soon">not implemented</span>`
      : anyComputed
        ? `<span class="cat-badge cat-on">computed</span>`
        : `<span class="cat-badge cat-off">not run</span>`;
    return `<div class="method-cat">
      <div class="method-cat-head">
        <span class="method-cat-dot" style="background:${KIND_COLOR[cat.key] || "#94a3b8"}"></span>
        <span class="method-cat-title">${esc(cat.label)}</span>
        <span class="method-cat-desc">${esc(cat.desc)}</span>
        ${badge}
      </div>
      ${rows || `<div class="method-cat-empty">${cat.soon ? "Will compare distribution stats (KS, Wasserstein) once available." : "No method run in this category."}</div>`}
    </div>`;
  }).join("");
  $("methods-by-category").innerHTML = html;
}

const EQUIV_ORDER = ["skos:exactMatch", "skos:closeMatch", "skos:broadMatch", "skos:narrowMatch", "skos:relatedMatch"];
const equivShort = (k) => k.replace(/^skos:/, "").replace(/Match$/, "");
function renderEquiv(ai) {
  const by = ai.byEquivalence || {};
  const total = Object.values(by).reduce((a, b) => a + b, 0);
  const keys = EQUIV_ORDER.filter((k) => by[k]).concat(Object.keys(by).filter((k) => !EQUIV_ORDER.includes(k)));
  $("ai-equiv-breakdown").innerHTML = keys.length
    ? keys.map((k) => {
        const n = by[k]; const p = total > 0 ? Math.round((n / total) * 100) : 0;
        const short = equivShort(k);
        return `<div class="equiv-row">
          <span class="equiv-pill equiv-${short}">${short}</span>
          <span class="equiv-bar-wrap">
            <span class="equiv-bar equiv-bar-${short}"><div style="width:${p}%"></div></span>
            <span class="equiv-count tnum">${fmt(n)}</span>
          </span>
        </div>`;
      }).join("")
    : `<div class="status-empty">No AI suggestions yet. Run /concept-mapping-ai in suggestions mode.</div>`;

  const dictEl = $("ai-dictionary");
  if (ai.dictionaryConcepts > 0) {
    const aligned = ai.dictionaryConcepts;
    const outside = Math.max((ai.concepts || 0) - aligned, 0);
    const denom = ai.concepts || 0;
    const repoLinks = (ai.dictionaryRepos || []).map((r) => {
      const href = /^https?:\/\//.test(r) ? r : null;
      const label = esc(r.replace(/^https?:\/\/(www\.)?/, ""));
      return href
        ? `<a class="dict-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${label}<span class="dict-link-ext" aria-hidden="true">↗</span></a>`
        : `<span>${esc(r)}</span>`;
    }).join("");
    dictEl.innerHTML = `
      <div class="dict-row"><span class="muted">Dictionary-aligned</span><span class="tnum">${fmt(aligned)} concepts <span class="muted">(${pct(aligned, denom)}%)</span> · ${fmt(ai.dictionarySets)} sets</span></div>
      <div class="dict-row"><span class="muted">Outside dictionary</span><span class="tnum">${fmt(outside)} concepts <span class="muted">(${pct(outside, denom)}%)</span></span></div>
      ${repoLinks ? `<div class="dict-repos"><span class="muted">Source:</span> ${repoLinks}</div>` : ""}`;
    dictEl.classList.remove("hidden");
  } else {
    dictEl.classList.add("hidden");
  }
}

// ── stage 3: mappings ─────────────────────────────────────────
const STATUS_ORDER = ["unchecked", "approved", "rejected", "flagged", "invalid", "ignored"];
function renderMappings(state) {
  const c = state.counts || {};
  const mapped = c.mapped || { total: 0, byStatus: {} };
  const by = mapped.byStatus || {};
  $("map-total").textContent = fmt(mapped.total);
  $("map-total-sub").textContent = `${pct(mapped.total, c.sourceConceptsTotal)}% of source concepts`;
  $("map-approved").textContent = fmt(by.approved || 0);
  $("map-remaining").textContent = fmt(c.remaining);

  const keys = STATUS_ORDER.filter((k) => by[k]).concat(Object.keys(by).filter((k) => !STATUS_ORDER.includes(k)));
  $("status-breakdown").innerHTML = keys.length
    ? keys.map((k) => `<div class="status-item">
        <span class="status-pill status-${esc(k)}">${esc(k)}</span>
        <span class="n tnum">${fmt(by[k])}</span>
      </div>`).join("")
    : `<div class="status-empty">No authored mappings yet — suggestions in stage 2 become mappings once accepted.</div>`;
}

// ── info: about / sessions / files ────────────────────────────
function renderInfo(state) {
  const sessions = state.sessions || [];
  const last = sessions.length ? (sessions[sessions.length - 1].recordedAt || sessions[sessions.length - 1].startedAt) : null;
  $("about-last").textContent = last ? fmtDate(last, false) : "—";
  $("about-last-sub").textContent = last ? relTime(last) : "no sessions yet";
  $("about-sessions").textContent = fmt(sessions.length);
  $("about-updated").textContent = fmtDate(state.lastUpdatedAt, false);

  const f = state.files || {};
  const store = [
    ["mappings.json", "the deliverable — authored mappings", f.mappingsJson],
    ["similarity-scores.parquet", "all suggestions (syntactic, semantic, AI)", f.similarityScores],
    ["source-concepts.csv", "the local codes + their metadata", f.sourceConceptsCsv],
    ["state.json", "this dashboard's data", true],
  ];
  $("about-storage").innerHTML = store.map(([name, what, present]) =>
    `<tr><td class="mono">${esc(name)}</td><td>${what}</td>
       <td>${present ? '<span class="file-yes">present</span>' : '<span class="file-no">missing</span>'}</td></tr>`
  ).join("");

  renderSessions(sessions);
  renderFiles(state);
}

function renderSessions(sessions) {
  const hint = $("sessions-hint");
  if (!sessions || !sessions.length) {
    if (hint) hint.classList.add("hidden");
    $("sessions-list").innerHTML = `<div class="status-empty">No sessions recorded yet. The skill writes one entry per batch.</div>`;
    return;
  }
  if (hint) hint.classList.remove("hidden");
  $("sessions-list").innerHTML = sessions.slice().reverse().map((s) => {
    const concepts = Array.isArray(s.concepts) ? s.concepts.join(", ") : (s.conceptsCount != null ? `${s.conceptsCount} concepts` : "");
    const when = s.recordedAt || s.startedAt;
    const tags = s.outcomes && typeof s.outcomes === "object"
      ? Object.entries(s.outcomes).map(([k, v]) => `<span class="session-tag">${esc(k)}: ${esc(v)}</span>`).join("")
      : "";
    return `<div class="session">
      <div class="session-top">
        <span class="session-skill">${esc(s.subSkill || "session")}</span>
        <span class="session-time">${esc(fmtDate(when))}</span>
      </div>
      ${concepts ? `<div class="session-body">${esc(concepts)}</div>` : ""}
      ${tags ? `<div class="session-tags">${tags}</div>` : ""}
    </div>`;
  }).join("");
}

function fileRow([name, present, details, tip]) {
  return `<tr><td class="mono">
      <span class="file-name">${esc(name)}</span>
      <span class="tip tip-dark" tabindex="0" aria-label="${esc(tip)}">?<span class="tip-box">${esc(tip)}</span></span>
     </td>
     <td>${present ? '<span class="file-yes">yes</span>' : '<span class="file-no">no</span>'}</td>
     <td>${esc(details)}</td></tr>`;
}
function renderFiles(state) {
  const f = state.files || {};
  const c = state.counts || {};
  const omopInfo = state.omopEmbeddingsInfo;
  const omopDetails = omopInfo
    ? `${fmt(c.omopEmbeddings)} / ${fmt(c.omopConceptsTotal)} embeddings · ${(omopInfo.sizeBytes / 1073741824).toFixed(2)} GB`
    : `${fmt(c.omopEmbeddings)} OMOP embeddings`;

  // files that live in the project directory
  const projectRows = [
    ["project.json", f.projectJson, "", "Project metadata: name, id, data source. Read at startup for context."],
    ["source-concepts.csv", f.sourceConceptsCsv, `${fmt(c.sourceConceptsTotal)} concepts`, "The local hospital codes to map, with their metadata (names, units, value stats)."],
    ["mappings.json", f.mappingsJson, `${fmt((c.mapped || {}).total)} mappings`, "The deliverable — authored source→OMOP mappings, each with a review status."],
    ["similarity-scores.parquet", f.similarityScores, state.scoresInfo ? `${fmt(state.scoresInfo.rows)} rows` : "", "All suggestions (syntactic, semantic, AI) — one row per candidate. Loaded in the Linkr Suggestions tab."],
    ["source_embeddings.parquet", f.sourceEmbeddings, `${fmt(c.withSourceEmbeddings)} embeddings`, "BioLORD vectors of the source concepts, reused when scores are extended."],
    ["state.json", true, "this dashboard's data", "The dashboard state this page reads. Regenerated by update_state.py."],
  ];
  // files that live in the shared vocabulary directory
  const vocabRows = [
    ["CONCEPT.parquet", !!(omopInfo || c.omopConceptsTotal), c.omopConceptsTotal ? `${fmt(c.omopConceptsTotal)} concepts` : "", "The OHDSI OMOP vocabulary — every standard concept and its attributes."],
    ["concept_embeddings.parquet", f.omopEmbeddings, omopDetails, "BioLORD vectors of every OMOP concept. Shared across projects; the prerequisite for semantic scores."],
  ];

  $("files-project").innerHTML = projectRows.map(fileRow).join("");
  $("files-vocab").innerHTML = vocabRows.map(fileRow).join("");
  $("project-dir").textContent = state.projectDir || "—";
  $("vocab-dir").textContent = state.vocabDir || "—";
}

// ── boot ──────────────────────────────────────────────────────
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

  $("project-name").textContent = i18n(state.projectName) || "(unnamed project)";
  const updated = state.lastUpdatedAt;
  $("last-updated").textContent = updated ? `${fmtDate(updated)} · ${relTime(updated)}` : "—";

  renderOverview(state);
  renderEmbeddings(state);
  renderSuggestions(state);
  renderMappings(state);
  renderInfo(state);

  setTab("overview");
  setSub("about");
}

load();
