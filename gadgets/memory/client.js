// MyoPlan Memory — browsable index over the gadget's memory store.
// Everything here is a thin reader/editor over the same RPC surface agents use.

const TYPE_LABELS = {
  user: "User",
  feedback: "Feedback",
  project: "Project",
  reference: "Reference",
  decision: "Decision",
};
const TYPE_ORDER = ["decision", "project", "reference", "user", "feedback"];
const TYPE_COLOR = {
  decision: "var(--t-decision)",
  project: "var(--t-project)",
  reference: "var(--t-reference)",
  user: "var(--t-user)",
  feedback: "var(--t-feedback)",
};
const typeColor = (t) => TYPE_COLOR[t] || "var(--faint)";

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

/* Memory type accents — the host's category palette, not gadget-invented hues. */
:root {
  --t-decision:  var(--cat-amber);
  --t-project:   var(--cat-teal);
  --t-reference: var(--cat-violet);
  --t-user:      var(--cat-green);
  --t-feedback:  var(--danger);
}

/* ===== Memory shell ======================================================================= */
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

.filters {
  display: flex; align-items: center; gap: 2px;
  margin: 0 -4px; padding: 8px 4px 6px;
  overflow-x: auto; scrollbar-width: none;
}
.filters::-webkit-scrollbar { display: none; }

.body { flex: 1 1 auto; display: flex; min-height: 0; }

.sidebar {
  width: 320px; flex: 0 0 auto; border-right: 1px solid var(--line);
  background: var(--elevated); display: flex; flex-direction: column; min-height: 0;
}
.list { flex: 1 1 auto; overflow-y: auto; padding: 6px 10px 24px; }

/* ===== Index rows — flat, hairline-separated, fill on selection. =========================== */
.item {
  display: flex; gap: 10px; align-items: flex-start;
  padding: 8px 10px; border-radius: var(--r-lg);
  border: 1px solid transparent; cursor: pointer;
  transition: background-color .15s var(--ease);
}
.item + .item { box-shadow: inset 0 1px 0 var(--line); }
.item:hover { background: var(--tint); box-shadow: none; }
.item:hover + .item { box-shadow: none; }
.item.on { background: var(--fill); box-shadow: none; }
.item.on + .item { box-shadow: none; }
.item .dot { flex: 0 0 auto; width: 6px; height: 6px; border-radius: 50%; margin-top: 6px; background: var(--faint); }
.item .txt { flex: 1 1 auto; min-width: 0; }
.item .n {
  font-size: 13px; line-height: 18px; font-weight: 500; letter-spacing: -0.25px;
  color: var(--text); word-break: break-word;
}
.item.on .n { color: var(--strong); }
.item .d {
  font-size: 12px; line-height: 16px; letter-spacing: -0.2px; color: var(--muted); margin-top: 2px;
  display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden;
}
.item .score {
  font-size: 11px; line-height: 16px; letter-spacing: -0.1px; color: var(--faint); margin-top: 3px;
  font-variant-numeric: tabular-nums;
}

.main { flex: 1 1 auto; overflow-y: auto; min-width: 0; background: var(--base); }
.pane { max-width: 720px; margin: 0 auto; padding: 24px 28px 80px; }

.list .empty { margin: 10px 2px; }
.pane > .empty { margin-top: 28px; }

/* ===== Detail ============================================================================= */
.detail-eyebrow {
  display: flex; align-items: center; gap: 8px; margin-bottom: 8px;
  font-size: 11px; line-height: 16px; font-weight: 600;
  letter-spacing: 0.9px; text-transform: uppercase;
}
.detail-eyebrow .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }

/* The host's largest in-pane heading is 20px; the gadget stays inside that ceiling. */
.pane h2 {
  margin: 0; font-size: 20px; line-height: 28px; font-weight: 600;
  letter-spacing: -0.35px; color: var(--text); word-break: break-word;
}
.meta {
  color: var(--faint); font-size: 12px; line-height: 16px; letter-spacing: -0.2px; margin: 8px 0 0;
}
.desc {
  color: var(--muted); font-size: 13px; line-height: 18px; letter-spacing: -0.25px;
  margin: 12px 0 0; font-weight: 400;
}
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

/* [[wiki-links]] — the host reserves the teal for interactive intent, so links carry it. */
.wl { color: var(--link); cursor: pointer; border-bottom: 1px solid color-mix(in srgb, var(--link) 40%, transparent); }
.wl:hover { background: var(--info-tint); }
.wl.missing { color: var(--faint); border-bottom-style: dashed; border-bottom-color: var(--line-strong); }

/* ===== Related links ====================================================================== */
.rel { margin-top: 26px; padding-top: 18px; border-top: 1px solid var(--line); }
.rel h3 {
  display: flex; align-items: center; gap: 12px; margin: 0 0 10px;
  font-size: 11px; line-height: 16px; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.9px; color: var(--muted);
}
.rel h3 .rule { flex: 1 1 auto; height: 1px; background: var(--line); }
.rel + .rel { margin-top: 18px; padding-top: 0; border-top: none; }
.rel .links { display: flex; flex-wrap: wrap; gap: 6px; }
.rel .link {
  display: inline-flex; align-items: center; height: 28px; padding: 0 10px;
  border: 1px solid var(--line); border-radius: var(--r-lg);
  background: var(--base); color: var(--text);
  font-size: 13px; line-height: 18px; font-weight: 500; letter-spacing: -0.25px; cursor: pointer;
  transition: background-color .15s var(--ease), border-color .15s var(--ease), color .15s var(--ease);
}
.rel .link:hover { background: var(--elevated); }
.rel .link.missing { color: var(--faint); border-style: dashed; cursor: default; background: transparent; font-weight: 400; }
.rel .link.missing:hover { background: transparent; }

/* ===== Editor form ======================================================================== */
.field { margin-bottom: 14px; }
.field label {
  display: block; margin-bottom: 6px;
  font-size: 12px; line-height: 16px; font-weight: 500; letter-spacing: -0.2px;
  color: var(--muted); text-transform: none;
}
.field input, .field select, .field textarea {
  width: 100%; appearance: none;
  height: 36px; padding: 0 12px;
  background: var(--base); color: var(--text);
  border: 1px solid var(--line); border-radius: var(--r-lg);
  font-size: 13px; line-height: 18px; letter-spacing: -0.25px; font-weight: 400;
  transition: border-color .15s var(--ease), box-shadow .15s var(--ease);
}
.field input::placeholder, .field textarea::placeholder { color: var(--faint); }
.field textarea {
  height: auto; min-height: 320px; padding: 10px 12px; resize: vertical;
  font-family: var(--mono); font-size: 12px; line-height: 20px; letter-spacing: 0;
}
.field select {
  padding-right: 28px;
  background-image: linear-gradient(45deg, transparent 50%, currentColor 50%),
                    linear-gradient(135deg, currentColor 50%, transparent 50%);
  background-position: calc(100% - 15px) 15px, calc(100% - 11px) 15px;
  background-size: 4px 4px, 4px 4px; background-repeat: no-repeat;
}
.field input:focus, .field select:focus, .field textarea:focus {
  outline: none; border-color: var(--ring); box-shadow: var(--focus-ring);
}
.field input:disabled { background: var(--tint); color: var(--muted); }
.field .hint { font-size: 12px; line-height: 16px; letter-spacing: -0.2px; color: var(--faint); margin-top: 4px; }
.err {
  color: var(--on-danger); background: var(--danger-tint);
  border: 1px solid var(--line); border-radius: var(--r-lg);
  padding: 8px 12px; margin-bottom: 12px;
  font-size: 13px; line-height: 18px; letter-spacing: -0.25px;
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

// --- tiny markdown renderer -------------------------------------------------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function inlineMd(text) {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  out = out.replace(/\[\[([^\]]+)\]\]/g, (_, n) => {
    const slug = slugFor(n);
    return `<span class="wl" data-link="${escapeHtml(slug)}">${escapeHtml(n)}</span>`;
  });
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

function slugFor(name) {
  return String(name || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
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

// --- state ------------------------------------------------------------------

const state = {
  memories: [],       // full records
  results: null,      // recall() summaries when searching
  query: "",
  typeFilter: null,
  selected: null,     // name
  mode: "view",       // view | edit | new
  draft: null,
  error: "",
};

// --- DOM shell --------------------------------------------------------------

const app = document.createElement("div");
app.className = "app";
app.innerHTML = `
  <div class="topbar">
    <div class="topbar-row">
      <div class="brand"><h1>MyoPlan Memory</h1><span class="count"></span></div>
      <input class="search" type="search" placeholder="Recall…  (name, description, body)" />
      <button class="btn primary" data-act="new">New memory</button>
    </div>
    <div class="filters"></div>
  </div>
  <div class="body">
    <aside class="sidebar">
      <div class="list"></div>
    </aside>
    <main class="main"><div class="pane"></div></main>
  </div>
`;
document.body.appendChild(app);

const $count = app.querySelector(".count");
const $search = app.querySelector(".search");
const $filters = app.querySelector(".filters");
const $list = app.querySelector(".list");
const $pane = app.querySelector(".pane");

function toast(message) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

// --- rendering --------------------------------------------------------------

function emptyState(title, detail) {
  const box = document.createElement("div");
  box.className = "empty";
  const t = document.createElement("strong");
  t.textContent = title;
  box.appendChild(t);
  if (detail) box.appendChild(document.createTextNode(detail));
  return box;
}

function renderFilters() {
  $filters.textContent = "";
  const mk = (label, value, count, vacant) => {
    const b = document.createElement("button");
    b.className = "chip" + (state.typeFilter === value ? " on" : "") + (vacant ? " vacant" : "");
    b.textContent = label;
    if (count !== null) {
      const c = document.createElement("span");
      c.className = "count";
      c.textContent = String(count);
      b.appendChild(c);
    }
    b.onclick = () => { state.typeFilter = value; render(); };
    $filters.appendChild(b);
  };
  mk("All", null, state.memories.length, false);

  const sep = document.createElement("div");
  sep.className = "chip-sep";
  $filters.appendChild(sep);

  for (const t of TYPE_ORDER) {
    const n = state.memories.filter((m) => m.type === t).length;
    mk(TYPE_LABELS[t], t, n, n === 0);
  }
}

function visibleEntries() {
  if (state.results) {
    let r = state.results;
    if (state.typeFilter) r = r.filter((m) => m.type === state.typeFilter);
    return r;
  }
  let r = state.memories;
  if (state.typeFilter) r = r.filter((m) => m.type === state.typeFilter);
  return r;
}

function renderList() {
  $list.textContent = "";
  const entries = visibleEntries();
  if (entries.length === 0) {
    $list.appendChild(emptyState(
      state.query ? "Nothing recalled" : state.typeFilter ? "Nothing here yet" : "No memories yet",
      state.query
        ? `No memory matches “${state.query}”.`
        : state.typeFilter
          ? `No ${(TYPE_LABELS[state.typeFilter] || "").toLowerCase()} memories have been written.`
          : "Write the first one with New memory."));
    return;
  }

  const addItem = (m) => {
    const el = document.createElement("div");
    el.className = "item" + (state.selected === m.name ? " on" : "");
    el.innerHTML =
      `<div class="dot"></div><div class="txt"><div class="n"></div><div class="d"></div>` +
      (m.score ? `<div class="score">match ${m.score}</div>` : "") + `</div>`;
    el.querySelector(".dot").style.background = typeColor(m.type);
    el.querySelector(".dot").title = TYPE_LABELS[m.type] || m.type || "";
    el.querySelector(".n").textContent = m.name;
    const d = el.querySelector(".d");
    d.textContent = m.excerpt || m.description || "";
    if (!d.textContent) d.remove();
    el.onclick = () => { state.selected = m.name; state.mode = "view"; render(); };
    $list.appendChild(el);
  };

  if (state.results || state.typeFilter) {
    entries.forEach(addItem);
    return;
  }
  for (const t of TYPE_ORDER) {
    const group = entries.filter((m) => m.type === t);
    if (group.length === 0) continue;
    const label = document.createElement("div");
    label.className = "group-label";
    const name = document.createElement("span");
    name.textContent = TYPE_LABELS[t];
    const rule = document.createElement("span");
    rule.className = "rule";
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = String(group.length);
    label.append(name, rule, n);
    $list.appendChild(label);
    group.forEach(addItem);
  }
}

function renderDetail() {
  $pane.textContent = "";
  const memory = state.memories.find((m) => m.name === state.selected);
  if (!memory) {
    $pane.appendChild(emptyState(
      "Nothing selected",
      "Pick a memory from the index on the left, or write a new one."));
    return;
  }

  const eyebrow = document.createElement("div");
  eyebrow.className = "detail-eyebrow";
  eyebrow.style.color = typeColor(memory.type);
  const edot = document.createElement("span");
  edot.className = "dot";
  const elabel = document.createElement("span");
  elabel.textContent = TYPE_LABELS[memory.type] || memory.type || "";
  eyebrow.append(edot, elabel);
  $pane.appendChild(eyebrow);

  const head = document.createElement("div");
  head.className = "detail-head";
  const h2 = document.createElement("h2");
  h2.textContent = memory.name;
  head.append(h2);
  $pane.appendChild(head);

  const meta = document.createElement("p");
  meta.className = "meta";
  meta.textContent = `updated ${relTime(memory.updatedAt)} · created ${new Date(memory.createdAt).toLocaleDateString()}`;
  $pane.appendChild(meta);

  if (memory.description) {
    const d = document.createElement("p");
    d.className = "desc";
    d.textContent = memory.description;
    $pane.appendChild(d);
  }

  const actions = document.createElement("div");
  actions.className = "actions";
  const edit = document.createElement("button");
  edit.className = "btn quiet";
  edit.textContent = "Edit";
  edit.onclick = () => { state.mode = "edit"; state.draft = { ...memory }; render(); };
  const del = document.createElement("button");
  del.className = "btn danger";
  del.textContent = "Forget";
  del.onclick = async () => {
    if (del.dataset.armed !== "1") {
      del.dataset.armed = "1";
      del.textContent = "Forget — click again";
      setTimeout(() => { del.dataset.armed = ""; del.textContent = "Forget"; }, 3500);
      return;
    }
    await gadget.forget(memory.name);
    state.selected = null;
    toast(`Forgot ${memory.name}`);
    await refresh();
  };
  actions.append(edit, del);
  $pane.appendChild(actions);

  const md = document.createElement("div");
  md.className = "md";
  md.innerHTML = renderMarkdown(memory.body);
  const known = new Set(state.memories.map((m) => m.name));
  md.querySelectorAll(".wl").forEach((el) => {
    const target = el.dataset.link;
    if (!known.has(target)) { el.classList.add("missing"); el.title = "No memory by this name yet"; return; }
    el.onclick = () => { state.selected = target; state.mode = "view"; render(); };
  });
  $pane.appendChild(md);

  renderRelated(memory);
}

async function renderRelated(memory) {
  let rel;
  try {
    rel = await gadget.related(memory.name);
  } catch {
    return;
  }
  if (state.selected !== memory.name || state.mode !== "view") return;

  const section = (title, items, missing) => {
    if (!items || items.length === 0) return;
    const box = document.createElement("div");
    box.className = "rel";
    const h3 = document.createElement("h3");
    const h3name = document.createElement("span");
    h3name.textContent = title;
    const h3rule = document.createElement("span");
    h3rule.className = "rule";
    h3.append(h3name, h3rule);
    const links = document.createElement("div");
    links.className = "links";
    for (const item of items) {
      const b = document.createElement("button");
      b.className = "link" + (missing ? " missing" : "");
      b.textContent = missing ? item : item.name;
      if (!missing) b.onclick = () => { state.selected = item.name; state.mode = "view"; render(); };
      links.appendChild(b);
    }
    box.append(h3, links);
    $pane.appendChild(box);
  };

  section("Links out", rel.outgoing, false);
  section("Linked from", rel.incoming, false);
  section("Missing targets", rel.missing, true);
}

function renderEditor() {
  $pane.textContent = "";
  const draft = state.draft;
  const isNew = state.mode === "new";

  const h2 = document.createElement("h2");
  h2.style.margin = "0 0 20px";
  h2.textContent = isNew ? "New memory" : `Edit ${draft.name}`;
  $pane.appendChild(h2);

  if (state.error) {
    const e = document.createElement("div");
    e.className = "err";
    e.textContent = state.error;
    $pane.appendChild(e);
  }

  const field = (label, hint, control) => {
    const wrap = document.createElement("div");
    wrap.className = "field";
    const l = document.createElement("label");
    l.textContent = label;
    wrap.append(l, control);
    if (hint) {
      const hs = document.createElement("div");
      hs.className = "hint";
      hs.textContent = hint;
      wrap.appendChild(hs);
    }
    $pane.appendChild(wrap);
    return control;
  };

  const nameInput = document.createElement("input");
  nameInput.value = draft.name || "";
  nameInput.placeholder = "kebab-slug-name";
  nameInput.disabled = !isNew;
  field("Name", isNew ? "Unique kebab-case slug. Writing an existing name updates it." : "Names are stable; create a new memory to rename.", nameInput);

  const typeSelect = document.createElement("select");
  for (const t of TYPE_ORDER) {
    const o = document.createElement("option");
    o.value = t;
    o.textContent = TYPE_LABELS[t];
    typeSelect.appendChild(o);
  }
  typeSelect.value = draft.type || "reference";
  field("Type", null, typeSelect);

  const descInput = document.createElement("input");
  descInput.value = draft.description || "";
  descInput.placeholder = "One line — what this memory is, so recall can rank it";
  field("Description", "Used for recall relevance. Keep it to one sentence.", descInput);

  const linksInput = document.createElement("input");
  linksInput.value = (draft.links || []).join(", ");
  linksInput.placeholder = "other-memory, another-memory";
  field("Links", "Comma-separated names. [[wiki links]] in the body are added automatically.", linksInput);

  const bodyInput = document.createElement("textarea");
  bodyInput.value = draft.body || "";
  bodyInput.placeholder = "# Markdown body — use [[other-memory]] to link.";
  field("Body", "Markdown. Rendered in the detail view.", bodyInput);

  const bar = document.createElement("div");
  bar.style.display = "flex";
  bar.style.gap = "8px";
  const save = document.createElement("button");
  save.className = "btn primary";
  save.textContent = isNew ? "Remember" : "Save";
  save.onclick = async () => {
    const payload = {
      name: nameInput.value,
      type: typeSelect.value,
      description: descInput.value,
      body: bodyInput.value,
      links: linksInput.value.split(",").map((s) => s.trim()).filter(Boolean),
    };
    save.disabled = true;
    try {
      const { memory } = await gadget.remember(payload);
      state.error = "";
      state.selected = memory.name;
      state.mode = "view";
      toast(`Remembered ${memory.name}`);
      await refresh();
    } catch (err) {
      state.error = err && err.message ? err.message : String(err);
      save.disabled = false;
      render();
    }
  };
  const cancel = document.createElement("button");
  cancel.className = "btn ghost";
  cancel.textContent = "Cancel";
  cancel.onclick = () => { state.error = ""; state.mode = "view"; render(); };
  bar.append(save, cancel);
  $pane.appendChild(bar);
}

function render() {
  $count.textContent = `${state.memories.length} ${state.memories.length === 1 ? "memory" : "memories"}`;
  renderFilters();
  renderList();
  if (state.mode === "view") renderDetail();
  else renderEditor();
}

app.querySelector('[data-act="new"]').onclick = () => {
  state.mode = "new";
  state.error = "";
  state.draft = { name: "", type: "reference", description: "", body: "", links: [] };
  render();
};

let searchTimer = null;
$search.oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    state.query = $search.value.trim();
    state.results = state.query ? await gadget.recall({ query: state.query, limit: 50 }) : null;
    render();
  }, 160);
};

// --- data + live updates ----------------------------------------------------

async function refresh() {
  state.memories = await gadget.listFull();
  if (state.query) state.results = await gadget.recall({ query: state.query, limit: 50 });
  render();
}

class Updates extends RpcTarget {
  update() {
    refresh();
  }
  [Symbol.dispose]() {
    // Connection lost — resubscribe over the fresh one.
    try { gadget.subscribe(new Updates()); } catch { /* will retry on next reconnect */ }
  }
}

// Init is the one place a failure paints nothing at all — an unhandled rejection
// here leaves a blank iframe with no signal. Surface it instead.
function paintInitFailure(err) {
  const panel = document.createElement("div");
  panel.setAttribute("role", "alert");
  panel.style.cssText = [
    "margin:16px",
    "padding:16px 18px",
    "border:1px solid var(--danger, #a8475a)",
    "border-radius:10px",
    "background:var(--surface, #fff)",
    "color:var(--text, #17242a)",
    "font-family:ui-sans-serif, system-ui, -apple-system, sans-serif",
    "font-size:13px",
    "line-height:1.6",
  ].join(";");

  const title = document.createElement("strong");
  title.style.cssText = "display:block;margin-bottom:6px;color:var(--danger, #a8475a);font-size:13.5px";
  title.textContent = "MyoPlan Memory failed to start";

  const message = document.createElement("div");
  message.style.cssText = "margin-bottom:10px";
  message.textContent = (err && err.message) ? err.message : String(err);

  const detail = document.createElement("pre");
  detail.style.cssText = [
    "margin:0",
    "padding:10px 12px",
    "border-radius:8px",
    "background:var(--surface-2, #eaeef0)",
    "color:var(--muted, #5b6f78)",
    "font-family:ui-monospace, SFMono-Regular, Menlo, monospace",
    "font-size:11.5px",
    "line-height:1.5",
    "white-space:pre-wrap",
    "overflow-x:auto",
  ].join(";");
  detail.textContent = (err && err.stack) ? err.stack : "(no stack available)";

  panel.append(title, message, detail);
  document.body.appendChild(panel);
}

try {
  await refresh();
  if (state.memories.length > 0) {
    state.selected = state.memories[0].name;
    render();
  }
  gadget.subscribe(new Updates());
} catch (err) {
  console.error("MyoPlan Memory init failed", err);
  paintInitFailure(err);
}
