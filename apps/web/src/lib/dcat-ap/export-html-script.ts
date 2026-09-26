/**
 * Behaviour of the standalone catalog page, as a classic inline script (no
 * modules, no template literals: it lives inside one). It reads the
 * globals the page declares before it: CONCEPTS, CONCEPT_COLS, PERIODS, META,
 * ICONS.
 *
 * The Overview charts are rendered at export time with the cohort report's builders
 * (`lib/cohort-report/charts.ts`); the ports below redraw them only when one
 * period is picked, so they must keep the same geometry and colours.
 */
export const CATALOG_SCRIPT = `
(function() {
  var NNBSP = String.fromCharCode(8239);
  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmt(n) { return Number(n).toLocaleString('en'); }
  function $(id) { return document.getElementById(id); }
  function each(list, fn) { Array.prototype.forEach.call(list, fn); }

  // ---- Tabs ----
  var tabs = document.querySelectorAll('.tab');
  each(tabs, function(t) {
    t.addEventListener('click', function() {
      each(tabs, function(x) { x.classList.toggle('active', x === t); x.setAttribute('aria-selected', x === t ? 'true' : 'false'); });
      each(document.querySelectorAll('.tab-content'), function(c) { c.classList.toggle('active', c.id === 'tab-' + t.dataset.tab); });
    });
  });

  // ---- JSON-LD viewer ----
  var overlay = $('jsonld-overlay');
  function closeOverlay() { overlay.classList.remove('open'); }
  $('open-jsonld').addEventListener('click', function() { overlay.classList.add('open'); });
  $('close-jsonld').addEventListener('click', closeOverlay);
  overlay.addEventListener('click', function(e) { if (e.target === overlay) closeOverlay(); });
  document.addEventListener('keydown', function(e) { if (e.key === 'Escape') closeOverlay(); });
  var copyBtn = $('copy-jsonld');
  copyBtn.addEventListener('click', function() {
    var code = $('jsonld-code');
    var done = function() {
      var label = copyBtn.querySelector('span');
      label.textContent = 'Copied';
      setTimeout(function() { label.textContent = 'Copy'; }, 1500);
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

  // ---- Schema: table filter, TOC and diagram navigation ----
  function goToTable(id) {
    var card = $(id);
    if (!card) return;
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

  // ---- Chart builders (ports of lib/cohort-report/charts.ts) ----
  var AXIS = '#cdd7e3', TEXT = '#33445c', MUTED = '#667892';
  var FONT = 'font-family="system-ui,-apple-system,Segoe UI,Helvetica,Arial,sans-serif"';
  var DONUT_COLORS = ['#1f5e97', '#3b8fb5', '#7fb3d5', '#a9c6de', '#9aa8b8', '#c9d3de'];
  function svg(w, h, body, title) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '" role="img" aria-label="' + escHtml(title) + '" ' + FONT + '>' + body + '</svg>';
  }
  function niceScale(max, ticks) {
    if (max <= 0) return { max: 1, step: 1 };
    var raw = Math.max(1, max / ticks);
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var step = 10 * mag;
    var f = [1, 2, 5, 10];
    for (var i = 0; i < f.length; i++) if (f[i] * mag >= raw) { step = f[i] * mag; break; }
    return { max: Math.ceil(max / step) * step, step: step };
  }
  function maxOf(items) { var m = 0; items.forEach(function(i) { if (i.value != null && i.value > m) m = i.value; }); return m; }

  function columnChart(items, title, unit) {
    var width = 520, height = 270, pad = { top: 16, right: 10, bottom: 40, left: 52 };
    var plotW = width - pad.left - pad.right, plotH = height - pad.top - pad.bottom;
    var sc = niceScale(maxOf(items), 6);
    var yOf = function(v) { return pad.top + plotH - (v / sc.max) * plotH; };
    var p = [];
    for (var v = 0; v <= sc.max; v += sc.step) {
      var y = yOf(v).toFixed(1);
      p.push('<line x1="' + pad.left + '" y1="' + y + '" x2="' + (width - pad.right) + '" y2="' + y + '" stroke="#eef2f7" />');
      p.push('<text x="' + (pad.left - 7) + '" y="' + (Number(y) + 5.5).toFixed(1) + '" text-anchor="end" font-size="16" fill="' + MUTED + '">' + fmt(v).replace(/,/g, NNBSP) + '</text>');
    }
    var slot = items.length ? plotW / items.length : plotW;
    var barW = slot * 0.58;
    var every = Math.max(1, Math.ceil(items.length / 8));
    items.forEach(function(it, i) {
      var cx = pad.left + i * slot + slot / 2;
      if (it.value != null && it.value > 0) {
        var y = yOf(it.value);
        p.push('<rect x="' + (cx - barW / 2).toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + (pad.top + plotH - y).toFixed(1) + '" fill="#1f5e97"><title>' + escHtml(it.label + ' : ' + it.text + ' ' + unit) + '</title></rect>');
      }
      if (i % every === 0) p.push('<text x="' + cx.toFixed(1) + '" y="' + (height - 12) + '" text-anchor="middle" font-size="16" fill="#47576f">' + escHtml(it.label) + '</text>');
    });
    p.push('<line x1="' + pad.left + '" y1="' + (pad.top + plotH) + '" x2="' + (width - pad.right) + '" y2="' + (pad.top + plotH) + '" stroke="' + AXIS + '" />');
    return svg(width, height, p.join(''), title);
  }

  function share(v, total) { return (v / total * 100).toFixed(1) + '%'; }
  function donut(items, title, centerValue, centerLabel) {
    var width = 520, height = 270, cx = 138, cy = 135, r = 100, inner = 68;
    var total = 0;
    items.forEach(function(i) { total += i.value || 0; });
    var p = [];
    var angle = -Math.PI / 2;
    var pt = function(a, rad) { return (cx + rad * Math.cos(a)).toFixed(2) + ' ' + (cy + rad * Math.sin(a)).toFixed(2); };
    items.forEach(function(it, i) {
      var v = it.value || 0;
      if (!total || v <= 0) return;
      var color = DONUT_COLORS[i % DONUT_COLORS.length];
      var tip = '<title>' + escHtml(it.label + ' : ' + it.text + ' (' + share(v, total) + ')') + '</title>';
      if (v === total) {
        p.push('<circle cx="' + cx + '" cy="' + cy + '" r="' + ((r + inner) / 2) + '" fill="none" stroke="' + color + '" stroke-width="' + (r - inner) + '">' + tip + '</circle>');
        return;
      }
      var sweep = (v / total) * Math.PI * 2, end = angle + sweep, large = sweep > Math.PI ? 1 : 0;
      p.push('<path d="M ' + pt(angle, r) + ' A ' + r + ' ' + r + ' 0 ' + large + ' 1 ' + pt(end, r) + ' L ' + pt(end, inner) + ' A ' + inner + ' ' + inner + ' 0 ' + large + ' 0 ' + pt(angle, inner) + ' Z" fill="' + color + '">' + tip + '</path>');
      angle = end;
    });
    if (centerValue) {
      p.push('<text x="' + cx + '" y="' + (cy + 4) + '" text-anchor="middle" font-size="34" font-weight="600" fill="#1a4c7c">' + escHtml(centerValue) + '</text>');
      p.push('<text x="' + cx + '" y="' + (cy + 25) + '" text-anchor="middle" font-size="15" fill="#77869a">' + escHtml(centerLabel) + '</text>');
    }
    var top = cy - (items.length * 30) / 2 + 2;
    items.forEach(function(it, i) {
      var y = top + i * 30;
      var s = it.value != null && total ? share(it.value, total) : it.text;
      p.push('<rect x="252" y="' + y + '" width="16" height="16" rx="2" fill="' + DONUT_COLORS[i % DONUT_COLORS.length] + '" />');
      p.push('<text x="278" y="' + (y + 13) + '" font-size="17" fill="' + TEXT + '">' + escHtml(it.label + ' — ' + s) + '</text>');
    });
    return svg(width, height, p.join(''), title);
  }

  function horizontalBars(items, title, width) {
    var rowH = 22, valueW = 56;
    var labelW = 80;
    items.forEach(function(i) { labelW = Math.max(labelW, i.label.length * 6.2); });
    labelW = Math.min(220, labelW);
    var height = Math.max(rowH, items.length * rowH) + 8;
    var plotW = width - labelW - valueW - 16;
    var max = Math.max(1, maxOf(items));
    var p = items.map(function(it, i) {
      var y = 4 + i * rowH;
      var label = it.label.length > 36 ? it.label.slice(0, 35) + '…' : it.label;
      var w = it.value ? (it.value / max) * plotW : 0;
      return '<text x="' + (labelW - 6) + '" y="' + (y + 14) + '" font-size="10" text-anchor="end" fill="' + TEXT + '">' + escHtml(label) + '</text>'
        + (w > 0 ? '<rect x="' + labelW + '" y="' + (y + 4) + '" width="' + w.toFixed(1) + '" height="' + (rowH - 8) + '" rx="1.5" fill="#0084d8" />' : '')
        + '<text x="' + (labelW + w + 6).toFixed(1) + '" y="' + (y + 14) + '" font-size="10" fill="' + TEXT + '">' + escHtml(it.text) + '</text>';
    });
    return svg(width, height, p.join(''), title);
  }

  // ---- Overview: period filter ----
  var masked = '<' + META.threshold;
  function count(v) { return { value: v, text: v == null ? masked : fmt(v) }; }
  function leadingNumber(s) { var m = /\\d+/.exec(s); return m ? Number(m[0]) : Infinity; }

  var chartCards = document.querySelectorAll('.chart[data-dim]');
  var initialCharts = [];
  each(chartCards, function(c) { initialCharts.push(c.querySelector('.chart-body').innerHTML); });
  var kpiEls = document.querySelectorAll('.kpi[data-kpi]');

  function renderPeriod(row) {
    each(kpiEls, function(k) {
      var key = k.dataset.kpi, v = k.querySelector('.v'), s = k.querySelector('.s');
      if (key === 'patients') v.textContent = row ? count(row.n_patients).text : fmt(META.totalPatients);
      else if (key === 'visits') v.textContent = row ? count(row.n_sejours).text : fmt(META.totalVisits);
      else if (s) s.style.display = row ? '' : 'none';
    });
    each(chartCards, function(card, i) {
      var type = card.dataset.dim, body = card.querySelector('.chart-body'), title = card.dataset.title;
      card.style.display = '';
      if (!row) { body.innerHTML = initialCharts[i]; return; }
      if (type === 'admission_date') { card.style.display = 'none'; return; }
      var items = [];
      if (type === 'sex') {
        [['M', row.sex_m], ['F', row.sex_f], ['Other', row.sex_other]].forEach(function(e) {
          if (e[1] !== null && e[1] !== undefined) { var c = count(e[1]); items.push({ label: e[0], value: c.value, text: c.text }); }
        });
        items.sort(function(a, b) { return (b.value || 0) - (a.value || 0); });
        body.innerHTML = items.length ? donut(items, title, count(row.n_patients).text, 'patients') : '<div class="empty">No data for this period</div>';
      } else if (type === 'age_group') {
        for (var k in row.age_buckets) { var a = count(row.age_buckets[k]); items.push({ label: k, value: a.value, text: a.text }); }
        items.sort(function(x, y) { return leadingNumber(x.label) - leadingNumber(y.label) || (x.label < y.label ? -1 : 1); });
        body.innerHTML = items.length ? columnChart(items, title, 'patients') : '<div class="empty">No data for this period</div>';
      } else if (type === 'care_site') {
        for (var s in row.services) { var sv = row.services[s]; if (sv) { var c2 = count(sv.n_patients); items.push({ label: s, value: c2.value, text: c2.text }); } }
        items.sort(function(x, y) { return (y.value || 0) - (x.value || 0); });
        body.innerHTML = items.length ? horizontalBars(items.slice(0, 30), title, 1100) : '<div class="empty">No data for this period</div>';
      }
    });
  }

  // ---- Overview: heatmaps (one hue, per-row scale) ----
  var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  var LO = dark ? [27, 40, 58] : [238, 245, 251], HI = dark ? [61, 143, 209] : [31, 94, 151];
  function heat(t) {
    var c = [0, 1, 2].map(function(i) { return Math.round(LO[i] + t * (HI[i] - LO[i])); });
    return 'rgb(' + c.join(',') + ')';
  }
  var hmScale = 'linear-gradient(90deg,' + heat(0) + ',' + heat(1) + ')';

  function heatmap(title, labels, rows, pick) {
    var h = '<div class="card hm"><h3 class="eyebrow">' + escHtml(title) + '</h3><div class="hm-scroll"><table><thead><tr><th></th>';
    rows.forEach(function(r) { h += '<th>' + escHtml(r.period_label) + '</th>'; });
    h += '</tr></thead><tbody>';
    labels.forEach(function(lab) {
      var max = 0;
      rows.forEach(function(r) { var v = pick(r, lab); if (v != null && v > max) max = v; });
      h += '<tr><th class="row" title="' + escHtml(lab) + '">' + escHtml(lab) + '</th>';
      rows.forEach(function(r) {
        var v = pick(r, lab);
        if (v == null) { h += '<td class="masked" title="' + escHtml(r.period_label + ' · ' + masked) + '">' + escHtml(masked) + '</td>'; return; }
        var t = max ? v / max : 0;
        h += '<td class="num" style="background:' + heat(t) + ';color:' + (t > 0.55 ? '#fff' : 'inherit') + '" title="' + escHtml(lab + ' · ' + r.period_label + ': ' + fmt(v)) + '">' + fmt(v) + '</td>';
      });
      h += '</tr>';
    });
    return h + '</tbody></table></div><div class="hm-scale"><span>0</span><span class="bar" style="background:' + hmScale + '"></span><span>row max</span><span class="mask"></span><span>below ' + META.threshold + ' patients</span></div></div>';
  }

  var GRANS = ['month', 'quarter', 'year'];
  var availGrans = GRANS.filter(function(g) { return PERIODS.some(function(r) { return r.period_granularity === g; }); });
  function periodRows(gran) {
    var g = gran === 'all' ? availGrans[0] : gran;
    return PERIODS.filter(function(r) { return r.period_granularity === g; });
  }
  function renderHeatmaps(gran, periodValue) {
    var section = $('heatmaps');
    if (!section) return;
    var rows = periodRows(gran);
    if (periodValue) rows = rows.filter(function(r) { return r.period_label === periodValue; });
    var allRow = PERIODS.find(function(r) { return r.period_granularity === 'all'; });
    if (!allRow || rows.length < 2) { section.innerHTML = ''; return; }
    var html = '';
    var svc = Object.keys(allRow.services || {});
    if (svc.length) html += heatmap('Patients by service over time', svc, rows, function(r, l) { return r.services[l] ? r.services[l].n_patients : null; });
    var cats = Object.keys(allRow.concept_categories || {});
    if (cats.length) html += heatmap('Patients by concept category over time', cats, rows, function(r, l) { return r.concept_categories[l] ? r.concept_categories[l].n_patients : null; });
    section.innerHTML = html;
  }

  if (PERIODS.length) {
    var gran = 'all', periodSel = $('period-filter');
    each(document.querySelectorAll('#granularity button'), function(b) {
      if (b.dataset.gran !== 'all' && availGrans.indexOf(b.dataset.gran) === -1) b.disabled = true;
    });
    var fillPeriods = function() {
      periodSel.innerHTML = '<option value="">All periods</option>' + periodRows(gran).map(function(r) {
        return '<option value="' + escHtml(r.period_label) + '">' + escHtml(r.period_label) + '</option>';
      }).join('');
    };
    var update = function() {
      var v = periodSel.value;
      renderPeriod(v ? PERIODS.find(function(r) { return r.period_label === v; }) || null : null);
      renderHeatmaps(gran, v);
    };
    $('granularity').addEventListener('click', function(e) {
      var btn = e.target.closest('button');
      if (!btn || btn.disabled) return;
      gran = btn.dataset.gran;
      each(document.querySelectorAll('#granularity button'), function(b) { b.classList.toggle('active', b === btn); });
      fillPeriods();
      update();
    });
    periodSel.addEventListener('change', update);
    fillPeriods();
    renderHeatmaps(gran, '');
  }

  // ---- Concepts table ----
  var cols = CONCEPT_COLS;
  var anonIdx = cols.length;
  var rows = CONCEPTS;
  var filtered = rows;
  var sorting = { idx: cols.findIndex(function(c) { return c.key === 'patientCount'; }), desc: true };
  var page = 0, pageSize = 50;
  var tbody = $('concept-tbody');
  var search = $('concept-search');
  var clearBtn = $('concept-clear');
  var filterEls = document.querySelectorAll('#concept-table .f');
  var sortBtns = document.querySelectorAll('#concept-table .sort');

  function fuzzy(needle, hay) {
    if (hay.indexOf(needle) !== -1) return true;
    var n = 0;
    for (var h = 0; h < hay.length && n < needle.length; h++) if (hay[h] === needle[n]) n++;
    return n === needle.length;
  }

  function apply() {
    var q = search.value.trim().toLowerCase();
    var active = [];
    each(filterEls, function(el) {
      var v = el.value.trim();
      if (v !== '') active.push({ idx: Number(el.dataset.idx), kind: el.dataset.kind, v: el.dataset.kind === 'num' ? Number(v) : v.toLowerCase() });
    });
    clearBtn.hidden = !q && !active.length;
    filtered = rows.filter(function(r) {
      if (q && !fuzzy(q, (String(r[0]) + ' ' + String(r[1])).toLowerCase())) return false;
      for (var i = 0; i < active.length; i++) {
        var f = active[i], cell = r[f.idx];
        if (f.kind === 'num') { if (!(Number(cell) >= f.v)) return false; }
        else if (f.kind === 'select') { if (String(cell).toLowerCase() !== f.v) return false; }
        else if (String(cell).toLowerCase().indexOf(f.v) === -1) return false;
      }
      return true;
    });
    if (sorting) {
      var idx = sorting.idx, num = cols[idx].kind === 'num', dir = sorting.desc ? -1 : 1;
      filtered = filtered.slice().sort(function(a, b) {
        var x = a[idx], y = b[idx];
        if (num) return (Number(x) - Number(y)) * dir;
        x = String(x == null ? '' : x).toLowerCase(); y = String(y == null ? '' : y).toLowerCase();
        return (x < y ? -1 : x > y ? 1 : 0) * dir;
      });
    }
    page = 0;
    render();
  }

  function paintSort() {
    each(sortBtns, function(b) {
      var on = sorting && sorting.idx === Number(b.dataset.idx);
      b.classList.toggle('on', !!on);
      b.querySelector('.sort-ico').innerHTML = on ? (sorting.desc ? ICONS.down : ICONS.up) : ICONS.both;
      b.closest('th').setAttribute('aria-sort', on ? (sorting.desc ? 'descending' : 'ascending') : 'none');
    });
  }

  function render() {
    var pages = Math.max(1, Math.ceil(filtered.length / pageSize));
    if (page >= pages) page = pages - 1;
    var slice = filtered.slice(page * pageSize, page * pageSize + pageSize);
    var html = '';
    slice.forEach(function(r) {
      var anon = r[anonIdx] === true;
      html += anon ? '<tr class="anon">' : '<tr>';
      cols.forEach(function(c, i) {
        var v = r[i];
        if (c.kind === 'num') {
          html += '<td class="r' + (c.key === 'patientCount' ? ' p' : '') + '"' + (anon ? ' title="Below the anonymisation threshold"' : '') + '>' + (anon ? '&lt; ' : '') + fmt(v) + '</td>';
        } else {
          html += '<td class="' + (c.kind === 'id' ? 'id' : c.key === 'conceptName' ? 'name' : '') + '">' + escHtml(v == null ? '' : v) + '</td>';
        }
      });
      html += '</tr>';
    });
    tbody.innerHTML = html || '<tr class="no-rows"><td colspan="' + cols.length + '">No concept matches these filters.</td></tr>';
    $('concept-count').textContent = filtered.length === rows.length
      ? fmt(rows.length) + ' concepts'
      : fmt(filtered.length) + ' of ' + fmt(rows.length) + ' concepts';
    $('concept-page-info').textContent = (page + 1) + ' / ' + pages;
    $('concept-prev').disabled = page === 0;
    $('concept-next').disabled = page >= pages - 1;
  }

  var timer;
  function debounced() { clearTimeout(timer); timer = setTimeout(apply, 150); }
  search.addEventListener('input', debounced);
  each(filterEls, function(el) { el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', debounced); });
  clearBtn.addEventListener('click', function() {
    search.value = '';
    each(filterEls, function(el) { el.value = ''; });
    apply();
  });
  each(sortBtns, function(b) {
    b.addEventListener('click', function() {
      var idx = Number(b.dataset.idx);
      // Same cycle as the app's tables: a fresh column sorts descending, then ascending, then clears.
      if (!sorting || sorting.idx !== idx) sorting = { idx: idx, desc: true };
      else sorting = sorting.desc ? { idx: idx, desc: false } : null;
      paintSort();
      apply();
    });
  });
  $('concept-prev').addEventListener('click', function() { if (page > 0) { page--; render(); } });
  $('concept-next').addEventListener('click', function() { page++; render(); });
  $('concept-page-size').addEventListener('change', function() { pageSize = Number(this.value) || 50; page = 0; render(); });

  paintSort();
  render();
})();
`
