/**
 * Stylesheet and icons of the standalone catalog page. Same palette and type as
 * the cohort report (`lib/cohort-report/render-html.ts`), laid out as a screen
 * document rather than an A4 page. Icons are inlined lucide paths: the file must
 * open offline, so nothing is fetched.
 */

const ICON_PATHS = {
  code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  download: '<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  arrowUp: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  arrowDown: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  arrowUpDown: '<path d="m21 16-4 4-4-4"/><path d="M17 20V4"/><path d="m3 8 4-4 4 4"/><path d="M7 4v16"/>',
  folderOpen: '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>',
  package: '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  building: '<path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/><path d="M10 18h4"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  stethoscope: '<path d="M11 2v2"/><path d="M5 2v2"/><path d="M5 3H4a2 2 0 0 0-2 2v4a6 6 0 0 0 12 0V5a2 2 0 0 0-2-2h-1"/><path d="M8 15a6 6 0 0 0 12 0v-3"/><circle cx="20" cy="10" r="2"/>',
  bookOpen: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  table: '<path d="M12 3v18"/><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/>',
  barChart: '<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
  tags: '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  fileText: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
} as const

export type IconName = keyof typeof ICON_PATHS

export function icon(name: IconName, size = 14): string {
  return `<svg class="ico" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name]}</svg>`
}

/** An icon as a nested `<svg>`, positioned inside another SVG (the ERD). */
export function svgIcon(name: IconName, x: number, y: number, size: number, cls: string): string {
  return `<svg class="${cls}" x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name]}</svg>`
}

const TABLE_TYPES = ['patient', 'visit', 'concept', 'event'] as const

// Tailwind 50/100/400/600 of blue, teal, amber and rose: the Schemas page ERD.
const ERD_LIGHT: Record<(typeof TABLE_TYPES)[number], [string, string, string, string]> = {
  patient: ['#eff6ff', '#dbeafe', '#93c5fd', '#2563eb'],
  visit: ['#f0fdfa', '#ccfbf1', '#5eead4', '#0d9488'],
  concept: ['#fffbeb', '#fef3c7', '#fcd34d', '#d97706'],
  event: ['#fff1f2', '#ffe4e6', '#fda4af', '#e11d48'],
}
const ERD_DARK: typeof ERD_LIGHT = {
  patient: ['#131f33', '#1a2c4a', '#2f5795', '#7fb0f5'],
  visit: ['#10231f', '#16332d', '#1f6f63', '#5fd3c2'],
  concept: ['#241d10', '#342913', '#8a6420', '#f0bf5a'],
  event: ['#261419', '#381b22', '#8d3a4c', '#f38aa0'],
}

function erdVars(palette: typeof ERD_LIGHT): string {
  return TABLE_TYPES.map((t) => {
    const [bg, head, border, ico] = palette[t]
    return `--${t}-bg:${bg};--${t}-head:${head};--${t}-border:${border};--${t}-ico:${ico};`
  }).join('')
}

const LIGHT = `--bg:#f3f6fa;--card:#fff;--ink:#0f1b2d;--text:#33445c;--muted:#667892;--line:#cdd7e3;--line-soft:#e3e9f0;--soft:#eef2f7;--row-hover:#f5f8fc;--blue:#004578;--blue2:#0084d8;--cyan:#00a7d8;--accent-soft:#e7f2fb;--h2-line:#d8e7f3;--warn:#a86b12;--warn-soft:#fdf7ea;--shadow:0 1px 2px rgba(15,27,45,.04),0 4px 14px rgba(15,27,45,.05);--pk-bg:#fef3c7;--pk-fg:#92400e;--fk-bg:#dbeafe;--fk-fg:#1e40af;--value-bg:#d1fae5;--value-fg:#065f46;--date-bg:#ede9fe;--date-fg:#5b21b6;--edge:#94a3b8;--hatch:#dfe5ec;${erdVars(ERD_LIGHT)}`
const DARK = `--bg:#0d141e;--card:#141e2b;--ink:#e5ecf4;--text:#c2cedb;--muted:#8494a8;--line:#2a394c;--line-soft:#1f2c3c;--soft:#1a2636;--row-hover:#18263a;--blue:#8cc5ee;--blue2:#3d9ee0;--cyan:#56c2e3;--accent-soft:#18304a;--h2-line:#213a54;--warn:#d4a55a;--warn-soft:#231d12;--shadow:0 1px 2px rgba(0,0,0,.3);--pk-bg:#3b2f12;--pk-fg:#f3cf76;--fk-bg:#172a4a;--fk-fg:#9cc2fb;--value-bg:#10302a;--value-fg:#7fdcbc;--date-bg:#261f45;--date-fg:#c3b5fb;--edge:#5b6b80;--hatch:#26344a;${erdVars(ERD_DARK)}`

const MONO = "ui-monospace,'SFMono-Regular',Menlo,Consolas,monospace"

export const CATALOG_CSS = `
:root{${LIGHT}color-scheme:light}
@media (prefers-color-scheme:dark){:root{${DARK}color-scheme:dark}}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--text);font:14px/1.55 system-ui,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
button,input,select{font:inherit;color:inherit}
[hidden]{display:none!important}
a{color:var(--blue2);text-decoration:none}
a:hover{text-decoration:underline}
code,.mono{font-family:${MONO}}
.num{font-variant-numeric:tabular-nums}
.ico{flex-shrink:0;display:inline-block;vertical-align:middle}
/* One continuous white sheet — header, tabs and every tab's content — on the grey page.
   Blocks inside it are framed by a border only: a shadow per block would stack cards on a card. */
.sheet{max-width:1320px;margin:28px auto 40px;background:var(--card);border:1px solid var(--line-soft);border-radius:14px;box-shadow:var(--shadow)}
.card{background:var(--card);border:1px solid var(--line-soft);border-radius:10px}

.masthead{padding:24px 28px 0;border-bottom:1px solid var(--line-soft)}
.brand{display:flex;align-items:center;gap:12px;padding-bottom:14px;border-bottom:2px solid var(--blue)}
.brand svg{flex-shrink:0}
.eyebrow{font-weight:600;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--cyan)}
.meta-line{font-size:12px;color:var(--muted);margin-top:2px}
.masthead h1{font-size:24px;line-height:1.25;color:var(--ink);letter-spacing:-.01em;margin:18px 0 6px}
.masthead .desc{font-size:14px;max-width:80ch;color:var(--text)}
.tabs{display:flex;gap:4px;margin-top:14px;margin-bottom:-1px;overflow-x:auto}
.tab{display:inline-flex;align-items:center;gap:7px;padding:10px 14px 11px;font-size:13px;font-weight:500;color:var(--muted);background:none;border:0;border-bottom:2px solid transparent;cursor:pointer;white-space:nowrap;transition:color .15s,border-color .15s}
.tab:hover{color:var(--ink)}
.tab.active{color:var(--blue);border-bottom-color:var(--blue2)}
.tab .count{font-size:10px;font-weight:600;padding:1px 6px;border-radius:999px;background:var(--soft);color:var(--muted)}
.tab.active .count{background:var(--accent-soft);color:var(--blue)}
.tab-content{display:none;padding:24px 28px 8px}
.tab-content.active{display:block}

.section-head{display:flex;flex-wrap:wrap;align-items:flex-end;gap:8px 16px;margin:4px 0 16px;padding-bottom:8px;border-bottom:2px solid var(--h2-line)}
.section-head h2{font-size:19px;line-height:1.3;color:var(--blue)}
.section-head .sub{font-size:12px;color:var(--muted);padding-bottom:3px}
.section-head .spacer{flex:1}
h3.eyebrow{margin-bottom:10px}
.empty{padding:28px;text-align:center;color:var(--muted);font-size:13px}

.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 12px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--text);font-size:12px;font-weight:500;cursor:pointer;transition:border-color .15s,color .15s,background .15s}
.btn:hover{border-color:var(--blue2);color:var(--blue2)}
.btn.icon-only{width:30px;padding:0}
.btn:disabled{opacity:.4;cursor:default;border-color:var(--line);color:var(--text)}
.select,.input{height:30px;border:1px solid var(--line);border-radius:8px;background:var(--card);padding:0 10px;font-size:12px;outline:none}
.select:focus,.input:focus{border-color:var(--blue2);box-shadow:0 0 0 3px var(--accent-soft)}

/* Metadata */
.meta-card{margin-bottom:16px;overflow:hidden}
.meta-card-head{display:flex;align-items:center;gap:8px;padding:12px 18px;font-size:13px;font-weight:600;color:var(--ink);border-bottom:1px solid var(--line-soft);background:var(--soft)}
.meta-card-head .ico{color:var(--blue2)}
.meta-row{display:grid;grid-template-columns:200px 1fr minmax(0,auto);gap:4px 16px;padding:10px 18px;border-bottom:1px solid var(--line-soft);align-items:baseline}
.meta-row:last-child{border-bottom:0}
.meta-label{font-size:12px;font-weight:500;color:var(--muted)}
.meta-value{font-size:13px;color:var(--ink);overflow-wrap:anywhere}
.meta-value strong{font-weight:600;color:var(--blue)}
.meta-uri{font-family:${MONO};font-size:10px;color:var(--muted);text-align:right;overflow-wrap:anywhere;max-width:320px}
.pill{display:inline-block;padding:1px 9px;margin:2px 4px 2px 0;border-radius:999px;background:var(--accent-soft);color:var(--blue);font-size:12px;font-weight:500}
@media (max-width:760px){.meta-row{grid-template-columns:1fr}.meta-uri{text-align:left}}

/* JSON-LD viewer */
.overlay{position:fixed;inset:0;z-index:50;display:none;align-items:center;justify-content:center;padding:24px;background:rgba(15,27,45,.45);backdrop-filter:blur(2px)}
.overlay.open{display:flex}
.dialog{display:flex;flex-direction:column;width:min(1000px,100%);height:min(86vh,100%);background:var(--card);border:1px solid var(--line-soft);border-radius:12px;box-shadow:0 24px 60px rgba(15,27,45,.28);overflow:hidden}
.dialog-head{display:flex;align-items:center;gap:10px;padding:12px 14px 12px 18px;border-bottom:1px solid var(--line-soft)}
.dialog-title{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:600;color:var(--ink);flex:1;min-width:0}
.dialog-title .ico{color:var(--blue2)}
.dialog-body{flex:1;overflow:auto;margin:0;padding:16px 18px;background:var(--soft);font-family:${MONO};font-size:12px;line-height:1.6;tab-size:2;white-space:pre;color:var(--text)}
.json-key{color:#0b5c99}.json-str{color:#2b7a3d}.json-num{color:#a0560f}.json-bool{color:#6d3fb5}
@media (prefers-color-scheme:dark){.json-key{color:#8cc5ee}.json-str{color:#8fd19e}.json-num{color:#e5b073}.json-bool{color:#c3a6f5}}

/* Schema */
.erd-card{padding:16px;margin-bottom:22px}
.erd-scroll{overflow-x:auto}
.erd{display:block;margin:0 auto;max-width:none;font-family:system-ui,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif}
.erd .edge{fill:none;stroke:var(--edge);stroke-width:1.5;opacity:.7}
.erd .handle{fill:var(--edge);stroke:var(--card);stroke-width:1.5}
.erd .node{cursor:pointer}
.erd .node:hover .outline{stroke-width:2.5}
.erd .label{font-size:11px;font-weight:700;fill:var(--ink)}
.erd .col{font-family:${MONO};font-size:10.5px;fill:var(--text)}
.erd .badge-text{font-size:7.5px;font-weight:700;letter-spacing:.02em}
${TABLE_TYPES.map((t) => `.t-${t} .body{fill:var(--${t}-bg)}.t-${t} .head{fill:var(--${t}-head)}.t-${t} .outline{stroke:var(--${t}-border)}.t-${t} .node-ico{color:var(--${t}-ico)}`).join('\n')}
.erd .outline{fill:none;stroke-width:1.5}
${(['pk', 'fk', 'value', 'date'] as const).map((r) => `.r-${r} rect{fill:var(--${r}-bg)}.r-${r} text{fill:var(--${r}-fg)}.role.r-${r}{background:var(--${r}-bg);color:var(--${r}-fg)}`).join('\n')}
.legend{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:12px;padding-top:12px;border-top:1px solid var(--line-soft);font-size:11px;color:var(--muted)}
.legend span{display:inline-flex;align-items:center;gap:6px}
.swatch{display:inline-block;width:10px;height:10px;border-radius:3px;border:1.5px solid}
${TABLE_TYPES.map((t) => `.swatch.t-${t}{background:var(--${t}-head);border-color:var(--${t}-border)}`).join('')}
.schema-layout{display:flex;gap:18px;align-items:flex-start}
.toc{flex:0 0 220px;position:sticky;top:16px;max-height:calc(100vh - 32px);display:flex;flex-direction:column;overflow:hidden}
.toc-search{position:relative;padding:10px;border-bottom:1px solid var(--line-soft)}
.toc-search .ico{position:absolute;left:19px;top:50%;transform:translateY(-50%);color:var(--muted)}
.toc-search input{width:100%;padding-left:28px}
.toc-list{overflow-y:auto;padding:6px}
.toc-item{display:flex;align-items:center;gap:7px;padding:5px 8px;border-radius:6px;font-family:${MONO};font-size:11px;color:var(--text);cursor:pointer;white-space:nowrap}
.toc-item:hover{background:var(--row-hover);text-decoration:none}
.toc-item.active{background:var(--accent-soft);color:var(--blue)}
.toc-item .name{overflow:hidden;text-overflow:ellipsis;flex:1}
.toc-item .n{font-family:system-ui,sans-serif;font-size:10px;color:var(--muted)}
.toc-item .ico{color:var(--muted)}
${TABLE_TYPES.map((t) => `.toc-item.t-${t} .ico,.tbl.t-${t} .tbl-head .ico{color:var(--${t}-ico)}`).join('')}
.schema-main{flex:1;min-width:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px;align-content:start}
.tbl{overflow:hidden;scroll-margin-top:16px;transition:box-shadow .3s}
.tbl.flash{box-shadow:0 0 0 3px var(--accent-soft),var(--shadow)}
.tbl-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--line-soft)}
${TABLE_TYPES.map((t) => `.tbl.t-${t} .tbl-head{background:var(--${t}-bg);border-bottom-color:var(--${t}-head)}`).join('')}
.tbl-name{font-family:${MONO};font-size:12px;font-weight:600;color:var(--ink);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tbl-count{font-size:10px;color:var(--muted);background:var(--soft);padding:1px 7px;border-radius:999px}
.tbl-role{padding:5px 12px;font-size:11px;color:var(--muted);border-bottom:1px solid var(--line-soft)}
.cols{width:100%;border-collapse:collapse;font-size:12px}
.cols td{padding:4px 12px;border-bottom:1px solid var(--line-soft)}
.cols tr:last-child td{border-bottom:0}
.cols .c-name{white-space:nowrap}
.cols .c-name code{font-size:11.5px;color:var(--ink)}
.cols .c-type{text-align:right}
.cols .c-type code{font-size:10.5px;color:var(--muted)}
.role{display:inline-block;font-style:normal;min-width:26px;margin-right:6px;padding:1px 4px;border-radius:4px;font-size:8px;font-weight:700;text-align:center;text-transform:uppercase;vertical-align:1px}
.role.none{background:none}
@media (max-width:820px){.schema-layout{flex-direction:column}.toc{position:static;flex:none;width:100%;max-height:240px}}

/* Explore */
.seg{display:inline-flex;padding:2px;border-radius:8px;background:var(--soft);border:1px solid var(--line-soft)}
.seg button{height:24px;padding:0 11px;border:0;border-radius:6px;background:none;font-size:12px;font-weight:500;color:var(--muted);cursor:pointer;white-space:nowrap}
.seg button:hover:not(:disabled):not(.active){color:var(--ink)}
.seg button.active{background:var(--card);color:var(--blue);box-shadow:0 1px 2px rgba(15,27,45,.12)}
.seg button:disabled{opacity:.4;cursor:not-allowed}
.seg.full{display:flex}.seg.full button{flex:1}
.seg.mini button{height:20px;padding:0 8px;font-size:10px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:18px}
.kpi{display:flex;align-items:center;gap:12px;background:var(--card);border:1px solid var(--line-soft);border-radius:10px;padding:12px 14px}
.kpi-ico{display:flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:9px;background:var(--accent-soft);color:var(--blue2)}
.kpi .v{font-size:22px;font-weight:600;color:var(--ink);line-height:1.15}
.kpi .l{font-size:12px;color:var(--muted)}
.explore{display:grid;grid-template-columns:264px minmax(0,1fr);gap:18px;align-items:start}
.xp-side{position:sticky;top:16px;max-height:calc(100vh - 32px);overflow-y:auto;padding:14px}
.xp-sec{padding-bottom:14px;margin-bottom:14px;border-bottom:1px solid var(--line-soft)}
.xp-sec-t{font-weight:600;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin-bottom:8px}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{height:28px;padding:0 12px;border:1px solid var(--line);border-radius:999px;background:var(--card);font-size:12px;font-weight:500;color:var(--text);cursor:pointer;transition:all .15s}
.chip:hover:not(:disabled){border-color:var(--blue2);color:var(--blue2)}
.chip.on,.chip.on:hover:not(:disabled){background:var(--blue2);border-color:var(--blue2);color:#fff}
.chip:disabled{opacity:.4;cursor:not-allowed}
.hint{font-size:11px;color:var(--muted);margin-top:8px;line-height:1.4}
.flt{margin-bottom:14px}
.flt:last-child{margin-bottom:0}
.flt-head{display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:12px;font-weight:600;color:var(--ink)}
.flt-head .spacer{flex:1}
.flt .select,.flt .input{width:100%;margin-top:6px}
.flt .flt-search{margin:0 0 6px}
.link{border:0;background:none;padding:0;font-size:11px;color:var(--blue2);cursor:pointer}
.link:hover{text-decoration:underline}
.pills{display:flex;flex-wrap:wrap;gap:4px}
.pill-t{height:24px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 9px;border:1px solid var(--line);border-radius:6px;background:var(--card);font-size:11px;color:var(--muted);cursor:pointer;text-decoration:line-through;text-decoration-color:transparent}
.pill-t.on{background:var(--accent-soft);border-color:transparent;color:var(--blue);font-weight:500}
.pill-t:not(.on){opacity:.7}
.checks{max-height:190px;overflow-y:auto;border:1px solid var(--line-soft);border-radius:8px;padding:4px}
.check{display:flex;align-items:center;gap:7px;padding:3px 6px;border-radius:5px;font-size:12px;cursor:pointer}
.check:hover{background:var(--row-hover)}
.check span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.check input{accent-color:var(--blue2)}
.range{position:relative;height:26px;margin:4px 6px 0}
.range-track{position:absolute;left:0;right:0;top:11px;height:4px;border-radius:2px;background:var(--line-soft)}
.range-fill{position:absolute;top:0;bottom:0;border-radius:2px;background:var(--blue2)}
.range input{position:absolute;left:-6px;right:-6px;top:3px;width:calc(100% + 12px);margin:0;height:20px;background:none;pointer-events:none;-webkit-appearance:none;appearance:none}
.range input::-webkit-slider-thumb{-webkit-appearance:none;pointer-events:auto;width:14px;height:14px;border-radius:50%;background:var(--card);border:2px solid var(--blue2);cursor:grab;box-shadow:0 1px 3px rgba(15,27,45,.2)}
.range input::-moz-range-thumb{pointer-events:auto;width:12px;height:12px;border-radius:50%;background:var(--card);border:2px solid var(--blue2);cursor:grab}
.range input::-moz-range-track{background:none}
.range-labels{display:flex;justify-content:space-between;font-size:11px;color:var(--ink);font-weight:500;margin-top:2px}
.cal{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.cal label{display:flex;flex-direction:column;gap:2px;font-size:10px;color:var(--muted)}
.cal .input{margin:0;padding:0 6px}
.presets{display:flex;gap:12px;margin-top:8px}
.slice{display:block;margin-bottom:10px;font-size:12px;font-weight:500;color:var(--ink)}
.slice .select,.slice .input{display:block;width:100%;margin-top:4px}
.btn.full{width:100%}
.btn.sm{height:24px;padding:0 8px;font-size:11px;gap:4px}
.xp-head{display:flex;align-items:flex-start;gap:12px;margin-bottom:12px}
.xp-head h3{font-size:16px;color:var(--ink);line-height:1.3}
.ctx{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:14px}
.st{border:1px solid var(--line-soft);border-radius:10px;padding:10px 12px;border-left:3px solid var(--blue2)}
.st-v{font-size:18px;font-weight:600;color:var(--ink);line-height:1.2}
.st-l{font-size:11px;color:var(--muted)}
.st-s{font-size:10px;color:var(--muted);opacity:.85;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.charts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-bottom:14px}
.chart{padding:14px 16px 12px;min-width:0}
.chart.full{grid-column:1/-1}
.chart-head{display:flex;align-items:center;flex-wrap:wrap;gap:6px 10px;margin-bottom:10px}
.chart-head h4{font-size:13px;font-weight:600;color:var(--ink)}
.chart-head .sub{font-size:11px;color:var(--muted)}
.chart-head .spacer{flex:1}
.chart-body{min-width:0}
.ch{display:block;overflow:visible;font-family:system-ui,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif}
.ch .grid{stroke:var(--line-soft);stroke-dasharray:2 3}
.ch .axis{stroke:var(--line)}
.ch .tick{font-size:10px;fill:var(--muted)}
.ch .lbl{font-size:11px;fill:var(--text)}
.ch .val{font-size:10.5px;fill:var(--muted);font-variant-numeric:tabular-nums}
.ch .strong{font-weight:600;fill:var(--ink)}
.ch .donut-v{font-size:22px;font-weight:600;fill:var(--ink)}
.ch .hit{fill:transparent}
.ch .hit.col:hover{fill:var(--ink);fill-opacity:.05}
.ch .hit.row:hover{fill:var(--ink);fill-opacity:.04}
.ch .bar:hover,.ch .slice:hover{filter:brightness(1.12)}
.ch .hatch-bg{fill:var(--card)}
.ch .hatch-line{stroke:var(--muted);stroke-width:2;opacity:.45}
.ch .dot{stroke:var(--card);stroke-width:1.2}
.ch-legend{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:10px;font-size:11px;color:var(--text)}
.ch-legend span{display:inline-flex;align-items:center;gap:6px}
.ch-legend i{width:10px;height:10px;border-radius:2.5px}
.caption{font-size:11px;color:var(--muted);margin-top:8px}
.tip{position:fixed;left:0;top:0;z-index:60;pointer-events:none;opacity:0;transition:opacity .1s;max-width:320px;padding:8px 10px;border-radius:8px;background:var(--ink);color:var(--card);font-size:11.5px;line-height:1.45;box-shadow:0 8px 24px rgba(15,27,45,.25)}
.tip.on{opacity:1}
.tip b{display:block;font-weight:600;margin-bottom:3px}
.tip .tl{display:flex;align-items:center;gap:8px}
.tip .tl i{width:8px;height:8px;border-radius:2px;flex-shrink:0}
.tip .tl span{flex:1;opacity:.8}
.tip .tl em{font-style:normal;font-weight:600;font-variant-numeric:tabular-nums}
@media (max-width:900px){.explore{grid-template-columns:1fr}.xp-side{position:static;max-height:none}.charts{grid-template-columns:1fr}}
.hm-scroll{overflow-x:auto}
.hm-t{border-collapse:separate;border-spacing:2px;font-size:11px}
.hm-t th{padding:4px 8px;font-weight:500;font-size:10px;color:var(--muted);white-space:nowrap;text-align:center;max-width:120px;overflow:hidden;text-overflow:ellipsis}
.hm-t th.corner{text-align:left;font-size:10px}
.hm-t th.corner span{opacity:.5}
.hm-t th.row{position:sticky;left:0;z-index:1;background:var(--card);text-align:left;font-size:11px;color:var(--text);max-width:240px}
.hm-t td{min-width:46px;padding:5px 7px;border-radius:4px;text-align:center;white-space:nowrap;font-variant-numeric:tabular-nums}
.hm-t td.masked{background:repeating-linear-gradient(45deg,var(--hatch) 0 2px,transparent 2px 6px);color:var(--muted);font-size:10px}
.hm-t td.masked.m2{font-style:italic}
.hm-t td.all,.hm-t th.all{background:var(--soft);color:var(--ink);font-weight:600}
.hm-t tr.all-row th.row{color:var(--ink);font-weight:600}
.hm-scale{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:10px;font-size:10px;color:var(--muted)}
.hm-scale .spacer{flex:1}
.hm-scale .bar{width:120px;height:8px;border-radius:4px}
.hm-scale .mask{width:14px;height:10px;border-radius:3px;background:repeating-linear-gradient(45deg,var(--hatch) 0 2px,transparent 2px 6px);border:1px solid var(--line-soft)}

/* DataTable (createDataTable in the page script) */
.dt-csv{height:26px;padding:0 9px;font-size:11px;gap:5px}
.dt{overflow:hidden}
.dt-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--line-soft)}
.search{position:relative;flex:0 1 300px}
.search .ico{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--muted)}
.search input{width:100%;padding-left:30px}
.dt-toolbar .spacer{flex:1}
.dt-note{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--muted)}
.dt-note .ico{color:var(--warn)}
.dt-scroll{max-height:68vh;overflow:auto}
.dt table{width:100%;table-layout:fixed;border-collapse:separate;border-spacing:0;font-size:12px}
.dt thead th{position:sticky;z-index:2;background:var(--soft);text-align:left;font-weight:600;color:var(--ink);white-space:nowrap}
.dt th.fill,.dt td.fill{padding:0!important}
.dt thead tr.head th{top:0;height:34px;padding:0 10px;border-bottom:1px solid var(--line-soft)}
.dt thead tr.filters th{top:34px;padding:4px 6px 6px;border-bottom:1px solid var(--line)}
.dt th.r,.dt td.r{text-align:right}
.sort{display:inline-flex;align-items:center;gap:5px;max-width:100%;padding:0;border:0;background:none;font-weight:600;font-size:12px;color:inherit;cursor:pointer}
.sort .lbl{min-width:0;overflow:hidden;text-overflow:ellipsis}
.rz{position:absolute;top:0;right:0;width:8px;height:100%;cursor:col-resize;touch-action:none;user-select:none}
.rz::after{content:'';position:absolute;top:0;bottom:0;right:3px;width:2px;border-radius:1px;background:transparent;transition:background .15s}
.rz:hover::after{background:var(--line)}
.rz.on::after{background:var(--blue2)}
body.col-resizing{cursor:col-resize;user-select:none}
th.r .sort{flex-direction:row-reverse}
.sort .ico{color:var(--muted);opacity:.45}
.sort.on .ico{color:var(--blue2);opacity:1}
.f{width:100%;height:24px;border:1px dashed var(--line);border-radius:5px;background:transparent;padding:0 6px;font-size:10px;font-weight:400;outline:none;color:var(--text)}
.f::placeholder{color:var(--muted)}
.f:focus{border-color:var(--blue2);border-style:solid}
select.f{padding:0 2px;cursor:pointer}
.dt tbody td{padding:6px 10px;border-bottom:1px solid var(--line-soft);color:var(--text);vertical-align:top;overflow:hidden;text-overflow:ellipsis;overflow-wrap:anywhere}
.dt tr.pinned td{background:var(--soft);color:var(--ink);font-weight:600}
.dt tbody tr:hover td{background:var(--row-hover)}
.dt td.id{font-family:${MONO};font-size:11px;color:var(--muted);white-space:nowrap}
.dt td.name{color:var(--ink)}
.dt td.r{font-variant-numeric:tabular-nums;white-space:nowrap}
.dt tr.anon td.r{color:var(--warn)}
.dt tr.anon td.r.p{font-weight:500}
.dt tr.anon td:first-child{box-shadow:inset 2px 0 0 var(--warn)}
.dt .no-rows td{padding:28px;text-align:center;color:var(--muted)}
.dt-foot{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:6px 12px;border-top:1px solid var(--line-soft);font-size:12px;color:var(--muted)}
.dt-foot .spacer{flex:1}
.dt-foot .select{height:26px;padding:0 6px}
.dt-foot .btn{height:26px}
.dt-foot .btn.icon-only{width:26px}
.page-info{min-width:56px;text-align:center}

footer{margin:20px 28px 0;padding:14px 0 20px;border-top:1px solid var(--line);font-size:11px;color:var(--muted);display:flex;flex-wrap:wrap;gap:4px 18px;justify-content:center}
footer span{display:inline-flex;align-items:center;gap:6px}

@media print{
  body{background:#fff}
  .tabs,.toc,.dt-toolbar,.dt-foot,.xp-side,.overlay,.rz,.tip{display:none!important}
  .tab-content{display:block!important;margin-bottom:24px}
  .sheet{margin:0;border:0;box-shadow:none;max-width:none}
  .dt-scroll{max-height:none;overflow:visible}
}
`
