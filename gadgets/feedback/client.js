// MyoPlan Feedback — responsive, first-party triage inbox.
// `gadget` is the RPC stub supplied by the sandbox.
const style = document.createElement("style");
style.textContent = `
:root{color-scheme:light dark;--base:#fff;--raised:#f8fafc;--tint:#f1f5f9;--fill:#e2e8f0;--line:#e2e8f0;--text:#0f172a;--muted:#64748b;--faint:#94a3b8;--accent:#1a8a9c;--danger:#b0505c;--success:#15803d;--warning:#a16617;--shadow:0 12px 32px #0f172a18;--font:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",sans-serif}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]){--base:#0b1220;--raised:#0f172a;--tint:#1e293b;--fill:#334155;--line:#334155;--text:#f8fafc;--muted:#94a3b8;--faint:#64748b;--accent:#7dd3e0;--danger:#e79aa4;--success:#6ee7a0;--warning:#f0c46a;--shadow:0 12px 32px #0008}}
:root[data-theme=dark]{--base:#0b1220;--raised:#0f172a;--tint:#1e293b;--fill:#334155;--line:#334155;--text:#f8fafc;--muted:#94a3b8;--faint:#64748b;--accent:#7dd3e0;--danger:#e79aa4;--success:#6ee7a0;--warning:#f0c46a;--shadow:0 12px 32px #0008}
*{box-sizing:border-box}html,body{margin:0;height:100%;background:var(--base);color:var(--text);font:13px/1.45 var(--font);-webkit-font-smoothing:antialiased}button,input,select,textarea{font:inherit;color:inherit}button{cursor:pointer}.app{height:100vh;display:grid;grid-template-rows:auto 1fr;overflow:hidden}.top{padding:12px 16px;border-bottom:1px solid var(--line);background:var(--base)}.toprow,.filters,.actions,.meta,.chips{display:flex;align-items:center;gap:8px}.brand{font-size:15px;font-weight:650;margin-right:auto}.brand small{font-size:12px;font-weight:400;color:var(--faint);margin-left:7px}.filters{margin-top:9px;overflow:auto}.input,.select,.textarea{border:1px solid var(--line);background:var(--base);border-radius:8px;padding:8px 10px;outline:none}.input:focus,.select:focus,.textarea:focus{border-color:var(--faint);box-shadow:0 0 0 3px color-mix(in srgb,var(--faint) 15%,transparent)}.search{width:min(320px,42vw)}.select{min-width:112px}.btn{border:1px solid var(--line);background:var(--base);border-radius:8px;padding:7px 11px;font-weight:550}.btn:hover{background:var(--tint)}.btn.primary{background:var(--text);color:var(--base);border-color:transparent}.btn.quiet{border-color:transparent;background:transparent;color:var(--muted)}.layout{display:grid;grid-template-columns:minmax(320px,42%) 1fr;min-height:0}.inbox{overflow:auto;border-right:1px solid var(--line);padding:8px}.card{display:grid;grid-template-columns:8px 1fr auto;gap:10px;padding:12px;border-radius:10px;border:1px solid transparent}.card:hover{background:var(--raised)}.card.active{background:var(--tint);border-color:var(--line)}.sev{width:7px;height:7px;border-radius:50%;margin-top:6px;background:var(--faint)}.sev-critical,.sev-high{background:var(--danger)}.sev-medium{background:var(--warning)}.title{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.bodyline{color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}.meta{color:var(--faint);font-size:11px;margin-top:7px;flex-wrap:wrap}.badge{padding:2px 6px;background:var(--raised);border:1px solid var(--line);border-radius:5px}.detail{overflow:auto;padding:22px clamp(16px,4vw,44px)}.empty{height:100%;display:grid;place-items:center;color:var(--muted);text-align:center}.empty strong{display:block;color:var(--text);font-size:15px;margin-bottom:4px}.detail h1{font-size:21px;line-height:1.3;margin:8px 0;font-weight:650}.report{font-size:15px;line-height:1.6;white-space:pre-wrap;padding:18px 0;border-bottom:1px solid var(--line)}.fieldgrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:18px 0}.field label,.section-title{display:block;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.07em;font-weight:650;margin-bottom:5px}.field .input,.field .select{width:100%}.section{border-top:1px solid var(--line);padding-top:18px;margin-top:18px}.context{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 18px}.context div{min-width:0}.context dt{color:var(--faint);font-size:11px}.context dd{margin:1px 0;word-break:break-word}.note{padding:11px 0;border-bottom:1px solid var(--line)}.note.event{color:var(--muted);font-size:12px}.notehead{color:var(--faint);font-size:11px;margin-bottom:3px}.textarea{width:100%;resize:vertical;min-height:72px}.composer{display:flex;gap:8px;align-items:flex-end}.composer .textarea{flex:1}.toast{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);padding:9px 14px;background:var(--base);border:1px solid var(--line);border-radius:8px;box-shadow:var(--shadow);z-index:5}.error{color:var(--danger)}
@media(max-width:760px){.toprow{flex-wrap:wrap}.brand{flex-basis:100%}.search{width:100%;max-width:none}.layout{display:block;overflow:auto}.inbox{border:0;overflow:visible}.detail{display:none}.layout.show-detail .inbox{display:none}.layout.show-detail .detail{display:block}.fieldgrid{grid-template-columns:1fr 1fr}.back{display:inline-flex!important}}
@media(min-width:761px){.back{display:none!important}}
`;
document.head.append(style);

const state = {
  feedback: [],
  counts: { total: 0, open: 0 },
  assignees: [],
  tags: [],
  selected: null,
  detail: null,
  filters: { status: "open", sort: "triage" },
};
const statuses = ["new", "reviewing", "planned", "resolved", "closed"],
  categories = ["bug", "idea", "question", "praise", "other"],
  severities = ["none", "low", "medium", "high", "critical"];
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const ago = (iso) => {
  const n = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  return n < 1
    ? "now"
    : n < 60
      ? `${n}m`
      : n < 1440
        ? `${Math.floor(n / 60)}h`
        : `${Math.floor(n / 1440)}d`;
};
const options = (xs, value) =>
  xs
    .map(
      (x) =>
        `<option value="${esc(x)}" ${x === value ? "selected" : ""}>${esc(x.replaceAll("_", " "))}</option>`,
    )
    .join("");
function toast(message, error = false) {
  const el = document.createElement("div");
  el.className = `toast ${error ? "error" : ""}`;
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.remove(), 2600);
}

const root = document.createElement("div");
root.className = "app";
document.body.append(root);
function shell() {
  root.innerHTML = `<header class="top"><div class="toprow"><div class="brand">Feedback <small>${state.counts.open || 0} open · ${state.counts.total || 0} total</small></div><input class="input search" id="search" placeholder="Search reports…"><button class="btn primary" id="new">New report</button></div><div class="filters"><select class="select" id="status"><option value="">All statuses</option><option value="open">Open</option>${options(statuses, state.filters.status)}</select><select class="select" id="category"><option value="">All categories</option>${options(categories, state.filters.category)}</select><select class="select" id="severity"><option value="">All severities</option>${options(severities, state.filters.severity)}</select><select class="select" id="sort"><option value="triage">Triage order</option><option value="updated">Recently updated</option><option value="created">Newest</option></select><label><input type="checkbox" id="dupes"> Hide duplicates</label></div></header><main class="layout"><section class="inbox"></section><section class="detail"></section></main>`;
  for (const key of ["status", "category", "severity", "sort"]) {
    const el = root.querySelector(`#${key}`);
    el.value = state.filters[key] || "";
    el.addEventListener("change", () => {
      state.filters[key] = el.value;
      refresh();
    });
  }
  let timer;
  root.querySelector("#search").addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.filters.search = e.target.value;
      refresh();
    }, 180);
  });
  root.querySelector("#dupes").addEventListener("change", (e) => {
    state.filters.includeDuplicates = !e.target.checked;
    refresh();
  });
  root.querySelector("#new").addEventListener("click", newReport);
}
function renderList() {
  const inbox = root.querySelector(".inbox");
  inbox.innerHTML = state.feedback.length
    ? state.feedback
        .map(
          (f) =>
            `<article class="card ${f.id === state.selected ? "active" : ""}" data-id="${esc(f.id)}"><i class="sev sev-${esc(f.severity)}"></i><div><div class="title">${esc(f.title || f.body)}</div><div class="bodyline">${esc(f.body)}</div><div class="meta"><span class="badge">${esc(f.status)}</span><span>${esc(f.category)}</span>${f.source ? `<span>${esc(f.source)}</span>` : ""}${f.assignee ? `<span>↳ ${esc(f.assignee)}</span>` : ""}${f.linkedTaskId ? `<span>Task ${esc(f.linkedTaskId)}</span>` : ""}</div></div><time class="meta">${ago(f.updatedAt)}</time></article>`,
        )
        .join("")
    : `<div class="empty"><div><strong>Inbox clear</strong>No reports match these filters.</div></div>`;
  inbox
    .querySelectorAll(".card")
    .forEach((el) => el.addEventListener("click", () => select(el.dataset.id)));
}
async function select(id) {
  state.selected = id;
  state.detail = await gadget.detail(id);
  renderList();
  renderDetail();
  root.querySelector(".layout").classList.add("show-detail");
}
function renderDetail() {
  const el = root.querySelector(".detail"),
    f = state.detail;
  if (!f) {
    el.innerHTML = `<div class="empty"><div><strong>Select a report</strong>Review the original feedback and triage history.</div></div>`;
    return;
  }
  const context = {
    Reporter: f.reporter?.name || f.reporter?.email || f.reporter?.id,
    Source: f.source,
    Surface: f.surface,
    Version: f.appVersion,
    Build: f.appBuild,
    Device: f.device,
    OS: f.os,
    Route: f.route,
    "Input mode": f.inputMode,
    "Trace ID": f.traceId,
    "Session ID": f.sessionId,
  };
  el.innerHTML = `<button class="btn quiet back">← Inbox</button><div class="meta"><span class="badge">${esc(f.id)}</span><span>reported ${ago(f.createdAt)} ago</span></div><h1>${esc(f.title || "Untitled feedback")}</h1><div class="report">${esc(f.body)}</div><div class="fieldgrid"><div class="field"><label>Status</label><select class="select" data-field="status">${options(statuses, f.status)}</select></div><div class="field"><label>Category</label><select class="select" data-field="category">${options(categories, f.category)}</select></div><div class="field"><label>Severity</label><select class="select" data-field="severity">${options(severities, f.severity)}</select></div><div class="field"><label>Assignee</label><input class="input" data-field="assignee" value="${esc(f.assignee || "")}" placeholder="Unassigned"></div><div class="field"><label>Title</label><input class="input" data-field="title" value="${esc(f.title || "")}" placeholder="Add a concise title"></div><div class="field"><label>Tags</label><input class="input" data-field="tags" value="${esc(f.tags.join(", "))}" placeholder="comma, separated"></div></div>${f.linkedTaskId ? `<div class="section"><div class="section-title">Linked task</div><div class="actions"><span>${esc(f.linkedTaskTitle || f.linkedTaskId)}</span>${f.linkedTaskUrl ? `<a href="${esc(f.linkedTaskUrl)}" target="_blank">Open</a>` : ""}<button class="btn quiet" id="unlink">Unlink</button></div></div>` : `<div class="section"><div class="section-title">Promote / link to task</div><div class="actions"><input class="input" id="taskId" placeholder="Task ID"><button class="btn" id="link">Link</button><button class="btn" id="promote">Promote</button></div></div>`}<div class="section"><div class="section-title">Original context</div><dl class="context">${Object.entries(
    context,
  )
    .filter(([, v]) => v)
    .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`)
    .join(
      "",
    )}</dl>${Object.keys(f.metadata || {}).length ? `<pre>${esc(JSON.stringify(f.metadata, null, 2))}</pre>` : ""}</div><div class="section"><div class="section-title">Notes & history</div><div>${f.notes.map((n) => `<div class="note ${n.kind}"><div class="notehead">${esc(n.author || n.kind)} · ${ago(n.createdAt)}</div>${esc(n.body)}</div>`).join("")}</div><div class="composer"><textarea class="textarea" id="note" placeholder="Add an internal note…"></textarea><button class="btn" id="addNote">Add</button></div></div>`;
  el.querySelector(".back").addEventListener("click", () =>
    root.querySelector(".layout").classList.remove("show-detail"),
  );
  el.querySelectorAll("[data-field]").forEach((input) =>
    input.addEventListener("change", async () => {
      const field = input.dataset.field,
        value =
          field === "tags"
            ? input.value
                .split(",")
                .map((x) => x.trim())
                .filter(Boolean)
            : input.value;
      await mutate(() => gadget.update(f.id, { [field]: value }), "Updated");
    }),
  );
  const note = el.querySelector("#addNote");
  if (note)
    note.addEventListener("click", () =>
      mutate(
        () => gadget.addNote({ feedbackId: f.id, body: el.querySelector("#note").value }),
        "Note added",
      ),
    );
  const taskId = () => el.querySelector("#taskId").value;
  if (el.querySelector("#link"))
    el.querySelector("#link").addEventListener("click", () =>
      mutate(() => gadget.linkTask(f.id, { taskId: taskId() }), "Task linked"),
    );
  if (el.querySelector("#promote"))
    el.querySelector("#promote").addEventListener("click", () =>
      mutate(() => gadget.promoteToTask(f.id, { taskId: taskId() }), "Promoted to planned"),
    );
  if (el.querySelector("#unlink"))
    el.querySelector("#unlink").addEventListener("click", () =>
      mutate(() => gadget.unlinkTask(f.id), "Task unlinked"),
    );
}
async function mutate(fn, message) {
  try {
    await fn();
    toast(message);
    await refresh();
    if (state.selected) await select(state.selected);
  } catch (e) {
    toast(e.message || String(e), true);
  }
}
function newReport() {
  const body = prompt("Paste the original feedback report");
  if (body)
    mutate(async () => {
      const f = await gadget.submit({ body, source: "manual" });
      state.selected = f.id;
    }, "Report added");
}
async function refresh() {
  try {
    const snap = await gadget.snapshot(state.filters);
    state.feedback = snap.feedback;
    state.counts = snap.counts;
    state.assignees = snap.assignees;
    state.tags = snap.tags;
    root.querySelector(".brand small").textContent =
      `${state.counts.open} open · ${state.counts.total} total`;
    renderList();
  } catch (e) {
    toast(e.message || String(e), true);
  }
}

window.addEventListener("message", (event) => {
  if (event.data?.type === "myoplan-theme") {
    const mode = event.data.theme?.mode || event.data.mode;
    if (mode) document.documentElement.dataset.theme = mode;
  }
});
window.parent.postMessage({ type: "myoplan-theme-request" }, "*");
class Subscriber extends RpcTarget {
  changed() {
    refresh();
  }
}
(async () => {
  try {
    shell();
    await refresh();
    renderDetail();
    await gadget.subscribe(new Subscriber());
  } catch (e) {
    root.innerHTML = `<div class="empty error"><div><strong>Feedback could not start</strong>${esc(e.message || e)}</div></div>`;
  }
})();
