// MyoPlan Tasks -- client half. Builds the whole UI in JS (there is no index.html).
// The `gadget` global is an RPC stub to the server-side Durable Object in server.js.

// -----------------------------------------------------------------------------------------------
// Theme. The sandboxed iframe inherits nothing from the host page, so the gadget owns its palette.
// Clinical-calm: slate ground, teal accent, muted rose for destructive, hairline borders.
// -----------------------------------------------------------------------------------------------

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

/* ===== Tasks shell ======================================================================== */
.app { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }

.header {
  flex: 0 0 auto; padding: 12px 16px 8px;
  background: var(--base); border-bottom: 1px solid var(--line);
}
.header-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.brand {
  display: flex; align-items: baseline; gap: 8px; min-width: 0; margin-right: auto;
  font-size: 15px; line-height: 20px; font-weight: 500; letter-spacing: -0.3px; color: var(--text);
}
.brand span {
  color: var(--faint); font-size: 12px; line-height: 16px; font-weight: 400;
  letter-spacing: -0.2px; white-space: nowrap; font-variant-numeric: tabular-nums;
}
.header .search { flex: 1 1 200px; min-width: 140px; max-width: 280px; width: auto; }

.chips {
  display: flex; align-items: center; gap: 2px;
  margin: 8px -4px 0; padding: 0 4px 6px;
  overflow-x: auto; scrollbar-width: none;
}
.chips::-webkit-scrollbar { display: none; }

/* Two panes at desktop widths; below 861px the detail pane overlays the list (always dismissable
   via Close or Escape) instead of squeezing it. */
.body { flex: 1 1 auto; display: flex; min-height: 0; position: relative; }
.list-pane { flex: 1 1 55%; overflow-y: auto; padding: 8px 12px 40px; min-width: 0; }
.detail-pane {
  flex: 0 0 clamp(320px, 45%, 460px);
  border-left: 1px solid var(--line); background: var(--elevated);
  overflow-y: auto; padding: 16px 18px 48px; min-width: 0;
}
@media (max-width: 860px) {
  .detail-pane { position: absolute; inset: 0; flex: 1 1 auto; border-left: none; z-index: 5; }
  .detail-pane.vacant { display: none; }
}
.detail-pane.hidden { display: none; }

/* ===== Task rows — flat and hairline-separated, the way the host's list rows read. ========= */
.task {
  display: flex; align-items: flex-start; gap: 10px;
  padding: 8px 10px; border-radius: var(--r-lg);
  border: 1px solid transparent; cursor: pointer;
  transition: background-color .15s var(--ease);
}
.task + .task { box-shadow: inset 0 1px 0 var(--line); }
.task:hover { background: var(--tint); box-shadow: none; }
.task:hover + .task { box-shadow: none; }
.task.selected { background: var(--fill); box-shadow: none; }
.task.selected + .task { box-shadow: none; }
.task.selected .task-title { color: var(--strong); }
.task.is-done .task-title { color: var(--faint); text-decoration: line-through; }

/* 26px hit target; the visible ring stays 16px so the row's rhythm is unchanged. */
.tick {
  flex: 0 0 auto; width: 26px; height: 26px; margin: -3px -5px -3px -6px;
  border: none; background: transparent; cursor: pointer; padding: 0;
  display: flex; align-items: center; justify-content: center;
}
.tick .ring {
  width: 16px; height: 16px; border-radius: 50%;
  border: 1.5px solid var(--fill-hover);
  display: flex; align-items: center; justify-content: center;
  transition: border-color .15s var(--ease), background-color .15s var(--ease);
}
.tick:hover .ring { border-color: var(--contrast); }
.tick.checked .ring { background: var(--contrast); border-color: var(--contrast); }
.tick.checked .ring::after {
  content: ""; width: 4px; height: 7.5px; border: solid var(--inverse);
  border-width: 0 1.6px 1.6px 0; transform: rotate(45deg) translate(-0.5px, -1px);
}

.task-main { flex: 1 1 auto; min-width: 0; }
.task-title {
  font-size: 13px; line-height: 18px; font-weight: 500; letter-spacing: -0.25px;
  color: var(--text); word-break: break-word;
}
.task-meta {
  display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-top: 4px;
  font-size: 12px; line-height: 16px; letter-spacing: -0.2px; color: var(--muted);
}
.dot-sep { width: 2.5px; height: 2.5px; border-radius: 50%; background: var(--faint); }

/* Status pills use the host's kumo status tint pairs, not gadget-invented colours. */
.pill {
  display: inline-flex; align-items: center; height: 16px; padding: 0 6px;
  border-radius: var(--r-sm); border: none;
  font-size: 10px; line-height: 16px; font-weight: 600; letter-spacing: 0.02em;
  text-transform: uppercase;
}
.pill.status-blocked     { background: var(--danger-tint);  color: var(--on-danger); }
.pill.status-in_progress { background: var(--info-tint);    color: var(--on-info); }
.pill.status-todo        { background: var(--fill);         color: var(--muted); }
.pill.status-done        { background: var(--success-tint); color: var(--on-success); }

.prio { font-weight: 500; }
.prio.urgent { color: var(--on-danger); }
.prio.high   { color: var(--on-warning); }
.prio.medium { color: var(--muted); }
.prio.low    { color: var(--faint); }
.due.overdue { color: var(--on-danger); font-weight: 500; }

.list-pane > .empty { margin: 10px 2px; }
.detail-pane > .empty { margin-top: 24px; }

/* ===== Detail ============================================================================= */
.detail-head { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 2px; }
.detail-head .spacer { flex: 1 1 auto; }
.detail-eyebrow {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; padding-top: 7px;
  font-size: 11px; line-height: 16px; font-weight: 600;
  letter-spacing: 0.9px; text-transform: uppercase;
}
.detail-eyebrow .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: 0 0 auto; }
.detail-eyebrow .sep { color: var(--faint); font-weight: 400; letter-spacing: 0; }
.detail-eyebrow .prio { letter-spacing: 0.9px; font-weight: 600; }

/* The pane headline — the host's largest in-pane title is 17px, so the gadget stays there too. */
.title-field { margin: 6px 0 14px; }
.title-field .textarea {
  font-size: 17px; line-height: 24px; font-weight: 500; letter-spacing: -0.35px;
  background: transparent; border-color: transparent; box-shadow: none;
  padding: 4px 8px; margin-left: -8px; width: calc(100% + 8px);
  min-height: 0; resize: none; overflow: hidden;
}
.title-field .textarea::placeholder { color: var(--faint); font-weight: 500; }
.title-field .textarea:hover { border-color: var(--line); }
.title-field .textarea:focus { background: var(--base); border-color: var(--ring); box-shadow: var(--focus-ring); }

.field { margin-bottom: 12px; }
.field label {
  display: block; margin-bottom: 6px;
  font-size: 12px; line-height: 16px; font-weight: 500; letter-spacing: -0.2px; color: var(--muted);
  text-transform: none;
}
.two-up { display: flex; gap: 10px; }
.two-up > * { flex: 1 1 0; min-width: 0; }

.thread-title {
  display: flex; align-items: center; gap: 12px;
  margin: 22px 0 12px; padding-top: 16px; border-top: 1px solid var(--line);
  font-size: 11px; line-height: 16px; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.9px; color: var(--muted);
}
.thread-title .rule { flex: 1 1 auto; height: 1px; background: var(--line); }
.thread-title .n {
  color: var(--faint); letter-spacing: -0.1px; text-transform: none;
  font-variant-numeric: tabular-nums;
}

/* Updates read as a quiet timeline: one hairline rail, a node per entry. */
.thread { position: relative; padding-left: 16px; margin-bottom: 14px; }
.thread::before {
  content: ""; position: absolute; left: 3px; top: 4px; bottom: 4px;
  width: 1px; background: var(--line);
}
.update { position: relative; padding: 0 0 14px; }
.update:last-child { padding-bottom: 0; }
.update::before {
  content: ""; position: absolute; left: -16px; top: 5px;
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--elevated); border: 1.5px solid var(--fill-hover);
}
.update-body {
  font-size: 13px; line-height: 18px; letter-spacing: -0.25px;
  white-space: pre-wrap; word-break: break-word;
}
.update-meta { font-size: 12px; line-height: 16px; letter-spacing: -0.2px; color: var(--faint); margin-top: 4px; }

.composer { margin-top: 4px; }
.composer .textarea { min-height: 58px; }
.composer-row { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.composer-row .spacer { flex: 1 1 auto; }

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

.saved-flash {
  color: var(--muted); font-size: 12px; line-height: 16px; letter-spacing: -0.2px;
  opacity: 0; transition: opacity .2s var(--ease); white-space: nowrap; align-self: center;
}
.saved-flash.on { opacity: 1; }
`;
document.head.appendChild(style);

// Host controls light/dark via postMessage; honor it over the media-query fallback.
window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "myoplan-theme") return;
  if (data.mode !== "light" && data.mode !== "dark") return;
  document.documentElement.dataset.mode = data.mode;
});

// -----------------------------------------------------------------------------------------------
// State
// -----------------------------------------------------------------------------------------------

const STATUS_LABEL = { todo: "To do", in_progress: "In progress", blocked: "Blocked", done: "Done" };
const STATUS_ORDER = ["blocked", "in_progress", "todo", "done"];
const PRIORITIES = ["urgent", "high", "medium", "low"];
// Status accents map onto the host kumo status tokens, so the gadget never invents a hue.
const STATUS_TOKEN = {
  todo: "var(--muted)",
  in_progress: "var(--on-info)",
  blocked: "var(--on-danger)",
  done: "var(--on-success)",
};

const state = {
  filters: { status: "", project: "", search: "" },
  tasks: [],
  projects: [],
  counts: { todo: 0, in_progress: 0, blocked: 0, done: 0, total: 0 },
  selectedId: null,
  updates: [],
  creating: false,
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Click handlers are `async` but nothing awaits them, so a rejected RPC would otherwise vanish
// into an unhandled rejection and the UI would simply not respond. Route them all through here:
// the failure gets logged and surfaced, instead of looking like a dead button.
let toastTimer = null;
function run(fn) {
  return Promise.resolve().then(fn).catch((err) => {
    console.error("MyoPlan Tasks action failed:", err);
    toast(err && err.message ? err.message : String(err));
  });
}

function toast(message) {
  let node = document.querySelector(".toast");
  if (!node) {
    node = el("div", "toast");
    document.body.appendChild(node);
  }
  node.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), 4000);
}

// `Date.parse("2026-08-25")` is UTC midnight, which renders as Aug 24 anywhere west of Greenwich.
// Due dates are calendar days, not instants, so parse date-only values as local midnight.
function parseDue(value) {
  if (!value) return NaN;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.exec(String(value));
  if (dateOnly) {
    const [y, m, d] = String(value).split("-").map(Number);
    return new Date(y, m - 1, d).getTime();
  }
  return Date.parse(value);
}

function fmtDate(value) {
  const ms = parseDue(value);
  if (Number.isNaN(ms)) return value ?? null;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function isOverdue(task) {
  if (!task.dueDate || task.status === "done") return false;
  const ms = parseDue(task.dueDate);
  if (Number.isNaN(ms)) return false;
  // Overdue once the whole due day has passed, compared against today's local midnight.
  const today = new Date();
  return ms < new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
}

function projectTitle(id) {
  return state.projects.find((p) => p.id === id)?.title ?? null;
}

// -----------------------------------------------------------------------------------------------
// Shell
// -----------------------------------------------------------------------------------------------

const app = el("div", "app");
const header = el("div", "header");
const listPane = el("div", "list-pane");
const detailPane = el("div", "detail-pane hidden");
const body = el("div", "body");
body.append(listPane, detailPane);
app.append(header, body);
document.body.appendChild(app);

// Created once and reused across renders, so a re-render never steals the caret mid-search.
const searchInput = el("input", "search");
searchInput.type = "search";
searchInput.placeholder = "Search tasks…";
let searchTimer = null;
searchInput.addEventListener("input", () => {
  state.filters.search = searchInput.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => refresh(), 180);
});

function renderHeader() {
  header.replaceChildren();

  const row = el("div", "header-row");
  const brand = el("div", "brand", "MyoPlan Tasks");
  brand.appendChild(el("span", null, `${state.counts.total - state.counts.done} open · ${state.counts.total} total`));

  const newBtn = el("button", "btn primary", "New task");
  newBtn.addEventListener("click", startCreate);

  row.append(brand, searchInput, newBtn);

  const chips = el("div", "chips");
  chips.appendChild(chip("All", state.filters.status === "", state.counts.total, () => setStatus("")));
  for (const status of STATUS_ORDER) {
    chips.appendChild(
      chip(STATUS_LABEL[status], state.filters.status === status, state.counts[status] ?? 0, () => setStatus(status)),
    );
  }
  if (state.projects.length) {
    chips.appendChild(el("div", "chip-sep"));
    chips.appendChild(chip("All projects", state.filters.project === "", null, () => setProject("")));
    for (const project of state.projects) {
      chips.appendChild(
        chip(project.title, state.filters.project === project.id, project.openCount, () => setProject(project.id)),
      );
    }
  }

  header.append(row, chips);
}

function chip(label, on, count, onClick) {
  // A zero-count filter dims rather than vanishing: the roster of statuses stays legible.
  const vacant = count === 0 && !on;
  const node = el("button", `chip${on ? " on" : ""}${vacant ? " vacant" : ""}`);
  node.appendChild(document.createTextNode(label));
  if (count !== null && count !== undefined) node.appendChild(el("span", "count", String(count)));
  node.addEventListener("click", onClick);
  return node;
}

function emptyState(title, detail) {
  const box = el("div", "empty");
  box.appendChild(el("strong", null, title));
  if (detail) box.appendChild(document.createTextNode(detail));
  return box;
}

function setStatus(status) {
  state.filters.status = status;
  refresh();
}

function setProject(project) {
  state.filters.project = project;
  refresh();
}

// -----------------------------------------------------------------------------------------------
// List
// -----------------------------------------------------------------------------------------------

function renderList() {
  listPane.replaceChildren();

  if (!state.tasks.length) {
    const filtered = state.filters.search || state.filters.status || state.filters.project;
    listPane.appendChild(filtered
      ? emptyState("Nothing matches", "No task fits the current search and filters. Widen them, or clear the search.")
      : emptyState("No tasks yet", "Create the first one and it will show up here."));
    return;
  }

  // The list arrives pre-sorted by attention, so bands fall out of a single pass. Each header
  // needs its own count, which means measuring the run before emitting it.
  let index = 0;
  while (index < state.tasks.length) {
    const band = state.tasks[index].status;
    let end = index;
    while (end < state.tasks.length && state.tasks[end].status === band) end++;
    listPane.appendChild(bandLabel(STATUS_LABEL[band] ?? band, end - index));
    for (; index < end; index++) listPane.appendChild(renderTask(state.tasks[index]));
  }
}

function bandLabel(text, count) {
  const label = el("div", "band-label");
  label.append(el("span", null, text), el("span", "rule"), el("span", "n", String(count)));
  return label;
}

function renderTask(task) {
  const row = el("div", `task${task.status === "done" ? " is-done" : ""}${task.id === state.selectedId ? " selected" : ""}`);

  const tick = el("button", `tick${task.status === "done" ? " checked" : ""}`);
  tick.type = "button";
  tick.title = task.status === "done" ? "Reopen" : "Mark done";
  tick.setAttribute("aria-label", tick.title);
  tick.appendChild(el("span", "ring"));
  tick.addEventListener("click", (event) => {
    event.stopPropagation();
    // The row handler is fire-and-forget too; both report rather than reject into the void.
    void run(async () => {
      if (task.status === "done") await gadget.reopenTask(task.id);
      else await gadget.completeTask(task.id);
      await refresh();
    });
  });

  const main = el("div", "task-main");
  main.appendChild(el("div", "task-title", task.title));

  const meta = el("div", "task-meta");
  meta.appendChild(el("span", `pill status-${task.status}`, STATUS_LABEL[task.status] ?? task.status));
  meta.appendChild(el("span", `prio ${task.priority}`, task.priority));
  const project = projectTitle(task.project);
  if (project) {
    meta.appendChild(el("span", "dot-sep"));
    meta.appendChild(el("span", null, project));
  }
  if (task.assignee) {
    meta.appendChild(el("span", "dot-sep"));
    meta.appendChild(el("span", null, `@${task.assignee}`));
  }
  if (task.dueDate) {
    meta.appendChild(el("span", "dot-sep"));
    meta.appendChild(el("span", `due${isOverdue(task) ? " overdue" : ""}`, `due ${fmtDate(task.dueDate)}`));
  }
  main.appendChild(meta);

  row.append(tick, main);
  row.addEventListener("click", () => void run(() => select(task.id)));
  return row;
}

// -----------------------------------------------------------------------------------------------
// Detail
// -----------------------------------------------------------------------------------------------

async function select(id) {
  state.selectedId = id;
  state.creating = false;
  state.updates = await gadget.listUpdates(id);
  renderList();
  renderDetail();
}

function closeDetail() {
  state.selectedId = null;
  state.creating = false;
  state.updates = [];
  renderList();
  renderDetail();
}

// At narrow widths the pane covers the list, so it must always be dismissable without hunting for
// the Close button. Escape does it from anywhere except mid-edit in a textarea.
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!state.creating && !state.selectedId) return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === "TEXTAREA") { document.activeElement.blur(); return; }
  closeDetail();
});

function startCreate() {
  state.creating = true;
  state.selectedId = null;
  state.updates = [];
  renderList();
  renderDetail();
}

// What the detail pane currently shows. A background refresh must not rebuild an open form under
// the user's cursor, so renderDetail() is a no-op unless the pane's subject actually changed.
// The sentinel is deliberately not `null`: `null` is a real subject (nothing selected), and using
// it as the initial value would suppress the very first paint of the empty state.
const NOTHING_RENDERED = Symbol("nothing-rendered");
let renderedDetail = NOTHING_RENDERED;

function renderDetail(force = false) {
  const subject = state.creating ? "__new__" : state.selectedId;
  if (!force && subject === renderedDetail) return;
  renderedDetail = subject;

  if (state.creating) return renderCreateForm();

  const task = state.tasks.find((t) => t.id === state.selectedId);
  if (!task) {
    // At desktop widths the pane holds its column and explains itself; at narrow widths the
    // `vacant` class takes it out of the flow so the list keeps the whole screen.
    detailPane.className = "detail-pane vacant";
    detailPane.replaceChildren(emptyState(
      "Nothing selected",
      "Pick a task from the list to read it, edit it, or post an update."));
    return;
  }

  detailPane.className = "detail-pane";
  detailPane.replaceChildren();

  const head = el("div", "detail-head");
  const eyebrow = el("div", "detail-eyebrow");
  // Status colour comes from the host status tokens, mapped by status.
  eyebrow.style.color = STATUS_TOKEN[task.status] ?? "var(--muted)";
  eyebrow.append(el("span", "dot"), el("span", null, STATUS_LABEL[task.status] ?? task.status));
  eyebrow.append(el("span", "sep", "/"), el("span", `prio ${task.priority}`, task.priority));
  head.appendChild(eyebrow);
  head.appendChild(el("div", "spacer"));
  const flash = el("span", "saved-flash", "Saved");
  head.appendChild(flash);
  const close = el("button", "btn ghost", "Close");
  close.addEventListener("click", closeDetail);
  head.appendChild(close);
  detailPane.appendChild(head);

  const save = debounce((patch) => run(async () => {
    await gadget.updateTask(task.id, patch);
    flash.classList.add("on");
    setTimeout(() => flash.classList.remove("on"), 900);
    await refresh({ keepSelection: true });
  }), 400);

  // The title reads as the pane's headline but is still the same autosaving field.
  const titleWrap = el("div", "title-field");
  const titleArea = titleField(task.title, (v) => save({ title: v }));
  titleWrap.appendChild(titleArea);
  detailPane.appendChild(titleWrap);
  titleArea._grow();

  detailPane.appendChild(field("Description", textArea(task.description, (v) => save({ description: v }))));

  const pair = el("div", "two-up");
  pair.appendChild(field("Status", select_(STATUS_ORDER.map((s) => [s, STATUS_LABEL[s]]), task.status, (v) => save({ status: v }))));
  pair.appendChild(field("Priority", select_(PRIORITIES.map((p) => [p, p]), task.priority, (v) => save({ priority: v }))));
  detailPane.appendChild(pair);

  const pair2 = el("div", "two-up");
  pair2.appendChild(field("Assignee", textInput(task.assignee ?? "", (v) => save({ assignee: v }))));
  pair2.appendChild(field("Due date", dateInput(task.dueDate, (v) => save({ dueDate: v }))));
  detailPane.appendChild(pair2);

  const projectOptions = [["", "— none —"], ...state.projects.map((p) => [p.id, p.title])];
  detailPane.appendChild(field("Project", select_(projectOptions, task.project ?? "", (v) => save({ project: v }))));

  // --- updates thread ---
  const threadHead = el("div", "thread-title");
  threadHead.append(el("span", null, "Updates"), el("span", "rule"), el("span", "n", String(state.updates.length)));
  detailPane.appendChild(threadHead);

  if (state.updates.length) {
    const thread = el("div", "thread");
    for (const update of state.updates) {
      const node = el("div", "update");
      node.appendChild(el("div", "update-body", update.body));
      const when = new Date(update.createdAt).toLocaleString(undefined, {
        month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      });
      node.appendChild(el("div", "update-meta", update.author ? `${update.author} · ${when}` : when));
      thread.appendChild(node);
    }
    detailPane.appendChild(thread);
  } else {
    detailPane.appendChild(emptyState("No updates yet", "Post one below to start the thread."));
  }

  // --- composer, last thing in the pane ---
  const composerWrap = el("div", "composer");
  const composer = el("textarea", "textarea");
  composer.placeholder = "Add an update…";
  const addRow = el("div", "composer-row");
  const addBtn = el("button", "btn primary", "Post update");
  addBtn.addEventListener("click", () => void run(async () => {
    const value = composer.value.trim();
    if (!value) { composer.focus(); return; }
    addBtn.disabled = true;
    try {
      await gadget.addUpdate({ taskId: task.id, body: value });
      composer.value = "";
      state.updates = await gadget.listUpdates(task.id);
      renderDetail(true);
    } finally {
      addBtn.disabled = false;
    }
  }));
  const del = el("button", "btn danger", "Delete task");
  del.addEventListener("click", () => void run(async () => {
    await gadget.deleteTask(task.id);
    closeDetail();
    await refresh();
  }));
  addRow.append(addBtn, el("div", "spacer"), del);
  composerWrap.append(composer, addRow);
  detailPane.appendChild(composerWrap);
}

function renderCreateForm() {
  detailPane.className = "detail-pane";
  detailPane.replaceChildren();

  const head = el("div", "detail-head");
  const eyebrow = el("div", "detail-eyebrow");
  eyebrow.style.color = "var(--muted)";
  eyebrow.append(el("span", "dot"), el("span", null, "New task"));
  head.appendChild(eyebrow);
  head.appendChild(el("div", "spacer"));
  const close = el("button", "btn ghost", "Cancel");
  close.addEventListener("click", closeDetail);
  head.appendChild(close);
  detailPane.appendChild(head);

  const draft = { title: "", description: "", status: "todo", priority: "medium", assignee: "", project: "", dueDate: "" };

  const titleInput = titleField("", (v) => { draft.title = v; });
  titleInput.placeholder = "What needs doing?";
  const titleWrap = el("div", "title-field");
  titleWrap.appendChild(titleInput);
  detailPane.appendChild(titleWrap);
  titleInput._grow();
  detailPane.appendChild(field("Description", textArea("", (v) => { draft.description = v; }, { live: true })));

  const pair = el("div", "two-up");
  pair.appendChild(field("Status", select_(STATUS_ORDER.map((s) => [s, STATUS_LABEL[s]]), "todo", (v) => { draft.status = v; })));
  pair.appendChild(field("Priority", select_(PRIORITIES.map((p) => [p, p]), "medium", (v) => { draft.priority = v; })));
  detailPane.appendChild(pair);

  const pair2 = el("div", "two-up");
  pair2.appendChild(field("Assignee", textInput("", (v) => { draft.assignee = v; }, { live: true })));
  pair2.appendChild(field("Due date", dateInput(null, (v) => { draft.dueDate = v; })));
  detailPane.appendChild(pair2);

  const projectOptions = [["", "— none —"], ...state.projects.map((p) => [p.id, p.title])];
  detailPane.appendChild(field("Project", select_(projectOptions, "", (v) => { draft.project = v; })));

  const actions = el("div", "composer-row");
  const create = el("button", "btn primary", "Create task");
  create.addEventListener("click", () => void run(async () => {
    if (!draft.title.trim()) { titleInput.focus(); return; }
    create.disabled = true;
    try {
      const task = await gadget.createTask(draft);
      state.creating = false;
      await refresh();
      await select(task.id);
    } finally {
      create.disabled = false;
    }
  }));
  actions.appendChild(create);
  detailPane.appendChild(actions);

  titleInput.focus();
}

// --- small form primitives ---------------------------------------------------------------------

function field(label, control) {
  const wrap = el("div", "field");
  wrap.appendChild(el("label", null, label));
  wrap.appendChild(control);
  return wrap;
}

function textInput(value, onChange, opts = {}) {
  const input = el("input", "input");
  input.type = "text";
  input.value = value ?? "";
  input.addEventListener(opts.live ? "input" : "input", () => onChange(input.value));
  return input;
}

function textArea(value, onChange, opts = {}) {
  const area = el("textarea", "textarea");
  area.value = value ?? "";
  area.addEventListener("input", () => onChange(area.value));
  return area;
}

// The title is a textarea so a long one wraps instead of scrolling out of sight in a single line,
// but it behaves like a one-line field: it grows to fit and Enter commits rather than inserting.
function titleField(value, onChange) {
  const area = el("textarea", "textarea");
  area.rows = 1;
  area.value = value ?? "";
  let lastWidth = -1;
  const grow = () => { area.style.height = "auto"; area.style.height = `${area.scrollHeight}px`; };
  area.addEventListener("input", () => { grow(); onChange(area.value); });
  area.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); area.blur(); }
  });
  // How many lines the title wraps to depends on the pane's width, which is not settled at the
  // moment this node is built. Re-measure whenever the box actually changes width, so the field
  // is correct on first paint and stays correct when the pane is resized.
  // Callers invoke this once the node is in the document; scrollHeight is meaningless before then.
  area._grow = grow;
  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(() => {
      const width = area.clientWidth;
      if (width === lastWidth) return;
      lastWidth = width;
      grow();
    });
    observer.observe(area);
    // An observer nothing references is collectable, and Chrome does collect it -- the callback
    // then simply never fires. Pin it to the node it watches so they share a lifetime.
    area._resizeObserver = observer;
  }
  return area;
}

function dateInput(value, onChange) {
  const input = el("input", "input");
  input.type = "date";
  input.value = value ? String(value).slice(0, 10) : "";
  input.addEventListener("change", () => onChange(input.value));
  return input;
}

function select_(options, value, onChange) {
  const node = el("select", "select");
  for (const [optValue, label] of options) {
    const option = el("option", null, label);
    option.value = optValue;
    if (optValue === value) option.selected = true;
    node.appendChild(option);
  }
  node.addEventListener("change", () => onChange(node.value));
  return node;
}

function debounce(fn, ms) {
  let timer = null;
  let pending = {};
  return (patch) => {
    pending = { ...pending, ...patch };
    clearTimeout(timer);
    timer = setTimeout(() => {
      const args = pending;
      pending = {};
      fn(args);
    }, ms);
  };
}

// -----------------------------------------------------------------------------------------------
// Data flow
// -----------------------------------------------------------------------------------------------

let refreshing = false;

async function refresh(opts = {}) {
  if (refreshing) return;
  refreshing = true;
  try {
    const snap = await gadget.snapshot({
      status: state.filters.status || undefined,
      project: state.filters.project || undefined,
      search: state.filters.search || undefined,
      sort: "attention",
    });
    state.tasks = snap.tasks;
    state.projects = snap.projects;
    state.counts = snap.counts;
    if (state.selectedId && !state.tasks.some((t) => t.id === state.selectedId) && !opts.keepSelection) {
      state.selectedId = null;
    }
  } finally {
    refreshing = false;
  }

  renderHeader();
  renderList();
  renderDetail();
}

// Live updates: the server calls changed() whenever anything mutates (including from an agent).
class Watcher extends RpcTarget {
  changed() {
    refresh({ keepSelection: true }).catch((err) => console.error("refresh failed", err));
  }
  [Symbol.dispose]() {
    // The connection dropped; re-subscribe on the replacement stub.
    gadget.subscribe(new Watcher()).catch(() => {});
  }
}

function showFatal(err) {
  const message = err && err.stack ? err.stack : String(err);
  const panel = el("div", "fatal");
  panel.appendChild(el("div", "fatal-title", "MyoPlan Tasks failed to start"));
  panel.appendChild(el("pre", "fatal-body", message));
  // Replace whatever half-built UI exists; a partial render is more confusing than none.
  document.body.replaceChildren(panel);
  console.error("MyoPlan Tasks init failed:", message);
}

try {
  await refresh();
  await gadget.subscribe(new Watcher());
} catch (err) {
  showFatal(err);
}
