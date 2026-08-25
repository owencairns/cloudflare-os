// MyoPlan Docs — two-pane browser over the gadget's document store.
// Left: the implicit folder tree (derived from paths) plus search.
// Right: the selected document, rendered markdown, with an edit mode.
// Everything here is a thin reader/editor over the same RPC surface agents use.

const style = document.createElement("style");
style.textContent = `
/* ===== Host token map (packages/workshop-frontend/src/styles.css) =========================
   Identical block in both gadgets so Tasks and Memory read as one product family native to
   the MyoPlan OS shell. Values are copied from the host's @theme / [data-mode="dark"] blocks;
   the accent is reserved for intent (links, focus, selection) exactly as the host reserves it. */
:root {
  color-scheme: light dark;

  --base:       #ffffff;
  --elevated:   #f8fafc;
  --tint:       #f1f5f9;
  --recessed:   #eef2f7;
  --fill:       #e2e8f0;
  --fill-hover: #cbd5e1;
  --contrast:   #0f172a;
  --brand:      #334155;
  --brand-hover:#1e293b;

  --line:        #0f172a0f;
  --line-strong: #e2e8f0;
  --ring:        #94a3b8;

  --text:    #0f172a;
  --strong:  #020617;
  --muted:   #64748b;
  --faint:   #94a3b8;
  --inverse: #ffffff;
  --link:    #1a8a9c;

  --info:         #2aafc0;
  --info-tint:    #e0f4f6;
  --warning:      #e8a848;
  --warning-tint: #fdf3df;
  --danger:       #c76b76;
  --danger-tint:  #f6dadd;
  --success:      #16a34a;
  --success-tint: #e6f6ec;

  --on-info:    #0f4c56;
  --on-warning: #a16617;
  --on-danger:  #b0505c;
  --on-success: #15803d;

  --cat-teal:   #2aafc0;
  --cat-violet: #8b7ec8;
  --cat-green:  #6b9080;
  --cat-amber:  #c4956a;

  --selection-bg:   #e0f4f6;
  --selection-text: #0f4c56;

  --r-sm: 4px;
  --r-md: 6px;
  --r-lg: 8px;
  --r-xl: 12px;

  --ease: cubic-bezier(0, 0, 0.2, 1);
  --focus-ring: 0 0 0 3px color-mix(in srgb, var(--ring) 15%, transparent);
  --pop-shadow: 0 8px 20px rgba(15, 23, 42, 0.1);

  --font: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text",
    "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, "JetBrains Mono", SFMono-Regular, Menlo, monospace;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-mode="light"]) {
    --base:       #0b1220;
    --elevated:   #0f172a;
    --tint:       #1e293b;
    --recessed:   #070d18;
    --fill:       #1e293b;
    --fill-hover: #334155;
    --contrast:   #475569;
    --brand:      #475569;
    --brand-hover:#64748b;

    --line:        #334155;
    --line-strong: #475569;
    --ring:        #64748b;

    --text:    #f8fafc;
    --strong:  #f8fafc;
    --muted:   #94a3b8;
    --faint:   #64748b;
    --inverse: #ffffff;
    --link:    #7dd3e0;

    --info:         #5cc9d8;
    --info-tint:    #123642;
    --warning:      #d9a441;
    --warning-tint: #3a2e14;
    --danger:       #e79aa4;
    --danger-tint:  #3d1f24;
    --success:      #5fbf82;
    --success-tint: #123021;

    --on-info:    #7dd3e0;
    --on-warning: #f0c46a;
    --on-danger:  #e79aa4;
    --on-success: #6ee7a0;

    --cat-teal:   #5cc9d8;
    --cat-violet: #a99ae0;
    --cat-green:  #8fb3a1;
    --cat-amber:  #d6ab84;

    --selection-bg:   #16404b;
    --selection-text: #f8fafc;

    --pop-shadow: 0 8px 20px rgba(0, 0, 0, 0.32);
  }
}

:root[data-mode="dark"] {
  --base:       #0b1220;
  --elevated:   #0f172a;
  --tint:       #1e293b;
  --recessed:   #070d18;
  --fill:       #1e293b;
  --fill-hover: #334155;
  --contrast:   #475569;
  --brand:      #475569;
  --brand-hover:#64748b;

  --line:        #334155;
  --line-strong: #475569;
  --ring:        #64748b;

  --text:    #f8fafc;
  --strong:  #f8fafc;
  --muted:   #94a3b8;
  --faint:   #64748b;
  --inverse: #ffffff;
  --link:    #7dd3e0;

  --info:         #5cc9d8;
  --info-tint:    #123642;
  --warning:      #d9a441;
  --warning-tint: #3a2e14;
  --danger:       #e79aa4;
  --danger-tint:  #3d1f24;
  --success:      #5fbf82;
  --success-tint: #123021;

  --on-info:    #7dd3e0;
  --on-warning: #f0c46a;
  --on-danger:  #e79aa4;
  --on-success: #6ee7a0;

  --cat-teal:   #5cc9d8;
  --cat-violet: #a99ae0;
  --cat-green:  #8fb3a1;
  --cat-amber:  #d6ab84;

  --selection-bg:   #16404b;
  --selection-text: #f8fafc;

  --pop-shadow: 0 8px 20px rgba(0, 0, 0, 0.32);
}

/* ===== Base ============================================================================== */
* { box-sizing: border-box; }
html, body {
  margin: 0; height: 100%;
  background: var(--base); color: var(--text);
  font-family: var(--font);
  font-size: 13px; line-height: 18px; letter-spacing: -0.25px;
  -webkit-font-smoothing: antialiased;
}
button, input, select, textarea { font: inherit; letter-spacing: inherit; color: inherit; }
::selection { background: var(--selection-bg); color: var(--selection-text); }
* { scrollbar-width: thin; scrollbar-color: var(--fill-hover) transparent; }
*::-webkit-scrollbar { width: 9px; height: 9px; }
*::-webkit-scrollbar-thumb { background: var(--fill-hover); border-radius: 9px; border: 3px solid transparent; background-clip: content-box; }

/* ===== Controls — Kumo's rendered recipes (WorkshopControls.tsx) ========================== */
.btn {
  appearance: none; display: inline-flex; align-items: center; justify-content: center;
  height: 32px; padding: 0 12px; gap: 6px;
  border: 1px solid var(--line); background: var(--base); color: var(--text);
  border-radius: var(--r-lg);
  font-size: 13px; line-height: 18px; font-weight: 500; letter-spacing: -0.25px;
  white-space: nowrap; cursor: pointer;
  transition: background-color .15s var(--ease), color .15s var(--ease),
    border-color .15s var(--ease), opacity .15s var(--ease), transform .15s var(--ease);
}
.btn:hover { background: var(--elevated); }
.btn:active { transform: scale(0.98); }
.btn:focus-visible { outline: none; border-color: var(--ring); box-shadow: var(--focus-ring); }
.btn.primary {
  height: 36px; background: var(--contrast); border-color: transparent; color: var(--inverse);
}
.btn.primary:hover { background: var(--brand-hover); }
.btn.ghost, .btn.quiet {
  background: transparent; border-color: transparent; color: var(--muted); font-weight: 400;
}
.btn.ghost:hover, .btn.quiet:hover { background: var(--tint); color: var(--text); }
.btn.danger { background: transparent; border-color: transparent; color: var(--muted); font-weight: 400; }
.btn.danger:hover { background: var(--danger-tint); color: var(--on-danger); }
.btn:disabled { opacity: .4; cursor: not-allowed; transform: none; }

.input, .select, .textarea, .search {
  width: 100%; appearance: none;
  height: 36px; padding: 0 12px;
  background: var(--base); color: var(--text);
  border: 1px solid var(--line); border-radius: var(--r-lg);
  font-size: 13px; line-height: 18px; letter-spacing: -0.25px; font-weight: 400;
  transition: border-color .15s var(--ease), box-shadow .15s var(--ease);
}
.input::placeholder, .textarea::placeholder, .search::placeholder { color: var(--faint); }
.input:focus, .select:focus, .textarea:focus, .search:focus {
  outline: none; border-color: var(--ring); box-shadow: var(--focus-ring);
}
.textarea { height: auto; min-height: 68px; padding: 8px 12px; resize: vertical; line-height: 18px; }
.select {
  padding-right: 28px;
  background-image: linear-gradient(45deg, transparent 50%, currentColor 50%),
                    linear-gradient(135deg, currentColor 50%, transparent 50%);
  background-position: calc(100% - 15px) 15px, calc(100% - 11px) 15px;
  background-size: 4px 4px, 4px 4px; background-repeat: no-repeat;
  color: var(--text);
}

/* Filter chips — the host's FilterChip: 32px, rounded-lg, fill when active. Never a capsule. */
.chip {
  appearance: none; display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto;
  height: 28px; padding: 0 10px; border: none; border-radius: var(--r-lg);
  background: transparent; color: var(--muted);
  font-size: 13px; line-height: 18px; font-weight: 500; letter-spacing: -0.25px;
  white-space: nowrap; cursor: pointer;
  transition: background-color .15s var(--ease), color .15s var(--ease);
}
.chip:hover { background: var(--tint); color: var(--text); }
.chip.on { background: var(--fill); color: var(--strong); }
.chip .count { color: var(--faint); font-variant-numeric: tabular-nums; font-weight: 400; }
.chip.on .count { color: var(--muted); }
.chip.vacant { opacity: .5; }
.chip-sep { width: 1px; align-self: stretch; background: var(--line); margin: 6px 4px; flex: 0 0 auto; }

/* Section eyebrow — the host's SectionEyebrow: 11px caps, hairline rule, count. */
.band-label, .group-label {
  display: flex; align-items: center; gap: 12px;
  margin: 18px 4px 10px;
  font-size: 11px; line-height: 16px; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.9px; color: var(--muted);
}
.band-label:first-child, .group-label:first-child { margin-top: 4px; }
.band-label .rule, .group-label .rule { flex: 1 1 auto; height: 1px; background: var(--line); }
.band-label .n, .group-label .n {
  color: var(--faint); font-weight: 600; letter-spacing: -0.1px;
  font-variant-numeric: tabular-nums; text-transform: none;
}

/* Empty state — the host's EmptyState: dashed hairline, rounded-xl, 14px title / 13px body. */
.empty {
  border: 1px dashed var(--line); border-radius: var(--r-xl);
  background: var(--base); padding: 36px 24px; text-align: center;
  color: var(--muted); font-size: 13px; line-height: 18px; letter-spacing: -0.25px;
}
.empty strong {
  display: block; color: var(--text);
  font-size: 14px; line-height: 20px; font-weight: 500; letter-spacing: -0.3px; margin-bottom: 4px;
}

/* Toast — quiet surface + host floating shadow, not a coloured capsule. */
.toast {
  position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%);
  background: var(--base); border: 1px solid var(--line); color: var(--text);
  border-radius: var(--r-lg); padding: 8px 14px; max-width: 80vw;
  font-size: 13px; line-height: 18px; letter-spacing: -0.25px;
  box-shadow: var(--pop-shadow); z-index: 50;
}

/* ===== Docs shell ========================================================================= */
.app { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }

.topbar {
  flex: 0 0 auto; padding: 12px 16px 0;
  background: var(--base); border-bottom: 1px solid var(--line);
}
.topbar-row { display: flex; align-items: center; gap: 8px; }
.brand { display: flex; align-items: baseline; gap: 8px; min-width: 0; margin-right: auto; }
.brand h1 {
  margin: 0; font-size: 15px; line-height: 20px; font-weight: 500;
  letter-spacing: -0.3px; color: var(--text);
}
.brand .count {
  color: var(--faint); font-size: 12px; line-height: 16px; letter-spacing: -0.2px;
  white-space: nowrap; font-variant-numeric: tabular-nums;
}
.spacer { flex: 1 1 auto; }
.topbar .search { width: min(38vw, 280px); }

/* Tag filter rail — the same scrolling chip strip Tasks and Memory carry under the topbar. */
.tags {
  display: flex; align-items: center; gap: 2px;
  margin: 0 -4px; padding: 8px 4px 6px;
  overflow-x: auto; scrollbar-width: none;
}
.tags::-webkit-scrollbar { display: none; }

.body { flex: 1 1 auto; display: flex; min-height: 0; }

.sidebar {
  width: 300px; flex: 0 0 auto; border-right: 1px solid var(--line);
  background: var(--elevated); display: flex; flex-direction: column; min-height: 0;
}
.tree { flex: 1 1 auto; overflow-y: auto; padding: 6px 10px 24px; }

/* ===== Tree + result rows — the shared row recipe: flat, 8px radius, tint on hover, fill on
   selection. A folder tree carries no inter-row hairline (the indentation already groups it);
   the flat search-result list does, exactly as Memory's index rows do. ==================== */
.row {
  display: flex; align-items: center; gap: 6px; width: 100%;
  padding: 6px 10px; border-radius: var(--r-lg);
  border: none; background: none; color: inherit; text-align: left; cursor: pointer;
  font-size: 13px; line-height: 18px; letter-spacing: -0.25px;
  transition: background-color .15s var(--ease);
}
.row:hover { background: var(--tint); }
.row.on { background: var(--fill); }
.row:focus-visible { outline: none; box-shadow: var(--focus-ring); }
.row .tw {
  flex: 0 0 auto; width: 12px; text-align: center;
  color: var(--faint); font-size: 10px; line-height: 18px;
}
.row .label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Folder names borrow the host's SectionEyebrow idiom — the tree's structure is its sectioning. */
.row.folder .label {
  font-size: 11px; line-height: 16px; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.9px; color: var(--muted);
}
.row.doc .label { font-weight: 500; color: var(--text); }
.row.doc.on .label { color: var(--strong); }
.row .n {
  flex: 0 0 auto; font-size: 11px; line-height: 16px; letter-spacing: -0.1px;
  font-weight: 600; color: var(--faint); font-variant-numeric: tabular-nums;
}

.result {
  padding: 8px 10px; border-radius: var(--r-lg);
  border: 1px solid transparent; cursor: pointer;
  transition: background-color .15s var(--ease);
}
.result + .result { box-shadow: inset 0 1px 0 var(--line); }
.result:hover { background: var(--tint); box-shadow: none; }
.result:hover + .result { box-shadow: none; }
.result.on { background: var(--fill); box-shadow: none; }
.result.on + .result { box-shadow: none; }
.result .t {
  font-size: 13px; line-height: 18px; font-weight: 500; letter-spacing: -0.25px;
  color: var(--text); word-break: break-word;
}
.result.on .t { color: var(--strong); }
.result .p {
  font-family: var(--mono); font-size: 11px; line-height: 16px; letter-spacing: 0;
  color: var(--faint); margin-top: 2px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.result .e {
  font-size: 12px; line-height: 16px; letter-spacing: -0.2px; color: var(--muted); margin-top: 3px;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}

.main { flex: 1 1 auto; overflow-y: auto; min-width: 0; background: var(--base); }
.pane { max-width: 720px; margin: 0 auto; padding: 24px 28px 80px; }

.tree .empty { margin: 10px 2px; padding: 28px 16px; }
.pane > .empty { margin-top: 28px; }

/* ===== Detail ============================================================================= */
/* Breadcrumb — quiet meta type, not a coloured trail. */
.crumbs {
  display: flex; flex-wrap: wrap; align-items: center; gap: 1px; margin-bottom: 10px;
  font-size: 12px; line-height: 16px; letter-spacing: -0.2px; color: var(--muted);
}
.crumbs .seg {
  border: none; background: none; font: inherit; letter-spacing: inherit; color: var(--muted);
  padding: 1px 4px; border-radius: var(--r-sm); cursor: pointer;
  transition: background-color .15s var(--ease), color .15s var(--ease);
}
.crumbs .seg:hover { background: var(--tint); color: var(--text); }
.crumbs .seg:focus-visible { outline: none; box-shadow: var(--focus-ring); }
.crumbs .seg.last { color: var(--text); font-weight: 500; cursor: default; }
.crumbs .seg.last:hover { background: none; }
.crumbs .sep { color: var(--faint); }

/* The host's largest in-pane heading is 20px; the gadget stays inside that ceiling. */
.pane h2 {
  margin: 0; font-size: 20px; line-height: 28px; font-weight: 600;
  letter-spacing: -0.35px; color: var(--text); word-break: break-word;
}
.editor-title { margin-bottom: 20px !important; }
.meta {
  color: var(--faint); font-size: 12px; line-height: 16px; letter-spacing: -0.2px; margin: 8px 0 0;
}
/* Document tags are the same chip a filter is, so a tag reads identically everywhere. */
.taglist { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 10px; }
.actions {
  display: flex; gap: 6px; margin: 16px 0 20px; padding-bottom: 16px;
  border-bottom: 1px solid var(--line);
}

/* ===== Markdown body ====================================================================== */
.md { font-size: 13px; line-height: 20px; letter-spacing: -0.25px; color: var(--text); }
.md h1 { font-size: 17px; line-height: 24px; margin: 22px 0 8px; font-weight: 600; letter-spacing: -0.35px; }
.md h2 { font-size: 15px; line-height: 20px; margin: 20px 0 8px; font-weight: 600; letter-spacing: -0.3px; }
.md h3 { font-size: 13px; line-height: 18px; margin: 16px 0 6px; font-weight: 600; letter-spacing: -0.25px; color: var(--muted); }
.md h1:first-child, .md h2:first-child { margin-top: 0; }
.md p { margin: 0 0 12px; }
.md ul, .md ol { margin: 0 0 12px; padding-left: 20px; }
.md li { margin-bottom: 4px; }
.md code {
  font-family: var(--mono); font-size: 12px; letter-spacing: 0;
  background: var(--tint); border: 1px solid var(--line); border-radius: var(--r-sm); padding: 1px 5px;
}
.md pre {
  background: var(--elevated); border: 1px solid var(--line); border-radius: var(--r-lg);
  padding: 12px 14px; overflow-x: auto; margin: 0 0 14px;
}
.md pre code { background: none; border: none; padding: 0; }
.md blockquote {
  margin: 0 0 12px; padding: 2px 0 2px 12px;
  border-left: 2px solid var(--line-strong); color: var(--muted);
}
.md hr { border: none; border-top: 1px solid var(--line); margin: 18px 0; }
.md table { border-collapse: collapse; margin: 0 0 14px; width: 100%; font-size: 12px; line-height: 16px; }
.md th, .md td { border: 1px solid var(--line); padding: 6px 10px; text-align: left; }
.md th { background: var(--tint); font-weight: 600; color: var(--muted); }
.md a { color: var(--link); }

/* ===== Editor form ======================================================================== */
.field { margin-bottom: 14px; }
.field label {
  display: block; margin-bottom: 6px;
  font-size: 12px; line-height: 16px; font-weight: 500; letter-spacing: -0.2px;
  color: var(--muted); text-transform: none;
}
.field input, .field textarea {
  width: 100%; appearance: none;
  height: 36px; padding: 0 12px;
  background: var(--base); color: var(--text);
  border: 1px solid var(--line); border-radius: var(--r-lg);
  font-size: 13px; line-height: 18px; letter-spacing: -0.25px; font-weight: 400;
  transition: border-color .15s var(--ease), box-shadow .15s var(--ease);
}
.field input::placeholder, .field textarea::placeholder { color: var(--faint); }
.field input.mono { font-family: var(--mono); font-size: 12px; letter-spacing: 0; }
.field textarea {
  height: auto; min-height: 320px; padding: 10px 12px; resize: vertical;
  font-family: var(--mono); font-size: 12px; line-height: 20px; letter-spacing: 0;
}
.field input:focus, .field textarea:focus {
  outline: none; border-color: var(--ring); box-shadow: var(--focus-ring);
}
.field .hint { font-size: 12px; line-height: 16px; letter-spacing: -0.2px; color: var(--faint); margin-top: 4px; }
.err {
  color: var(--on-danger); background: var(--danger-tint);
  border: 1px solid var(--line); border-radius: var(--r-lg);
  padding: 8px 12px; margin-bottom: 12px;
  font-size: 13px; line-height: 18px; letter-spacing: -0.25px;
}
.editor-bar { display: flex; gap: 6px; }

.fatal {
  margin: 20px; padding: 14px 16px;
  border: 1px solid var(--line); border-left: 3px solid var(--danger);
  border-radius: var(--r-lg); background: var(--danger-tint);
}
.fatal-title {
  font-size: 14px; line-height: 20px; font-weight: 500; letter-spacing: -0.3px;
  color: var(--on-danger); margin-bottom: 6px;
}
.fatal-body {
  margin: 0; white-space: pre-wrap; word-break: break-word;
  font-size: 12px; line-height: 18px; font-family: var(--mono); letter-spacing: 0; color: var(--text);
}

@media (max-width: 760px) {
  .sidebar { width: 100%; border-right: none; border-bottom: 1px solid var(--line); max-height: 42vh; }
  .body { flex-direction: column; }
  .pane { padding: 18px 14px 60px; }
  .topbar-row { flex-wrap: wrap; }
  .brand { width: 100%; margin-right: 0; }
  .topbar .search { flex: 1 1 auto; width: auto; min-width: 0; }
  .pane h2 { font-size: 17px; line-height: 24px; }
}
`;
document.head.appendChild(style);

// Host controls light/dark via postMessage; honor it over the media-query fallback.
window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "myoplan-theme") return;
  if (data.mode !== "light" && data.mode !== "dark") return;
  document.documentElement.dataset.mode = data.mode;
});

// --- tiny markdown renderer (borrowed from MyoPlan Memory) -------------------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function inlineMd(text) {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  out = out.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g,
    (_, t, u) => `<a href="${u}" target="_blank" rel="noreferrer noopener">${t}</a>`);
  out = out.replace(/(^|[^*])\*\*([^*]+)\*\*/g, "$1<strong>$2</strong>");
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  out = out.replace(/(https?:\/\/[^\s<)]+)/g,
    (m) => (/"|>/.test(m) ? m : `<a href="${m}" target="_blank" rel="noreferrer noopener">${m}</a>`));
  return out;
}

function renderMarkdown(src) {
  const lines = String(src || "").split("\n");
  const html = [];
  let i = 0;
  let listTag = null;

  const closeList = () => { if (listTag) { html.push(`</${listTag}>`); listTag = null; } };

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      closeList();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      html.push(`<pre><code>${escapeHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }
    if (/^\s*$/.test(line)) { closeList(); i++; continue; }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { closeList(); html.push("<hr>"); i++; continue; }

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      closeList();
      const level = Math.min(h[1].length, 3);
      html.push(`<h${level}>${inlineMd(h[2])}</h${level}>`);
      i++;
      continue;
    }

    // indented code block (4 spaces), used by the readme's path listing
    if (!listTag && /^ {4}\S/.test(line)) {
      const buf = [];
      while (i < lines.length && /^ {4}\S/.test(lines[i])) buf.push(lines[i++].slice(4));
      html.push(`<pre><code>${escapeHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }

    // table
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[-\s|:]+\|\s*$/.test(lines[i + 1])) {
      closeList();
      const cells = (row) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
      html.push(
        `<table><thead><tr>${head.map((c) => `<th>${inlineMd(c)}</th>`).join("")}</tr></thead><tbody>` +
        rows.map((r) => `<tr>${r.map((c) => `<td>${inlineMd(c)}</td>`).join("")}</tr>`).join("") +
        `</tbody></table>`);
      continue;
    }

    const bq = /^>\s?(.*)$/.exec(line);
    if (bq) {
      closeList();
      const buf = [bq[1]];
      i++;
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      html.push(`<blockquote>${inlineMd(buf.join(" "))}</blockquote>`);
      continue;
    }

    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      const want = ul ? "ul" : "ol";
      if (listTag !== want) { closeList(); html.push(`<${want}>`); listTag = want; }
      html.push(`<li>${inlineMd((ul || ol)[1])}</li>`);
      i++;
      continue;
    }

    closeList();
    const para = [line];
    i++;
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,6}\s|>|```|\s*[-*+]\s|\s*\d+[.)]\s|\s*\|)/.test(lines[i])) {
      para.push(lines[i++]);
    }
    html.push(`<p>${inlineMd(para.join(" "))}</p>`);
  }
  closeList();
  return html.join("");
}

function relTime(ms) {
  if (!ms) return "";
  const diff = Date.now() - ms;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

// Mirrors normalizePath() in server.js so the editor can preview the stored path.
function normalizePath(path) {
  return String(path == null ? "" : path)
    .split("/")
    .map((p) => p.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/g, ""))
    .filter(Boolean)
    .join("/");
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// The host's EmptyState: dashed hairline, 14px/500 title over a 13px muted line.
function emptyState(title, body) {
  const node = el("div", "empty");
  node.appendChild(el("strong", null, title));
  if (body) node.appendChild(document.createTextNode(body));
  return node;
}

// --- state ------------------------------------------------------------------

const state = {
  docs: [],            // full records, sorted by path
  tree: null,          // nested folder structure from tree()
  tagCounts: [],
  results: null,       // search() results when searching
  query: "",
  tagFilter: null,
  collapsed: new Set(), // folder paths the user has collapsed
  selected: null,      // path
  mode: "view",        // view | edit | new
  draft: null,
  error: "",
};

// --- DOM shell --------------------------------------------------------------

const app = el("div", "app");
app.innerHTML = `
  <div class="topbar">
    <div class="topbar-row">
      <div class="brand"><h1>MyoPlan Docs</h1><span class="count"></span></div>
      <input class="search" type="search" placeholder="Search…  (path, title, body)" />
      <button class="btn primary" data-act="new">New document</button>
    </div>
    <div class="tags"></div>
  </div>
  <div class="body">
    <aside class="sidebar">
      <div class="tree"></div>
    </aside>
    <main class="main"><div class="pane"></div></main>
  </div>
`;
document.body.appendChild(app);

const $count = app.querySelector(".brand .count");
const $search = app.querySelector(".search");
const $tags = app.querySelector(".tags");
const $tree = app.querySelector(".tree");
const $pane = app.querySelector(".pane");

function toast(message) {
  const node = el("div", "toast", message);
  document.body.appendChild(node);
  setTimeout(() => node.remove(), 2200);
}

function select(path) {
  state.selected = path;
  state.mode = "view";
  state.error = "";
  render();
}

// --- sidebar ----------------------------------------------------------------

function renderTags() {
  $tags.textContent = "";
  // The host's FilterChip: 28px, rounded-lg, fill when active, tabular count. Never a capsule.
  const mk = (label, value, count) => {
    const b = el("button", "chip" + (state.tagFilter === value ? " on" : ""));
    b.appendChild(el("span", null, label));
    if (count != null) b.appendChild(el("span", "count", String(count)));
    b.onclick = () => { state.tagFilter = value; render(); };
    $tags.appendChild(b);
  };
  mk("All", null, state.docs.length);
  if (state.tagCounts.length > 0) $tags.appendChild(el("span", "chip-sep"));
  for (const { tag, count } of state.tagCounts.slice(0, 12)) mk(tag, tag, count);
}

function docVisible(doc) {
  return !state.tagFilter || doc.tags.includes(state.tagFilter);
}

function renderTree() {
  $tree.textContent = "";

  if (state.results) {
    if (state.results.length === 0) {
      $tree.appendChild(emptyState("No matches", "Nothing in the library matches that search."));
      return;
    }
    for (const hit of state.results) {
      if (state.tagFilter && !(hit.tags || []).includes(state.tagFilter)) continue;
      const row = el("div", "result" + (state.selected === hit.path ? " on" : ""));
      row.appendChild(el("div", "t", hit.title || hit.path));
      row.appendChild(el("div", "p", hit.path));
      if (hit.excerpt) row.appendChild(el("div", "e", hit.excerpt));
      row.onclick = () => select(hit.path);
      $tree.appendChild(row);
    }
    if (!$tree.firstChild) {
      $tree.appendChild(emptyState("No matches", "Nothing in the library matches that search."));
    }
    return;
  }

  const node = state.tree;
  if (!node || node.count === 0) {
    $tree.appendChild(emptyState("No documents yet", "Create one to start the library."));
    return;
  }

  const walk = (folder, depth) => {
    for (const child of folder.folders) {
      const collapsed = state.collapsed.has(child.path);
      const row = el("button", "row folder");
      row.style.paddingLeft = `${10 + depth * 13}px`;
      row.appendChild(el("span", "tw", collapsed ? "▸" : "▾"));
      row.appendChild(el("span", "label", child.name));
      row.appendChild(el("span", "n", String(child.count)));
      row.onclick = () => {
        if (collapsed) state.collapsed.delete(child.path);
        else state.collapsed.add(child.path);
        renderTree();
      };
      $tree.appendChild(row);
      if (!collapsed) walk(child, depth + 1);
    }
    for (const doc of folder.documents) {
      if (!docVisible(doc)) continue;
      const row = el("button", "row doc" + (state.selected === doc.path ? " on" : ""));
      row.style.paddingLeft = `${10 + depth * 13}px`;
      row.appendChild(el("span", "tw", "·"));
      row.appendChild(el("span", "label", doc.title || doc.path.split("/").pop()));
      row.onclick = () => select(doc.path);
      $tree.appendChild(row);
    }
  };

  walk(node, 0);
  if (!$tree.firstChild) $tree.appendChild(emptyState("No documents", "Nothing is tagged that way yet."));
}

// --- detail -----------------------------------------------------------------

function renderCrumbs(path) {
  const crumbs = el("div", "crumbs");
  const segments = path.split("/");
  segments.forEach((seg, idx) => {
    if (idx > 0) crumbs.appendChild(el("span", "sep", "/"));
    const last = idx === segments.length - 1;
    const b = el("button", "seg" + (last ? " last" : ""), seg);
    if (!last) {
      const prefix = segments.slice(0, idx + 1).join("/");
      b.title = `Show only ${prefix}`;
      b.onclick = () => {
        // Expand the folder chain so the target is visible in the tree.
        for (let i = 0; i < segments.length; i++) {
          state.collapsed.delete(segments.slice(0, i + 1).join("/"));
        }
        renderTree();
      };
    }
    crumbs.appendChild(b);
  });
  return crumbs;
}

function renderDetail() {
  $pane.textContent = "";
  const doc = state.docs.find((d) => d.path === state.selected);
  if (!doc) {
    $pane.appendChild(emptyState("No document selected", "Pick one from the tree, or create a new one."));
    return;
  }

  $pane.appendChild(renderCrumbs(doc.path));

  const head = el("div", "detail-head");
  head.appendChild(el("h2", null, doc.title || doc.path));
  $pane.appendChild(head);

  $pane.appendChild(
    el("p", "meta", `updated ${relTime(doc.updatedAt)} · created ${new Date(doc.createdAt).toLocaleDateString()}`),
  );

  if (doc.tags.length > 0) {
    const list = el("div", "taglist");
    for (const tag of doc.tags) {
      // Same chip recipe as the filter rail, so a tag reads identically everywhere.
      const b = el("button", "chip" + (state.tagFilter === tag ? " on" : ""), tag);
      b.onclick = () => { state.tagFilter = state.tagFilter === tag ? null : tag; render(); };
      list.appendChild(b);
    }
    $pane.appendChild(list);
  }

  const actions = el("div", "actions");
  const edit = el("button", "btn", "Edit");
  edit.onclick = () => {
    state.mode = "edit";
    state.error = "";
    state.draft = { ...doc, originalPath: doc.path };
    render();
  };
  const del = el("button", "btn danger", "Delete");
  del.onclick = async () => {
    if (del.dataset.armed !== "1") {
      del.dataset.armed = "1";
      del.textContent = "Delete — click again";
      setTimeout(() => { del.dataset.armed = ""; del.textContent = "Delete"; }, 3500);
      return;
    }
    await gadget.delete(doc.path);
    state.selected = null;
    toast(`Deleted ${doc.path}`);
    await refresh();
  };
  actions.append(edit, del);
  $pane.appendChild(actions);

  const md = el("div", "md");
  md.innerHTML = renderMarkdown(doc.body);
  $pane.appendChild(md);
}

// --- editor -----------------------------------------------------------------

function renderEditor() {
  $pane.textContent = "";
  const draft = state.draft;
  const isNew = state.mode === "new";

  $pane.appendChild(el("h2", "editor-title", isNew ? "New document" : `Edit ${draft.originalPath}`));

  if (state.error) $pane.appendChild(el("div", "err", state.error));

  const field = (label, hint, control) => {
    const wrap = el("div", "field");
    wrap.append(el("label", null, label), control);
    const hintNode = el("div", "hint", hint || "");
    wrap.appendChild(hintNode);
    $pane.appendChild(wrap);
    return hintNode;
  };

  const titleInput = el("input");
  titleInput.value = draft.title || "";
  titleInput.placeholder = "Human title";
  field("Title", "Free text. Defaults to the humanized last path segment.", titleInput);

  const pathInput = el("input", "mono");
  pathInput.value = draft.path || "";
  pathInput.placeholder = "company/decisions/2026-08-24-something";
  const pathHint = field("Path", "", pathInput);
  const showPath = () => {
    const normalized = normalizePath(pathInput.value);
    pathHint.textContent = normalized
      ? `Stored as: ${normalized}`
      : "Slash-separated kebab segments. Folders are implicit.";
  };
  pathInput.oninput = showPath;
  showPath();

  const tagsInput = el("input");
  tagsInput.value = (draft.tags || []).join(", ");
  tagsInput.placeholder = "decision, migration";
  field("Tags", "Comma-separated. Normalized to kebab-case.", tagsInput);

  const bodyInput = el("textarea");
  bodyInput.value = draft.body || "";
  bodyInput.placeholder = "# Markdown body";
  field("Body", "Markdown. Rendered in the document view.", bodyInput);

  const bar = el("div", "editor-bar");

  const save = el("button", "btn primary", isNew ? "Create" : "Save");
  save.onclick = async () => {
    save.disabled = true;
    try {
      const nextPath = pathInput.value;
      const tags = tagsInput.value.split(",").map((s) => s.trim()).filter(Boolean);
      // A path change on an existing document is a move, not a second document.
      if (!isNew && normalizePath(nextPath) !== draft.originalPath) {
        await gadget.move(draft.originalPath, nextPath);
      }
      const { document: saved } = await gadget.write({
        path: nextPath,
        title: titleInput.value,
        body: bodyInput.value,
        tags,
      });
      state.error = "";
      state.selected = saved.path;
      state.mode = "view";
      toast(isNew ? `Created ${saved.path}` : `Saved ${saved.path}`);
      await refresh();
    } catch (err) {
      state.error = err && err.message ? err.message : String(err);
      save.disabled = false;
      render();
    }
  };

  const cancel = el("button", "btn ghost", "Cancel");
  cancel.onclick = () => { state.error = ""; state.mode = "view"; render(); };

  bar.append(save, cancel);
  $pane.appendChild(bar);
}

// --- render -----------------------------------------------------------------

function render() {
  const n = state.docs.length;
  $count.textContent = `${n} ${n === 1 ? "document" : "documents"}`;
  renderTags();
  renderTree();
  if (state.mode === "view") renderDetail();
  else renderEditor();
}

app.querySelector('[data-act="new"]').onclick = () => {
  const base = state.selected ? state.selected.split("/").slice(0, -1).join("/") : "";
  state.mode = "new";
  state.error = "";
  state.draft = { path: base ? `${base}/` : "", title: "", body: "", tags: [] };
  render();
};

let searchTimer = null;
$search.oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    try {
      state.query = $search.value.trim();
      state.results = state.query ? await gadget.search({ query: state.query, limit: 50 }) : null;
      render();
    } catch (err) {
      console.error("search failed", err);
    }
  }, 160);
};

// --- data + live updates ----------------------------------------------------

let refreshing = false;

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const [docs, tree, tagCounts] = await Promise.all([
      gadget.listFull(),
      gadget.tree(),
      gadget.tags(),
    ]);
    state.docs = docs;
    state.tree = tree;
    state.tagCounts = tagCounts;
    if (state.query) state.results = await gadget.search({ query: state.query, limit: 50 });
  } finally {
    refreshing = false;
  }
  render();
}

// Live updates: the server calls update() whenever anything mutates, including
// mutations an agent makes through its own stub.
class Watcher extends RpcTarget {
  update() {
    refresh().catch((err) => console.error("refresh failed", err));
  }
  [Symbol.dispose]() {
    // The connection dropped; re-subscribe on the replacement stub.
    try { gadget.subscribe(new Watcher()); } catch { /* retried on next reconnect */ }
  }
}

function showFatal(err) {
  const message = err && err.stack ? err.stack : String(err);
  const panel = el("div", "fatal");
  panel.appendChild(el("div", "fatal-title", "MyoPlan Docs failed to start"));
  panel.appendChild(el("pre", "fatal-body", message));
  // Replace whatever half-built UI exists; a partial render is more confusing than none.
  document.body.replaceChildren(panel);
  console.error("MyoPlan Docs init failed:", message);
}

try {
  await refresh();
  if (!state.selected && state.docs.length > 0) {
    state.selected = state.docs[0].path;
    render();
  }
  await gadget.subscribe(new Watcher());
} catch (err) {
  showFatal(err);
}
