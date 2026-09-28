/*
 * Behaviour of the standalone catalog page. Inlined as-is by export-html.ts
 * (imported `?raw`), after TABLE_HELPERS and the explorer engine
 * (catalog-explore.js, `export` stripped), inside an IIFE, so it runs in any
 * browser with no build step and no network.
 *
 * Globals the page declares before it: DATA (published crossings, variables,
 * concept list, totals — see lib/data-catalog/publish.ts), META, ICONS.
 *
 * This file is the page's glue: tabs, the JSON-LD viewer, the schema, and the
 * Explore tab's controls around the engine, which decides what to draw.
 */

// The in-app preview is a sandboxed iframe: without allow-downloads the browser drops the click silently.
function downloadFile(fileName, text, type) {
  try {
    var url = URL.createObjectURL(new Blob([type === 'text/csv' ? '﻿' + text : text], { type: type + ';charset=utf-8' }));
    var a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function() { URL.revokeObjectURL(url); }, 10000);
  } catch (err) { /* nothing to fall back to without a download permission */ }
}
function downloadCsv(fileName, text) { downloadFile(fileName, text, 'text/csv'); }
function $(id) { return document.getElementById(id); }
function each(list, fn) { Array.prototype.forEach.call(list, fn); }

// ---- Tabs ----
var tabs = document.querySelectorAll('.tab');
each(tabs, function(t) {
  t.addEventListener('click', function() {
    each(tabs, function(x) { x.classList.toggle('active', x === t); x.setAttribute('aria-selected', x === t ? 'true' : 'false'); });
    each(document.querySelectorAll('.tab-content'), function(c) { c.classList.toggle('active', c.id === 'tab-' + t.dataset.tab); });
    // Charts are sized on their container, which has no width while its tab is hidden.
    if (t.dataset.tab === 'explore') drawCharts();
  });
});

// ---- JSON-LD viewer ----
var overlay = $('jsonld-overlay');
function closeOverlay() { overlay.classList.remove('open'); }
$('open-jsonld').addEventListener('click', function() { overlay.classList.add('open'); });
$('close-jsonld').addEventListener('click', closeOverlay);
overlay.addEventListener('click', function(e) { if (e.target === overlay) closeOverlay(); });
document.addEventListener('keydown', function(e) { if (e.key === 'Escape') closeOverlay(); });
$('download-jsonld').addEventListener('click', function() {
  downloadFile(META.fileBase + '-metadata.jsonld', $('jsonld-code').textContent || '', 'application/ld+json');
});
var copyBtn = $('copy-jsonld');
copyBtn.addEventListener('click', function() {
  var code = $('jsonld-code');
  var done = function() {
    var label = copyBtn.querySelector('span');
    label.textContent = L.copied;
    setTimeout(function() { label.textContent = L.copy; }, 1500);
  };
  // The in-app preview is a sandboxed iframe without clipboard access.
  var fallback = function() {
    var range = document.createRange();
    range.selectNodeContents(code);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    try { if (document.execCommand('copy')) done(); } catch (err) { /* selection stays for a manual copy */ }
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(code.textContent || '').then(done, fallback);
  } else fallback();
});

// ---- Schema: tables / diagram, table filter, TOC and diagram navigation ----
var schemaSeg = $('schema-seg');
function showPane(name) {
  if (!schemaSeg) return;
  each(schemaSeg.querySelectorAll('button'), function(b) { b.classList.toggle('active', b.dataset.pane === name); });
  each(document.querySelectorAll('.schema-pane'), function(p) { p.hidden = p.dataset.pane !== name; });
}
if (schemaSeg) schemaSeg.addEventListener('click', function(e) {
  var b = e.target.closest('button');
  if (b) showPane(b.dataset.pane);
});
function goToTable(id) {
  var card = $(id);
  if (!card) return;
  showPane('tables');
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  card.classList.add('flash');
  setTimeout(function() { card.classList.remove('flash'); }, 1200);
  each(document.querySelectorAll('.toc-item'), function(it) { it.classList.toggle('active', it.dataset.target === id); });
}
each(document.querySelectorAll('.toc-item'), function(it) {
  it.addEventListener('click', function(e) { e.preventDefault(); goToTable(it.dataset.target); });
});
each(document.querySelectorAll('.erd .node'), function(n) {
  n.addEventListener('click', function() { goToTable(n.getAttribute('data-target')); });
});
var tocFilter = $('toc-filter');
if (tocFilter) tocFilter.addEventListener('input', function() {
  var q = tocFilter.value.trim().toLowerCase();
  each(document.querySelectorAll('.toc-item'), function(it) {
    var show = !q || it.dataset.name.indexOf(q) !== -1;
    it.style.display = show ? '' : 'none';
    var card = $(it.dataset.target);
    if (card) card.style.display = show ? '' : 'none';
  });
});

// ---- Tooltip: any element with data-tip (trusted HTML, escaped into the attribute), or
// with data-full, whose own text shows only while it is cut short by an ellipsis ----
var tip = document.createElement('div');
tip.className = 'tip';
document.body.appendChild(tip);
var tipTarget = null;
document.addEventListener('mouseover', function(e) {
  var t = e.target && e.target.closest ? e.target.closest('[data-tip],[data-full]') : null;
  if (t && !t.hasAttribute('data-tip')) {
    var text = t.querySelector('span') || t;
    if (text.scrollWidth <= text.clientWidth) t = null;
  }
  if (t === tipTarget) return;
  tipTarget = t;
  if (!t) { tip.classList.remove('on'); return; }
  tip.innerHTML = t.hasAttribute('data-tip') ? t.getAttribute('data-tip') : escHtml(t.getAttribute('data-full'));
  tip.classList.add('on');
});
document.addEventListener('mousemove', function(e) {
  if (!tipTarget) return;
  var r = tip.getBoundingClientRect();
  var x = e.clientX + 14, y = e.clientY + 14;
  if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - 14;
  if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - 14;
  tip.style.transform = 'translate(' + Math.max(8, x) + 'px,' + Math.max(8, y) + 'px)';
});

// ---- Explore ----
var XP = createExplorer(DATA, {
  text: TX,
  locale: L.locale,
  fileBase: META.fileBase,
  conceptNote: META.conceptNote,
  dark: function() { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); },
});
var S = XP.S, V = XP.V;
var side = $('xp-side');
var main = $('xp-main');
var current = null; // the last view, for chart redraws and CSV buttons

var GROUP_LABEL = { 1: L.group_1, 2: L.group_2, 3: L.group_3 };
/** A page text with its `{name}` placeholders filled. */
function lx(key, vars) { return L[key].replace(/\{(\w+)\}/g, function(m, k) { return vars && k in vars ? vars[k] : m; }); }
var ICON_OF = { user: 'user', stethoscope: 'stethoscope', activity: 'activity', tags: 'tags', layers: 'layers', trendingUp: 'trendingUp', barChart: 'barChart', sigma: 'sigma', shield: 'shield', grid: 'table' };

function dot(v) { return '<i class="vdot" style="background:' + VARIABLE_HEX[v] + '"></i>'; }
function vbadge(v) { return '<span class="vbadge" style="--vc:' + VARIABLE_HEX[v] + '">' + escHtml(XP.varLabel(v)) + '</span>'; }

/** First and last day of a period modality, which spans `step` units from the one it names. */
function periodBounds(code) {
  var step = (V.period && V.period.step) || 1;
  var q = /^(\d{4})-Q([1-4])$/.exec(code), m = /^(\d{4})-(\d{2})$/.exec(code);
  var first, lastIdx;
  if (q) { first = Number(q[1]) * 12 + (Number(q[2]) - 1) * 3; lastIdx = first + 3 * step - 1; }
  else if (m) { first = Number(m[1]) * 12 + Number(m[2]) - 1; lastIdx = first + step - 1; }
  else { first = Number(code) * 12; lastIdx = first + 12 * step - 1; }
  var ly = Math.floor(lastIdx / 12), lm = lastIdx % 12 + 1;
  return [Math.floor(first / 12) + '-' + pad2(first % 12 + 1) + '-01', ly + '-' + pad2(lm) + '-' + lastDay(ly, lm)];
}
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function lastDay(y, m) { return pad2(new Date(Date.UTC(Number(y), m, 0)).getUTCDate()); }

function crossingPicker() {
  var h = '<select class="select full" data-act="crossing" aria-label="' + escHtml(L.variables_aria) + '">';
  XP.options().forEach(function(g) {
    h += '<optgroup label="' + GROUP_LABEL[g.size] + '">' + g.items.map(function(it) {
      return '<option value="' + it.id + '"' + (S.crossing === it.id ? ' selected' : '') + '>' + escHtml(it.vars.map(XP.varLabel).join(' × ')) + '</option>';
    }).join('') + '</optgroup>';
  });
  return h + '</select><div class="vbadges">' + XP.varsOf(S.crossing).map(vbadge).join('<span class="x">×</span>') + '</div>';
}

/** The dropdown open in the sidebar (a variable id, or PIN for the pinned value), and what its search box holds. */
var openMs = null, msQuery = {};
var PIN = '_pin';
/** How many matching values a dropdown lists: thousands of concepts would freeze the page on every redraw. */
var LIST_LIMIT = 200;

/** Lower case, accents off: "hemato" finds "Hématologie". */
function fold(s) { return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }

/** Indices of the names matching the search, and how many more there were past the limit. */
function matching(names, query) {
  var q = fold((query || '').trim()), hits = [], more = 0;
  for (var i = 0; i < names.length; i++) {
    if (q && fold(names[i]).indexOf(q) === -1) continue;
    if (hits.length < LIST_LIMIT) hits.push(i);
    else more++;
  }
  return { hits: hits, more: more };
}
function listFooter(m) {
  if (!m.shown) return '<div class="opt-note">' + escHtml(L.no_match) + '</div>';
  return m.more ? '<div class="opt-note">' + escHtml(lx('more_matches', { n: fmt(m.more) })) + '</div>' : '';
}

function checksHtml(v) {
  var vr = V[v], sel = S.sel[v], m = matching(vr.names, msQuery[v]);
  return m.hits.map(function(i) {
    return '<label class="check" data-full="' + escHtml(vr.names[i]) + '"><input type="checkbox" data-act="sel" data-v="' + v + '" data-i="' + i + '"' + (!sel || sel[i] ? ' checked' : '') + '><span>' + escHtml(vr.names[i]) + '</span></label>';
  }).join('') + listFooter({ shown: m.hits.length, more: m.more });
}

function pinOptionsHtml() {
  var vr = V[S.pin], m = matching(vr.names, msQuery[PIN]);
  var h = XP.canUnpin() && !(msQuery[PIN] || '').trim()
    ? '<button type="button" class="opt' + (S.pinVal == null ? ' on' : '') + '" data-act="pin-pick" data-i="">' + escHtml(L.all) + '</button>' : '';
  return h + m.hits.map(function(i) {
    return '<button type="button" class="opt' + (S.pinVal === i ? ' on' : '') + '" data-act="pin-pick" data-i="' + i + '" data-full="' + escHtml(vr.names[i]) + '">' + escHtml(vr.names[i]) + '</button>';
  }).join('') + listFooter({ shown: m.hits.length, more: m.more });
}

function nominalFilter(v) {
  var vr = V[v], sel = S.sel[v];
  var few = vr.mods.length <= 10 && !vr.names.some(function(nm) { return nm.length > 24; });
  var h = '<div class="flt"><div class="flt-head">' + dot(v) + '<span>' + escHtml(vr.label) + '</span></div>';
  if (few) {
    h += '<div class="pills">' + vr.names.map(function(nm, i) {
      var on = !sel || !!sel[i];
      return '<button type="button" class="pill-t' + (on ? ' on' : '') + '" style="--vc:' + VARIABLE_HEX[v] + '" data-act="sel" data-v="' + v + '" data-i="' + i + '">' + escHtml(nm) + '</button>';
    }).join('') + '</div>';
  } else {
    // A dropdown with a search box: long lists (services, concept categories) stay out of the way.
    var n = sel ? Object.keys(sel).length : vr.mods.length;
    var label = !sel ? L.all : n === 1 ? vr.names[Number(Object.keys(sel)[0])] : lx('n_selected', { n: n });
    h += '<div class="ms' + (openMs === v ? ' open' : '') + '"><button type="button" class="select ms-btn" data-act="ms-toggle" data-v="' + v + '" data-full="' + escHtml(label) + '"><span>' + escHtml(label) + '</span>' + ICONS.chevron + '</button>';
    if (openMs === v) {
      h += '<div class="ms-panel"><input type="search" class="input" data-act="ms-search" data-v="' + v + '" placeholder="' + escHtml(L.search) + '" value="' + escHtml(msQuery[v] || '') + '" autocomplete="off">'
        + '<div class="ms-links"><button type="button" class="link" data-act="sel-all" data-v="' + v + '">' + escHtml(L.all) + '</button><button type="button" class="link" data-act="sel-none" data-v="' + v + '">' + escHtml(L.none) + '</button><span class="spacer"></span><span class="num">' + n + ' / ' + vr.mods.length + '</span></div>'
        + '<div class="checks" data-list="' + v + '">' + checksHtml(v) + '</div></div>';
    }
    h += '</div>';
  }
  return h + '<div class="hint">' + escHtml(L.keep_one_hint) + '</div></div>';
}

function periodFilter() {
  var vr = V.period, n = vr.mods.length;
  var r = S.range || [0, n - 1];
  var h = '<div class="flt"><div class="flt-head">' + dot('period') + '<span>' + escHtml(vr.label) + '</span><span class="spacer"></span>'
    + '<div class="seg mini" data-act="pmode"><button type="button" data-v="slider"' + (S.periodMode === 'slider' ? ' class="active"' : '') + '>' + escHtml(L.slider) + '</button><button type="button" data-v="calendar"' + (S.periodMode === 'calendar' ? ' class="active"' : '') + '>' + escHtml(L.calendar) + '</button></div></div>';
  if (S.periodMode === 'slider') {
    h += '<div class="range"><div class="range-track"><div class="range-fill" id="range-fill"></div></div>'
      + '<input type="range" min="0" max="' + (n - 1) + '" value="' + r[0] + '" data-act="range" data-end="0" aria-label="' + escHtml(L.first_period) + '">'
      + '<input type="range" min="0" max="' + (n - 1) + '" value="' + r[1] + '" data-act="range" data-end="1" aria-label="' + escHtml(L.last_period) + '"></div>'
      + '<div class="range-labels"><span id="range-lo">' + escHtml(vr.names[r[0]]) + '</span><span id="range-hi">' + escHtml(vr.names[r[1]]) + '</span></div>';
  } else {
    var min = periodBounds(vr.mods[0])[0], max = periodBounds(vr.mods[n - 1])[1];
    h += '<div class="cal"><label><span>' + escHtml(L.from) + '</span><input type="date" class="input" data-act="cal" data-end="0" min="' + min + '" max="' + max + '" value="' + periodBounds(vr.mods[r[0]])[0] + '"></label>'
      + '<label><span>' + escHtml(L.to) + '</span><input type="date" class="input" data-act="cal" data-end="1" min="' + min + '" max="' + max + '" value="' + periodBounds(vr.mods[r[1]])[1] + '"></label></div>'
      + '<div class="hint">' + escHtml(L.cal_hint) + '</div>';
  }
  var presets = [[L.all, 0]];
  if (n > 12) presets.push([lx('last_n', { n: 12 }), n - 12]);
  if (n > 5 && vr.granularity === 'year') presets.push([lx('last_n', { n: 5 }), n - 5]);
  if (n > 24 && vr.granularity === 'month') presets.push([lx('last_n', { n: 24 }), n - 24]);
  h += '<div class="presets">' + presets.map(function(pr) { return '<button type="button" class="pill-t' + (presetOn(pr[1]) ? ' on' : '') + '" data-act="range-preset" data-v="' + pr[1] + '">' + escHtml(pr[0]) + '</button>'; }).join('') + '</div>';
  return h + '</div>';
}

function conceptFilter() {
  var cv = V.concept;
  if (cv && cv.level !== 'concept' && !XP.isListView()) return nominalFilter('concept');
  var cats = XP.conceptCategories();
  var h = '<div class="flt"><div class="flt-head">' + dot('concept') + '<span>' + escHtml(XP.varLabel('concept')) + '</span></div>'
    + '<input type="search" class="input flt-search" id="concept-q" data-act="cq" placeholder="' + escHtml(L.search_concepts) + '" value="' + escHtml(S.cq) + '" autocomplete="off">';
  if (cats.length) h += '<select class="select" data-act="ccat"><option value="">' + escHtml(L.all_categories) + '</option>' + cats.map(function(c) { return '<option value="' + escHtml(c) + '"' + (S.ccat === c ? ' selected' : '') + '>' + escHtml(c) + '</option>'; }).join('') + '</select>';
  return h + '</div>';
}

/** A three-variable crossing shows one value of one of its variables at a time. */
function pinControl(vars) {
  var vr = V[S.pin];
  var h = '<div class="flt pin"><div class="flt-head">' + dot(S.pin) + '<span>' + escHtml(L.pin_title) + '</span></div>'
    + '<select class="select" data-act="pin">' + vars.map(function(v) { return '<option value="' + v + '"' + (S.pin === v ? ' selected' : '') + '>' + escHtml(XP.varLabel(v)) + '</option>'; }).join('') + '</select>'
    + '<div class="ms' + (openMs === PIN ? ' open' : '') + '"><button type="button" class="select ms-btn" data-act="ms-toggle" data-v="' + PIN + '" data-full="' + escHtml(S.pinVal == null ? L.all : vr.names[S.pinVal]) + '"><span>' + escHtml(S.pinVal == null ? L.all : vr.names[S.pinVal]) + '</span>' + ICONS.chevron + '</button>'
    + (openMs === PIN ? '<div class="ms-panel"><input type="search" class="input" data-act="ms-search" data-v="' + PIN + '" placeholder="' + escHtml(L.search) + '" value="' + escHtml(msQuery[PIN] || '') + '" autocomplete="off">'
      + '<div class="checks opts" data-list="' + PIN + '">' + pinOptionsHtml() + '</div></div>' : '')
    + '</div>'
    + '<div class="hint">' + escHtml(XP.canUnpin() ? L.pin_hint_all : L.pin_hint) + '</div></div>';
  return h;
}

function renderSide() {
  var vars = XP.varsOf(S.crossing);
  var h = '<div class="xp-sec"><div class="xp-sec-t">' + escHtml(L.variables) + '</div>' + crossingPicker() + '</div>';
  var ms = XP.measures();
  if (ms.indexOf(S.metric) === -1) S.metric = 'patients';
  // Patients alone leave nothing to choose; three labels no longer fit side by side.
  if (ms.length === 2) {
    h += '<div class="xp-sec"><div class="xp-sec-t">' + escHtml(L.count) + '</div><div class="seg full" data-act="metric">' + ms.map(function(m) {
      return '<button type="button" data-v="' + m + '"' + (S.metric === m ? ' class="active"' : '') + '>' + escHtml(XP.measureLabel(m)) + '</button>';
    }).join('') + '</div></div>';
  } else if (ms.length > 2) {
    h += '<div class="xp-sec"><div class="xp-sec-t">' + escHtml(L.count) + '</div><select class="select full" data-act="metric">' + ms.map(function(m) {
      return '<option value="' + m + '"' + (S.metric === m ? ' selected' : '') + '>' + escHtml(XP.measureLabel(m)) + '</option>';
    }).join('') + '</select></div>';
  }

  var filters = (S.pin ? pinControl(vars) : '') + vars.filter(function(v) { return v !== S.pin; }).map(function(v) {
    if (v === 'period') return periodFilter();
    if (v === 'concept') return conceptFilter();
    return nominalFilter(v);
  }).join('');
  h += '<div class="xp-sec"><div class="xp-sec-t">' + escHtml(L.filters) + '</div>' + filters + '</div>';
  h += '<button type="button" class="btn full" data-act="reset">' + ICONS.x + escHtml(L.reset_filters) + '</button>';
  side.innerHTML = h;
  paintRange();
  placePanel();
  var msSearch = side.querySelector('[data-act="ms-search"]');
  if (msSearch && msFocus) { msSearch.focus(); msSearch.setSelectionRange(msSearch.value.length, msSearch.value.length); }
  msFocus = false;
}
var msFocus = false;

/**
 * A dropdown's panel floats over the page below its button (above when there
 * is more room there), as wide as its longest name allows: inside the sidebar
 * or a table, which scroll, it could be no wider than them without being cut off.
 */
function placeFloating(panel, anchor) {
  var r = anchor.getBoundingClientRect();
  var below = window.innerHeight - r.bottom - 12, above = r.top - 12;
  panel.style.minWidth = Math.min(r.width, window.innerWidth - 16) + 'px';
  panel.style.maxWidth = Math.min(520, window.innerWidth - 16) + 'px';
  panel.style.left = r.left + 'px';
  if (below >= 260 || below >= above) {
    panel.style.top = (r.bottom + 4) + 'px';
    panel.style.bottom = '';
    panel.style.maxHeight = below + 'px';
  } else {
    panel.style.top = '';
    panel.style.bottom = (window.innerHeight - r.top + 4) + 'px';
    panel.style.maxHeight = above + 'px';
  }
  var w = panel.getBoundingClientRect().width;
  if (r.left + w > window.innerWidth - 8) panel.style.left = Math.max(8, window.innerWidth - 8 - w) + 'px';
}
function placePanel() {
  var panel = side.querySelector('.ms.open .ms-panel');
  if (panel) placeFloating(panel, panel.parentNode.querySelector('.ms-btn'));
  if (dd) placeFloating(dd.panel, dd.btn);
}
side.addEventListener('scroll', placePanel);
window.addEventListener('scroll', placePanel, true);
window.addEventListener('resize', placePanel);

// ---- Dropdowns: every <select> of the page shows as the page's own dropdown ----
// The native select stays in the page, hidden, and receives the pick as a
// 'change' event: whatever listens to it (filters, table paging) is unchanged.
var dd = null; // the open one: { sel, btn, panel, query, active }
var DD_SEARCH_FROM = 10;

function selectedText(sel) { var o = sel.options[sel.selectedIndex]; return o ? o.text : ''; }
function setDdLabel(btn, text) { btn.firstChild.textContent = text; btn.setAttribute('data-full', text); }
/** Buttons show their select's value again, after code set it (a filter reset). */
function syncDropdowns(root) {
  each(root.querySelectorAll('select[data-dd]'), function(sel) {
    if (sel.previousSibling && sel.previousSibling.classList.contains('dd-btn')) setDdLabel(sel.previousSibling, selectedText(sel));
  });
}

function enhanceSelect(sel) {
  sel.setAttribute('data-dd', '');
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = sel.className + ' ms-btn dd-btn';
  btn.setAttribute('aria-haspopup', 'listbox');
  if (sel.getAttribute('aria-label')) btn.setAttribute('aria-label', sel.getAttribute('aria-label'));
  btn.innerHTML = '<span></span>' + ICONS.chevron;
  setDdLabel(btn, selectedText(sel));
  btn.addEventListener('click', function() { if (dd && dd.sel === sel) closeDd(); else openDd(sel, btn); });
  sel.addEventListener('change', function() { setDdLabel(btn, selectedText(sel)); });
  sel.style.display = 'none';
  sel.parentNode.insertBefore(btn, sel);
}

function openDd(sel, btn) {
  closeDd();
  var panel = document.createElement('div');
  panel.className = 'ms-panel dd-panel';
  panel.innerHTML = (sel.options.length > DD_SEARCH_FROM ? '<input type="search" class="input dd-search" placeholder="' + escHtml(L.search) + '" autocomplete="off">' : '')
    + '<div class="checks opts dd-list" role="listbox"></div>';
  document.body.appendChild(panel);
  dd = { sel: sel, btn: btn, panel: panel, query: '', active: -1 };
  btn.classList.add('open');
  renderDdList();
  placeFloating(panel, btn);
  var on = panel.querySelector('.opt.on');
  if (on) on.scrollIntoView({ block: 'nearest' });
  var input = panel.querySelector('.dd-search');
  if (input) {
    input.focus();
    input.addEventListener('input', function() { dd.query = input.value; renderDdList(); });
  }
  panel.addEventListener('click', function(e) {
    var o = e.target.closest('.opt');
    if (o) pickDd(Number(o.dataset.i));
  });
}

function renderDdList() {
  var q = fold(dd.query.trim()), h = '', shown = 0, more = 0, group = null;
  each(dd.sel.options, function(o, i) {
    if (q && fold(o.text).indexOf(q) === -1) return;
    if (shown >= LIST_LIMIT) { more++; return; }
    var g = o.parentNode.tagName === 'OPTGROUP' ? o.parentNode.label : null;
    if (g && g !== group) h += '<div class="opt-group">' + escHtml(g) + '</div>';
    group = g;
    h += '<button type="button" class="opt' + (i === dd.sel.selectedIndex ? ' on' : '') + '" role="option" data-i="' + i + '" data-full="' + escHtml(o.text) + '">' + escHtml(o.text) + '</button>';
    shown++;
  });
  dd.panel.querySelector('.dd-list').innerHTML = h + listFooter({ shown: shown, more: more });
  dd.active = -1;
}

function pickDd(i) {
  var sel = dd.sel, btn = dd.btn;
  closeDd();
  btn.focus();
  if (sel.selectedIndex === i) return;
  sel.selectedIndex = i;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
}

function closeDd() {
  if (!dd) return;
  dd.panel.remove();
  dd.btn.classList.remove('open');
  dd = null;
}

document.addEventListener('click', function(e) {
  if (dd && !dd.panel.contains(e.target) && !dd.btn.contains(e.target)) closeDd();
});
document.addEventListener('keydown', function(e) {
  if (!dd) return;
  var opts = dd.panel.querySelectorAll('.opt');
  if (e.key === 'Escape') { var btn = dd.btn; closeDd(); btn.focus(); e.preventDefault(); }
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!opts.length) return;
    if (dd.active < 0) dd.active = Array.prototype.indexOf.call(opts, dd.panel.querySelector('.opt.on'));
    dd.active = Math.max(0, Math.min(opts.length - 1, dd.active + (e.key === 'ArrowDown' ? 1 : -1)));
    each(opts, function(o, k) { o.classList.toggle('active', k === dd.active); });
    opts[dd.active].scrollIntoView({ block: 'nearest' });
    e.preventDefault();
  } else if (e.key === 'Enter') {
    var pick = opts[dd.active >= 0 ? dd.active : 0];
    if (pick) { e.preventDefault(); pickDd(Number(pick.dataset.i)); }
  }
});

// Selects come and go with every redraw: each one is dressed as it appears.
function enhanceAll(root) { each(root.querySelectorAll('select:not([data-dd])'), enhanceSelect); }
new MutationObserver(function() {
  enhanceAll(document.body);
  if (dd && !document.body.contains(dd.btn)) closeDd();
}).observe(document.body, { childList: true, subtree: true });
enhanceAll(document.body);
// A click outside an open multi-select closes it.
document.addEventListener('click', function(e) {
  if (openMs && !e.target.closest('.ms')) { openMs = null; renderSide(); }
});
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape' && openMs) { openMs = null; renderSide(); }
  // Enter in the pinned value's search takes the first match.
  if (e.key === 'Enter' && openMs === PIN && e.target.dataset && e.target.dataset.act === 'ms-search') {
    var first = side.querySelector('[data-list="' + PIN + '"] [data-act="pin-pick"]');
    if (first) { e.preventDefault(); first.click(); }
  }
});

/** Whether the period range is the preset starting at `from` (0 = every period). */
function presetOn(from) {
  return from ? !!S.range && S.range[0] === from && S.range[1] === V.period.mods.length - 1 : !S.range;
}

function paintRange() {
  var fill = $('range-fill');
  if (!fill || !V.period) return;
  var n = V.period.mods.length, r = S.range || [0, n - 1];
  var d = Math.max(1, n - 1);
  fill.style.left = (r[0] / d * 100) + '%';
  fill.style.right = (100 - r[1] / d * 100) + '%';
  $('range-lo').textContent = V.period.names[r[0]];
  $('range-hi').textContent = V.period.names[r[1]];
  each(side.querySelectorAll('[data-act="range-preset"]'), function(b) { b.classList.toggle('on', presetOn(Number(b.dataset.v))); });
}

var debounceTimer;
function later(fn, ms) { clearTimeout(debounceTimer); debounceTimer = setTimeout(fn, ms); }
function refresh() { renderSide(); renderMain(); }

side.addEventListener('click', function(e) {
  var b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  var act = b.dataset.act, v = b.dataset.v;
  if (act === 'sel' && b.tagName === 'BUTTON') XP.toggleSel(v, Number(b.dataset.i));
  else if (act === 'ms-toggle') { openMs = openMs === v ? null : v; msFocus = openMs === v; renderSide(); return; }
  else if (act === 'pin-pick') { S.pinVal = b.dataset.i === '' ? null : Number(b.dataset.i); openMs = null; }
  else if (act === 'sel-all') delete S.sel[v];
  else if (act === 'sel-none') S.sel[v] = {};
  else if (act === 'reset') XP.reset();
  else if (act === 'range-preset') S.range = Number(v) ? [Number(v), V.period.mods.length - 1] : null;
  else if (e.target.closest('[data-act="metric"] button')) S.metric = e.target.closest('button').dataset.v;
  else if (e.target.closest('[data-act="pmode"] button')) S.periodMode = e.target.closest('button').dataset.v;
  else return;
  refresh();
});
side.addEventListener('change', function(e) {
  var el = e.target, act = el.dataset.act, v = el.dataset.v;
  if (act === 'crossing') XP.setCrossing(el.value);
  else if (act === 'sel') XP.toggleSel(v, Number(el.dataset.i));
  else if (act === 'ccat') S.ccat = el.value;
  else if (act === 'metric') S.metric = el.value;
  else if (act === 'pin') { S.pin = el.value; S.pinVal = null; msQuery[PIN] = ''; }
  else if (act === 'cal') {
    var mods = V.period.mods, r = S.range ? S.range.slice() : [0, mods.length - 1];
    var end = Number(el.dataset.end), date = el.value;
    if (date) {
      var idx = -1;
      for (var k = 0; k < mods.length; k++) {
        var bd = periodBounds(mods[k]);
        if (end === 0 ? bd[1] >= date : bd[0] <= date) { idx = k; if (end === 0) break; }
      }
      if (idx !== -1) r[end] = idx;
    } else r[end] = end === 0 ? 0 : mods.length - 1;
    if (r[0] > r[1]) r = end === 0 ? [r[0], r[0]] : [r[1], r[1]];
    S.range = r[0] === 0 && r[1] === mods.length - 1 ? null : r;
    // Redrawing the sidebar would replace the date field being typed in.
    later(renderMain, 250);
    return;
  } else return;
  refresh();
});
side.addEventListener('input', function(e) {
  var el = e.target, act = el.dataset.act;
  if (act === 'cq') { S.cq = el.value; later(renderMain, 200); }
  else if (act === 'ms-search') {
    msQuery[el.dataset.v] = el.value;
    var list = side.querySelector('[data-list="' + el.dataset.v + '"]');
    // Only the list is redrawn: the search box keeps its focus and caret.
    if (list) list.innerHTML = el.dataset.v === PIN ? pinOptionsHtml() : checksHtml(el.dataset.v);
  } else if (act === 'range') {
    var n = V.period.mods.length, r = S.range ? S.range.slice() : [0, n - 1];
    var end = Number(el.dataset.end), val = Number(el.value);
    r[end] = val;
    if (r[0] > r[1]) r[1 - end] = val;
    S.range = r[0] === 0 && r[1] === n - 1 ? null : r;
    each(side.querySelectorAll('input[data-act="range"]'), function(x) { x.value = r[Number(x.dataset.end)]; });
    paintRange();
    // A single period turns into context: the whole view changes shape.
    later(function() { if (S.range && S.range[0] === S.range[1]) refresh(); else renderMain(); }, 120);
  }
});

main.addEventListener('click', function(e) {
  var b = e.target.closest('[data-act] button, button[data-act]');
  if (!b) return;
  var act = b.closest('[data-act]').dataset.act;
  if (act === 'xp-tab') { S.tab = b.dataset.v; renderMain(); }
  else if (act === 'scale') { S.scale = b.dataset.v; renderMain(); }
  else if (act === 'topn') { S.topN = Number(b.dataset.v); renderMain(); }
  else if (act === 'csv-block') { var bl = current && current.blocks[Number(b.dataset.i)]; if (bl && bl.csv) downloadCsv(bl.csv.name, bl.csv.text()); }
});

function kpiHtml(s) {
  return '<div class="kpi"><div class="kpi-ico">' + (ICONS[ICON_OF[s.icon]] || ICONS.activity) + '</div><div class="kpi-t"><div class="v num">' + escHtml(s.value) + '</div><div class="l">' + escHtml(s.label) + (s.note ? '<span class="kpi-note" data-tip="' + escHtml(escHtml(s.note)) + '">' + ICONS.info + '</span>' : '') + '</div>'
    + (s.sub ? '<div class="s" title="' + escHtml(s.sub) + '">' + escHtml(s.sub) + '</div>' : '') + '</div></div>';
}

/** The engine's table spec, as the page's DataTable wants it. */
function tableOptions(t) {
  if (t.kind === 'concepts') {
    var anonText = function(v, r) { return v == null ? '' : (r._anon ? '< ' : '') + fmt(v); };
    var anonTitle = function(v, r) { return r._anon ? L.below_threshold : ''; };
    return Object.assign({}, t, {
      columns: t.columns.map(function(c) { return c.type === 'number' ? Object.assign({ format: anonText, title: anonTitle }, c) : c; }),
      rowClass: function(r) { return r._anon ? 'anon' : ''; },
      note: t.note,
    });
  }
  // Masked cells carry their number only in the app's revealing preview.
  var maskedFmt = function(v, r) { return r._st ? (v == null ? t.maskText[r._st] : XP.tr('mask_value', { v: fmt(v) })) : v == null ? '' : fmt(v); };
  var maskedTip = function(v, r) { return r._st ? t.maskTip[r._st] : ''; };
  return Object.assign({}, t, {
    columns: t.columns.map(function(c) { return c.measure ? Object.assign({ format: maskedFmt, title: maskedTip }, c) : c; }),
    rowClass: function(r) { return r._st ? 'anon' : ''; },
    note: ICONS.shield + escHtml(t.note),
  });
}

function renderMain() {
  var view = XP.view();
  current = view;
  var h = '<div class="xp-bar"><div class="xp-head"><h3>' + escHtml(view.title) + '</h3>'
    + (view.context.length ? '<div class="ctx">' + view.context.map(function(c) { return '<span class="pill" style="--vc:' + VARIABLE_HEX[c.v] + '">' + escHtml(c.label + ': ' + c.value) + '</span>'; }).join('') + '</div>' : '')
    + '</div><div class="seg" data-act="xp-tab">'
    + [['charts', L.charts], ['table', L.table]].map(function(o) { return '<button type="button" data-v="' + o[0] + '"' + (S.tab === o[0] ? ' class="active"' : '') + '>' + escHtml(o[1]) + '</button>'; }).join('')
    + '</div></div>';
  if (S.tab === 'table') {
    h += view.table ? '<div class="card dt" id="xp-table"></div>' : '<div class="card empty">' + escHtml(view.empty) + '</div>';
    main.innerHTML = h;
    if (view.table) createDataTable($('xp-table'), tableOptions(view.table));
    return;
  }
  if (view.stats.length) h += '<div class="kpis" style="--n:' + view.stats.length + '">' + view.stats.map(kpiHtml).join('') + '</div>';
  if (view.empty && !view.blocks.length) h += '<div class="card empty">' + escHtml(view.empty) + '</div>';
  if (view.blocks.length) {
    h += '<div class="charts">' + view.blocks.map(function(b, i) {
      return '<div class="card chart ' + b.size + '"><div class="chart-head"><h4>' + escHtml(b.title) + '</h4>' + (b.sub ? '<span class="sub">' + escHtml(b.sub) + '</span>' : '') + '<span class="spacer"></span>' + (b.head || '')
        + (b.csv ? '<span data-act="csv-block"><button type="button" class="btn sm" data-i="' + i + '" title="' + escHtml(L.download_csv) + '">' + ICONS.download + 'CSV</button></span>' : '') + '</div>'
        + '<div class="chart-body" data-block="' + i + '"></div>' + (b.note ? '<p class="caption">' + escHtml(b.note) + '</p>' : '') + '</div>';
    }).join('') + '</div>';
  }
  main.innerHTML = h;
  drawCharts();
}

function drawCharts() {
  if (!current) return;
  each(main.querySelectorAll('.chart-body[data-block]'), function(el) {
    var b = current.blocks[Number(el.dataset.block)];
    var w = Math.floor(el.clientWidth);
    if (!b || w <= 0) return;
    el.innerHTML = b.render(w);
  });
}
var resizeTimer;
window.addEventListener('resize', function() { clearTimeout(resizeTimer); resizeTimer = setTimeout(drawCharts, 150); });

// ---- DataTable ----
/*
 * createDataTable(container, opts) renders the page's DataTable into container: toolbar
 * (search, clear filters, CSV), resizable sortable header with inline filters, paged body,
 * footer. Returns { setRows(rows, pinnedRows) }, which keeps filters, sort and widths.
 *   columns: [{ key, label, type: 'text'|'number',
 *     filter?: 'text'|'select'|'min'|'none' (default none), align?: 'left'|'right' (number: right),
 *     width?: px (default 180, number 120), className?: td class,
 *     format?: (value, row) => shown text (number default: 1,234; null: empty),
 *     csv?: (value, row) => CSV cell (default: raw number when shown as such, else shown text),
 *     title?: (value, row) => tooltip, style?: (value, row) => inline td style }]
 *   rows: [{ key: value }]; pinnedRows?: rows kept on top, never sorted, filtered nor paged
 *   (first in the CSV too); rowClass?: row => tr class
 *   searchKeys?: keys the search box matches (default: text columns; [] hides the box)
 *   searchPlaceholder?, initialSort?: { key, desc } | null, pageSize? (50),
 *   noun?: [singular, plural], emptyText?, note?: trusted HTML shown in the toolbar,
 *   csvFileName?: the CSV holds the filtered rows in their sort order, all pages.
 */
function createDataTable(container, o) {
  var cols = o.columns, all = o.rows, pinned = o.pinnedRows || [];
  var searchKeys = o.searchKeys || cols.filter(function(c) { return c.type !== 'number'; }).map(function(c) { return c.key; });
  var noun = o.noun || [L.row, L.rows];
  var pageSize = o.pageSize || 50, page = 0;
  var sorting = o.initialSort || null;
  var filtered = all;
  var hasFilters = cols.some(function(c) { return c.filter && c.filter !== 'none'; });
  function isRight(c) { return c.align ? c.align === 'right' : c.type === 'number'; }
  function defaultWidth(c) { return c.width || (c.type === 'number' ? 120 : 180); }
  var widths = cols.map(defaultWidth);

  function filterCell(c, i) {
    var attrs = 'class="f" data-idx="' + i + '" aria-label="' + escHtml(lx('filter_col', { c: c.label })) + '"';
    if (c.filter === 'min') return '<input ' + attrs + ' type="number" min="0" placeholder="' + escHtml(L.min_ph) + '">';
    if (c.filter === 'text') return '<input ' + attrs + ' type="text" placeholder="' + escHtml(L.filter_ph) + '">';
    if (c.filter !== 'select') return '';
    var values = uniqueSorted(all.map(function(r) { return r[c.key]; }));
    return '<select ' + attrs + '><option value="">' + escHtml(L.all) + '</option>' + values.map(function(v) { return '<option value="' + escHtml(v) + '">' + escHtml(v) + '</option>'; }).join('') + '</select>';
  }

  var h = '<div class="dt-toolbar">';
  if (searchKeys.length) h += '<label class="search">' + ICONS.search + '<input type="search" class="input dt-search" placeholder="' + escHtml(o.searchPlaceholder || L.search) + '" autocomplete="off"></label>';
  h += '<button class="btn dt-clear" type="button" hidden>' + ICONS.x + escHtml(L.clear_filters) + '</button><span class="spacer"></span>';
  if (o.note) h += '<span class="dt-note">' + o.note + '</span>';
  h += '<button class="btn dt-csv" type="button" title="' + escHtml(L.csv_title) + '">' + ICONS.download + 'CSV</button></div>';
  // The last, width-less column takes the slack, so resizing one column never stretches the others.
  h += '<div class="dt-scroll"><table><colgroup>' + widths.map(function(w) { return '<col style="width:' + w + 'px">'; }).join('') + '<col></colgroup><thead><tr class="head">';
  cols.forEach(function(c, i) {
    h += '<th' + (isRight(c) ? ' class="r"' : '') + ' aria-sort="none"><button class="sort" type="button" data-idx="' + i + '"><span class="lbl">' + escHtml(c.label) + '</span><span class="sort-ico"></span></button>'
      + '<span class="rz" data-idx="' + i + '" title="' + escHtml(L.drag_resize) + '"></span></th>';
  });
  h += '<th class="fill"></th></tr>';
  if (hasFilters) {
    h += '<tr class="filters">';
    cols.forEach(function(c, i) { h += '<th' + (isRight(c) ? ' class="r"' : '') + '>' + filterCell(c, i) + '</th>'; });
    h += '<th class="fill"></th></tr>';
  }
  h += '</thead><tbody></tbody></table></div><div class="dt-foot"><span class="num dt-count"></span><span class="spacer"></span><span>' + escHtml(L.rows_per_page) + '</span><select class="select dt-size">'
    + [25, 50, 100, 250, 500].map(function(n) { return '<option value="' + n + '"' + (n === pageSize ? ' selected' : '') + '>' + n + '</option>'; }).join('') + '</select>'
    + '<button class="btn icon-only dt-prev" type="button" aria-label="' + escHtml(L.prev_page) + '">' + ICONS.left + '</button><span class="page-info num dt-page"></span>'
    + '<button class="btn icon-only dt-next" type="button" aria-label="' + escHtml(L.next_page) + '">' + ICONS.right + '</button></div>';
  container.innerHTML = h;

  function q(sel) { return container.querySelector(sel); }
  var tbody = q('tbody'), search = q('.dt-search'), clearBtn = q('.dt-clear');
  var filterEls = container.querySelectorAll('.f'), sortBtns = container.querySelectorAll('.sort');
  var colEls = container.querySelectorAll('col');

  function compare(a, b, num) {
    if (num) {
      var x = a == null || a === '' ? -Infinity : Number(a), y = b == null || b === '' ? -Infinity : Number(b);
      return x === y ? 0 : x < y ? -1 : 1;
    }
    a = String(a == null ? '' : a).toLowerCase(); b = String(b == null ? '' : b).toLowerCase();
    return a < b ? -1 : a > b ? 1 : 0;
  }

  function apply() {
    var needle = search ? search.value.trim().toLowerCase() : '';
    var active = [];
    each(filterEls, function(el) {
      var v = el.value.trim();
      if (v === '') return;
      var c = cols[Number(el.dataset.idx)];
      active.push({ key: c.key, kind: c.filter, v: c.filter === 'min' ? Number(v) : v.toLowerCase() });
    });
    clearBtn.hidden = !needle && !active.length;
    filtered = all.filter(function(r) {
      if (needle && !fuzzy(needle, searchKeys.map(function(k) { return r[k] == null ? '' : String(r[k]); }).join(' ').toLowerCase())) return false;
      for (var i = 0; i < active.length; i++) {
        var f = active[i], cell = r[f.key];
        if (f.kind === 'min') { if (cell == null || !(Number(cell) >= f.v)) return false; }
        else if (f.kind === 'select') { if (String(cell).toLowerCase() !== f.v) return false; }
        else if (String(cell == null ? '' : cell).toLowerCase().indexOf(f.v) === -1) return false;
      }
      return true;
    });
    var sc = sorting && cols.filter(function(c) { return c.key === sorting.key; })[0];
    if (sc) {
      var dir = sorting.desc ? -1 : 1, num = sc.type === 'number';
      filtered = filtered.slice().sort(function(a, b) { return compare(a[sc.key], b[sc.key], num) * dir; });
    }
    page = 0;
    render();
  }

  function paintSort() {
    each(sortBtns, function(b) {
      var on = !!sorting && sorting.key === cols[Number(b.dataset.idx)].key;
      b.classList.toggle('on', on);
      b.querySelector('.sort-ico').innerHTML = on ? (sorting.desc ? ICONS.down : ICONS.up) : ICONS.both;
      b.closest('th').setAttribute('aria-sort', on ? (sorting.desc ? 'descending' : 'ascending') : 'none');
    });
  }

  function rowHtml(r, extraClass) {
    var rc = [extraClass, o.rowClass ? o.rowClass(r) : ''].filter(Boolean).join(' ');
    var s = rc ? '<tr class="' + rc + '">' : '<tr>';
    cols.forEach(function(c) {
      var v = r[c.key];
      var cls = [isRight(c) ? 'r' : '', c.className || ''].filter(Boolean).join(' ');
      var tp = c.title ? c.title(v, r) : '', st = c.style ? c.style(v, r) : '';
      s += '<td' + (cls ? ' class="' + cls + '"' : '') + (tp ? ' title="' + escHtml(tp) + '"' : '') + (st ? ' style="' + escHtml(st) + '"' : '') + '>' + escHtml(cellText(c, r)) + '</td>';
    });
    return s + '<td class="fill"></td></tr>';
  }

  function render() {
    var pages = Math.max(1, Math.ceil(filtered.length / pageSize));
    if (page >= pages) page = pages - 1;
    var html = pinned.map(function(r) { return rowHtml(r, 'pinned'); }).join('');
    var slice = filtered.slice(page * pageSize, page * pageSize + pageSize);
    html += slice.map(function(r) { return rowHtml(r, ''); }).join('');
    if (!slice.length) html += '<tr class="no-rows"><td colspan="' + (cols.length + 1) + '">' + escHtml(o.emptyText || L.no_rows) + '</td></tr>';
    tbody.innerHTML = html;
    var total = all.length, word = function(n) { return n === 1 ? noun[0] : noun[1]; };
    q('.dt-count').textContent = filtered.length === total ? fmt(total) + ' ' + word(total) : lx('n_of_total', { n: fmt(filtered.length), total: fmt(total) }) + ' ' + word(total);
    q('.dt-page').textContent = (page + 1) + ' / ' + pages;
    q('.dt-prev').disabled = page === 0;
    q('.dt-next').disabled = page >= pages - 1;
  }

  function setWidth(i, w) {
    widths[i] = Math.max(50, Math.round(w));
    colEls[i].style.width = widths[i] + 'px';
  }
  each(container.querySelectorAll('.rz'), function(grip) {
    var i = Number(grip.dataset.idx);
    grip.addEventListener('pointerdown', function(e) {
      if (e.button !== 0) return;
      e.preventDefault();
      var startX = e.clientX, startW = colEls[i].getBoundingClientRect().width || widths[i];
      try { grip.setPointerCapture(e.pointerId); } catch (err) { /* synthetic event: no live pointer */ }
      grip.classList.add('on');
      document.body.classList.add('col-resizing');
      var move = function(ev) { setWidth(i, startW + ev.clientX - startX); };
      var end = function() {
        grip.classList.remove('on');
        document.body.classList.remove('col-resizing');
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', end);
        grip.removeEventListener('pointercancel', end);
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', end);
      grip.addEventListener('pointercancel', end);
    });
    grip.addEventListener('dblclick', function() { setWidth(i, defaultWidth(cols[i])); });
  });

  var timer;
  function debounced() { clearTimeout(timer); timer = setTimeout(apply, 150); }
  if (search) search.addEventListener('input', debounced);
  each(filterEls, function(el) { el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', debounced); });
  clearBtn.addEventListener('click', function() {
    if (search) search.value = '';
    each(filterEls, function(el) { el.value = ''; });
    syncDropdowns(container);
    apply();
  });
  each(sortBtns, function(b) {
    b.addEventListener('click', function() {
      var key = cols[Number(b.dataset.idx)].key;
      // Same cycle as the app's tables: a fresh column sorts descending, then ascending, then clears.
      if (!sorting || sorting.key !== key) sorting = { key: key, desc: true };
      else sorting = sorting.desc ? { key: key, desc: false } : null;
      paintSort();
      apply();
    });
  });
  q('.dt-csv').addEventListener('click', function() {
    downloadCsv(o.csvFileName || 'table.csv', tableCsv(cols, pinned.concat(filtered)));
  });
  q('.dt-prev').addEventListener('click', function() { if (page > 0) { page--; render(); } });
  q('.dt-next').addEventListener('click', function() { page++; render(); });
  q('.dt-size').addEventListener('change', function() { pageSize = Number(this.value) || 50; page = 0; render(); });

  paintSort();
  apply();
  return {
    setRows: function(rows, pinnedRows) {
      all = rows;
      if (pinnedRows) pinned = pinnedRows;
      apply();
    },
  };
}

// ---- Start ----
if (side && main && S.crossing) refresh();
else if (main) main.innerHTML = '<div class="card empty">' + escHtml(L.nothing_computed) + '</div>';
