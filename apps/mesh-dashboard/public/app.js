/* ============================================================ Agent Mesh console */
"use strict";

/* ------------------------------------------------------------- tiny helpers */
const $ = (id) => document.getElementById(id);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => (Number(n) >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n ?? 0));
const hhmmss = (iso) => String(iso ?? "").slice(11, 19);
const ago = (iso) => {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s)) return "";
  if (s < 60) return `${Math.max(0, Math.round(s))}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
};
const pillCls = (lifecycle) => String(lifecycle || "").toLowerCase();
const RUNNING = new Set(["THINKING", "WORKING", "AWAKENED", "OBSERVING", "REQUESTING", "REVIEWING"]);
const uid = () => Math.random().toString(36).slice(2, 9);

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-json */ }
  if (!res.ok && res.status >= 500) toast("server error", `${path} -> ${res.status}`, "bad");
  return { status: res.status, json };
}
const post = (path, body) => api("POST", path, body ?? {});
const getText = async (path) => { try { return await (await fetch(path)).text(); } catch { return ""; } };

/* ------------------------------------------------------------------ toasts */
function toast(title, msg, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `<b>${esc(title)}</b>${esc(msg)}`;
  $("toasts").appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .4s"; }, kind === "bad" ? 7000 : 4200);
  setTimeout(() => el.remove(), kind === "bad" ? 7600 : 4800);
  while ($("toasts").children.length > 4) $("toasts").firstChild.remove();
}

/* -------------------------------------------------------------------- state */
const S = {
  view: location.hash.replace("#/", "") || "overview",
  status: null,
  metrics: null,
  events: [],
  eventSeqSeen: new Set(),
  graph: null,
  artifacts: null,
  budgets: null,
  escalations: null,
  vocab: null,
  goalId: null,
  autoScroll: true,
  evFilter: "",
  evSearch: "",
  sse: null,
  designer: { model: null, currentAgent: null, savedTo: "examples/my-mesh/mesh.yaml", lastResult: null, agentTab: null, importOpen: false },
};

/* -------------------------------------------------------------------- shell */
function setView(v) {
  S.view = v;
  location.hash = `#/${v}`;
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === v));
  void renderView();
}

function updateTopbar() {
  const st = S.status;
  if (!st) return;
  const goal = st.goal || {};
  $("mesh-id").textContent = goal.id ? `goal ${goal.id.slice(0, 14)}` : "";
  $("top-goal").textContent = `${(goal.description || "no goal").split("\n")[0].slice(0, 70)}`;
  const crit = (goal.acceptanceCriteria || []);
  const done = crit.filter((c) => c.status !== "UNSATISFIED").length;
  $("top-criteria").textContent = goal.status ? `· ${goal.status} · ${done}/${crit.length} criteria` : "";
  const mission = (st.budgets || []).find((b) => b.key.startsWith("mission:") && b.limitKind === "tokens");
  const active = (st.agents || []).filter((a) => RUNNING.has(a.lifecycle)).length;
  const waiting = (st.agents || []).filter((a) => a.lifecycle === "WAITING").length;
  const escOpen = (st.openEscalations || []).length;
  $("top-stats").innerHTML = `
    <div class="stat"><b>${fmt(mission?.consumed ?? 0)}<span class="muted">/${fmt(mission?.limit ?? 0)}</span></b><span>tokens</span></div>
    <div class="stat"><b>${st.eventCount ?? 0}</b><span>events</span></div>
    <div class="stat"><b>${active}<span class="muted"> +${waiting} wait</span></b><span>active</span></div>
    <div class="stat"><b style="color:${escOpen ? "var(--bad)" : "inherit"}">${escOpen}</b><span>escalations</span></div>`;
  $("btn-pause").classList.toggle("hidden", goal.status === "PAUSED" || ["COMPLETED", "FAILED"].includes(goal.status));
  $("btn-resume").classList.toggle("hidden", goal.status !== "PAUSED");
  $("esc-badge").textContent = escOpen ? String(escOpen) : "";
  const live = $("live-dot");
  if (st.uiOnly) { live.style.background = "var(--warn)"; live.title = "UI-only console — scheduler is stopped, agents are parked by design"; }
  else { live.style.background = ""; live.title = "SSE connection"; }
}

/* ------------------------------------------------------------------ drawers */
let drawerMode = false;
function openDrawer(html) {
  $("drawer-body").innerHTML = html;
  $("drawer").classList.remove("hidden");
  $("scrim").classList.remove("hidden");
  drawerMode = true;
  const x = $("drawer-body").querySelector(".close-x");
  if (x) x.addEventListener("click", closeDrawer);
  $("drawer").scrollTop = 0;
}
function closeDrawer() {
  $("drawer").classList.add("hidden");
  $("scrim").classList.add("hidden");
  drawerMode = false;
}
$("scrim").addEventListener("click", closeDrawer);

/* --------------------------------------------------------------- controls */
async function drawerControls(kind) {
  if (kind === "message") {
    const ids = (S.status?.agents || []).filter((a) => a.id !== "human").map((a) => a.id);
    openDrawer(`
      <h2>Send as human seat <button class="close-x">×</button></h2>
      <p class="muted" style="margin-top:0">Typed messages from the operator. Provenance is recorded as <code>human</code> (highest trust).</p>
      <form id="send-form" class="stack">
        <div class="field"><label>recipients</label><input id="send-to" list="send-to-list" placeholder="architect, pm, …" required><datalist id="send-to-list">${ids.map((i) => `<option>${esc(i)}</option>`).join("")}</datalist></div>
        <div class="field"><label>message type</label><select id="send-type" class="sel">${(S.vocab?.messageTypes || ["INFORM", "MISSION", "REQUEST", "REQUEST_REVIEW", "ESCALATE", "DONE"]).map((t) => `<option>${t}</option>`).join("")}</select></div>
        <div class="field"><label>payload (JSON)</label><textarea id="send-payload" class="txt" rows="4" spellcheck="false">{ "note": "" }</textarea></div>
        <div class="row"><button class="primary" type="submit">send message</button><span id="send-out" class="muted"></span></div>
      </form>`);
    $("send-form").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      let payload;
      try { payload = JSON.parse($("send-payload").value || "{}"); } catch { $("send-out").textContent = "payload must be JSON"; return; }
      const to = $("send-to").value.split(",").map((s) => s.trim()).filter(Boolean);
      const { status, json } = await post("/messages", { to, type: $("send-type").value, payload });
      $("send-out").textContent = status === 202 ? "sent ✓" : `rejected: ${json?.reason ?? status}`;
      if (status === 202) toast("message sent", `${$("send-type").value} -> ${to.join(", ")}`, "ok");
      void refreshStatus();
    });
  } else {
    const subjects = ["architecture", "implementation", "quality", "security", "requirements", "release"];
    const arts = (await getArtifacts()).slice().reverse();
    openDrawer(`
      <h2>Record approval <button class="close-x">×</button></h2>
      <p class="muted" style="margin-top:0">Binds an approval/rejection to a domain, artifact, or acceptance criterion (<code>criterion:&lt;id&gt;</code>). Runtime gates read these records.</p>
      <form id="approval-form" class="stack">
        <div class="field"><label>action</label><select id="appr-kind" class="sel"><option>approve</option><option>reject</option><option>accept</option></select></div>
        <div class="field"><label>subject</label><input id="appr-subject" list="subj" placeholder="release, architecture, criterion:implementation-merged" required>
          <datalist id="subj">${[...subjects, ...((S.status?.goal?.acceptanceCriteria || []).map((c) => `criterion:${c.id}`))].map((s) => `<option>${esc(s)}</option>`).join("")}</datalist></div>
        <div class="field"><label>evidence artifact (optional)</label><input id="appr-artifact" list="arts"><datalist id="arts">${arts.map((a) => `<option value="${esc(a.id)}">${esc(a.type)} · ${esc(a.name)} v${a.version}</option>`).join("")}</datalist></div>
        <div class="field"><label>comment</label><input id="appr-comment" class="txt" placeholder="rationale / evidence pointer"></div>
        <div class="row"><button class="primary" type="submit">record decision</button><span id="appr-out" class="muted"></span></div>
      </form>`);
    $("approval-form").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const { status, json } = await post("/approvals", {
        kind: $("appr-kind").value, subject: $("appr-subject").value,
        artifactId: $("appr-artifact").value.trim() || undefined, comment: $("appr-comment").value || undefined,
      });
      $("appr-out").textContent = status === 200 ? "recorded ✓" : `denied: ${json?.reason ?? status}`;
      if (status === 200) toast("approval recorded", `${$("appr-kind").value} ${$("appr-subject").value}`, "ok");
      void refreshStatus();
    });
  }
}

/* -------------------------------------------------------------- data caches */
let lastRefresh = 0;
async function getArtifacts() {
  if (Date.now() - lastRefresh > 4000 || !S.artifacts) {
    const { json } = await api("GET", "/artifacts");
    S.artifacts = Array.isArray(json) ? json : [];
    lastRefresh = Date.now();
  }
  return S.artifacts;
}

async function refreshStatus() {
  const { json } = await api("GET", "/status");
  if (!json) return;
  S.status = json;
  S.goalId = json.goal?.id ?? S.goalId;
  updateTopbar();
}

/* ------------------------------------------------------------ event helpers */
function evClass(type) {
  const p = String(type).split(".")[0];
  return { goal: "t-goal", agent: "t-agent", message: type === "message.rejected" ? "t-bad" : "t-message", artifact: "t-artifact", budget: "t-budget", review: "t-review", task: "t-task", patch: "t-artifact", release: "t-artifact", escalation: "t-escalation", lease: "t-lease", requirements: "t-artifact", requirement: "t-artifact", architecture: "t-review", design: "t-message", dependency: "t-artifact", authentication: "t-artifact", authorization: "t-artifact", research: "t-artifact", implementation: "t-review", decision: "t-review", memory: "t-agent", human: "t-message" }[p] || "";
}
function evSummary(e) {
  const p = e.payload || {};
  if (typeof p.summary === "string" && p.summary) return esc(p.summary);
  switch (e.type) {
    case "message.sent": return `${p.message?.from} -> ${(p.message?.to || []).join(", ")} <b>${esc(p.message?.type)}</b>${p.message?.artifactRefs?.length ? ` <span class="chip">${esc(p.message.artifactRefs.map((r) => shortUri(r.uri)).join(", "))}</span>` : ""}`;
    case "message.rejected": return `${esc(p.from || e.actorId || "")} <span class="muted">${esc(String(p.reason || "").slice(0, 110))}</span>`;
    case "artifact.created": return `${esc(p.artifact?.type)} <b>${esc(p.artifact?.name)}</b> v${p.artifact?.version} by ${esc(p.artifact?.createdBy)}`;
    case "artifact.versioned": return `${esc(p.artifact?.name)} -> <b>v${p.artifact?.version}</b>`;
    case "artifact.transition": { const st = S.status?.agents?.find((a) => a.id === e.actorId); return `${esc(shortUri(p.artifactId))} -> <b>${esc(p.to)}</b>${p.derived ? ' <span class="muted">(derived)</span>' : ""}${st ? "" : ""}`; }
    case "agent.awakened": return `<b>${esc(p.agentId)}</b> <span class="muted">${esc(p.reason?.kind || "")} ${esc((p.reason?.note || p.reason?.eventType || "").slice(0, 60))}</span>`;
    case "agent.state_changed": return `${esc(p.agentId)} ${esc(p.to)}${p.note ? ` <span class="muted">${esc(String(p.note).slice(0, 60))}</span>` : ""}`;
    case "budget.consumed": return `${esc(shortKey(p.key))} <b>+${fmt(p.amount)}</b>${p.model ? ` <span class="muted">${esc(p.model)}</span>` : ""}`;
    case "budget.exceeded": return `${esc(shortKey(p.key))} <b>${fmt(p.consumed)}/${fmt(p.limit)}</b>`;
    case "escalation.requested": return `<b>${esc(p.escalation?.reason)}</b> <span class="muted">by ${esc(p.escalation?.raisedBy)}</span>`;
    case "escalation.responded": return `responded <span class="muted">${esc(String(p.response || "").slice(0, 60))}</span>`;
    case "goal.completed": return "mission complete 🏁";
    case "goal.escalated": return `<b>mission escalated</b> — ${esc(p.reason || "")}`;
    case "task.claimed": return `${esc(shortKey(p.taskId))} by <b>${esc(p.agentId)}</b>`;
    case "task.completed": return `${esc(shortKey(p.taskId))} <span class="muted">${esc(String(p.summary || "").slice(0, 60))}</span>`;
    case "review.approved": return `<b>${esc(p.subject || "")}</b>${p.artifactId ? ` ${esc(shortUri(p.artifactId))}` : ""} <span class="muted">by ${esc(e.actorId || "")}</span>`;
    case "review.rejected": return `<b>${esc(p.subject || "")}</b> rejected <span class="muted">by ${esc(e.actorId || "")}</span>`;
    case "lease.acquired": return `<span class="muted">write-lease</span> ${esc(shortUri(p.lease?.artifactId))} → ${esc(p.lease?.agentId || "")}`;
    case "lease.released": return `<span class="muted">lease released</span>`;
    case "thread.created": return `<span class="muted">${esc(String(p.thread?.subject || "").slice(0, 70))}</span>`;
    default: return e.actorId ? esc(e.actorId) : "";
  }
}
const shortUri = (u) => { const m = /artifact:\/\/([^/]+)\/([^/]+)/.exec(String(u || "")); return m ? `${decodeURIComponent(m[2])}·${m[1].slice(0, 4)}` : String(u || "").split("-").pop(); };
const shortKey = (k) => String(k || "").replace(/^(\w+):[^/]+\//, "$1:").replace(/goal-[A-Z0-9]+/i, (g) => g.slice(0, 9));

function ingestEvent(e) {
  if (S.eventSeqSeen.has(e.seq)) return;
  S.eventSeqSeen.add(e.seq);
  S.events.push(e);
  if (S.events.length > 600) { S.events.splice(0, S.events.length - 600); }
  if (e.type === "goal.completed") toast("goal completed", "all mandatory criteria evidenced", "ok");
  if (e.type === "goal.escalated") toast("mission escalated", String(e.payload?.reason || ""), "bad");
  if (e.type === "escalation.requested") toast("escalation opened", `${e.payload?.escalation?.reason} (by ${e.payload?.escalation?.raisedBy})`, "warn");
}

/* --------------------------------------------------------------- SSE client */
function connectSse() {
  try { S.sse?.close(); } catch { /* noop */ }
  const es = new EventSource("/events/stream");
  S.sse = es;
  es.onopen = () => { $("live-dot").classList.add("on"); };
  es.onerror = () => { $("live-dot").classList.remove("on"); };
  es.onmessage = (m) => {
    try { ingestEvent(JSON.parse(m.data)); } catch { /* ignore */ }
    livePatch();
  };
  // EventSource dispatches typed events too; ensure both paths feed ingest
  for (const t of ["message.sent", "artifact.created", "agent.awakened"]) {
    es.addEventListener(t, (m) => { try { ingestEvent(JSON.parse(m.data)); livePatch(); } catch { /* ignore */ } });
  }
}

let liveTimer = null;
function livePatch() {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => {
    if (S.view === "events") renderEventsIntoList();
    if (S.view === "overview") setView("overview"), void refreshStatus();
    else void refreshStatus();
  }, 250);
}

/* ------------------------------------------------------------------- router */
async function renderView() {
  const box = $("view");
  const v = S.view;
  box.innerHTML = `<div class="empty"><div class="big">…</div><div>loading ${esc(v)}</div></div>`;
  try {
    if (v === "overview") return renderOverview(box);
    if (v === "agents") return renderAgents(box);
    if (v === "graph") return renderGraph(box);
    if (v === "events") return renderEvents(box);
    if (v === "artifacts") return renderArtifacts(box);
    if (v === "cost") return renderCost(box);
    if (v === "escalations") return renderEscalations(box);
    if (v === "designer") return renderDesigner(box);
    box.innerHTML = `<div class="empty">unknown view</div>`;
  } catch (err) {
    box.innerHTML = `<div class="empty"><div class="big">⚠</div><div>${esc(err.message)}</div></div>`;
  }
}

/* ----------------------------------------------------------------- OVERVIEW */
async function renderOverview(box) {
  const st = S.status || (await api("GET", "/status")).json;
  S.status = st;
  const { json: metrics } = await api("GET", "/metrics");
  S.metrics = metrics;
  updateTopbar();
  const goal = st?.goal || {};
  const crit = goal.acceptanceCriteria || [];
  const mandatory = crit.filter((c) => c.mandatory);
  const done = mandatory.filter((c) => c.status !== "UNSATISFIED").length;
  const mission = (st?.budgets || []).find((b) => b.key.startsWith("mission:") && b.limitKind === "tokens");
  const pct = mandatory.length ? Math.round((done / mandatory.length) * 100) : 0;
  const active = (st.agents || []).filter((a) => a.id !== "human" && RUNNING.has(a.lifecycle));
  const waiting = (st.agents || []).filter((a) => a.id !== "human" && a.lifecycle === "WAITING");
  const escOpen = (st.openEscalations || []);
  box.innerHTML = `
    <div class="view-title"><h2>Overview</h2><span class="pill ${pillCls(goal.status)}">${esc(goal.status || "-")}</span></div>
    ${st.uiOnly ? '<div class="card banner" style="margin-bottom:12px"><b>Parked console.</b> <span class="muted">Nothing runs on its own — but the <b>wake</b> buttons still run one manual turn (great for stepping), and starting the mission makes it fully live. <button class="banner-act" data-boot>▶ start mission</button> <button class="banner-act" data-go="designer">designer</button></span></div>' : banner(goal.status || "", escOpen.length, active.length, waiting.length)}
    <div class="grid kpis">
      <div class="card kpi"><small>mission progress</small><b>${pct}%</b><div class="progress"><div style="width:${pct}%"></div></div><div class="delta">${done}/${mandatory.length} mandatory criteria evidenced</div></div>
      <div class="card kpi"><small>tokens</small><b>${fmt(mission?.consumed ?? 0)}</b><div class="delta">of ${fmt(mission?.limit ?? 0)} budget · ${mission ? Math.round(((mission.consumed / (mission.limit || 1)) * 100)) : 0}%</div></div>
      <div class="card kpi"><small>events</small><b>${st.eventCount}</b><div class="delta">${metrics?.metrics?.messages ?? 0} messages · ${metrics?.metrics?.activations ?? 0} activations</div></div>
      <div class="card kpi"><small>agents</small><b>${active.length}<span class="muted" style="font-size:14px"> running</span></b><div class="delta">${waiting.length} waiting · ${st.agents.length - 1} seats</div></div>
      <div class="card kpi"><small>escalations</small><b style="color:${escOpen.length ? "var(--bad)" : "var(--ok)"}">${escOpen.length}</b><div class="delta">${metrics?.metrics?.approvals ?? 0} approvals · ${metrics?.metrics?.rejections ?? 0} rejections</div></div>
    </div>
    <div class="grid two" style="margin-top:12px">
      <div class="card"><h3>Goal &amp; acceptance criteria</h3>
        <p style="margin:0 0 10px">${esc((goal.description || "").replace(/\n+/g, " "))}</p>
        <div id="crit-list">${crit.map(critRow).join("") || '<div class="muted">no criteria declared</div>'}</div>
      </div>
      <div class="card"><h3>Live feed <span class="muted" style="float:right;text-transform:none">last ${Math.min(14, S.events.length)} events</span></h3>
        <div class="ev-list" id="ov-feed">${S.events.slice(-14).reverse().map(evRow).join("") || '<div class="muted">waiting for events…</div>'}</div>
      </div>
    </div>
    <div class="card" style="margin-top:12px"><h3>Agents at a glance</h3>
      <div class="grid agents">${(st.agents || []).filter((a) => a.id !== "human").map(agentCard).join("")}</div>
    </div>`;
  bindAgentCards();
  const ra = $("view").querySelector("[data-resume]"); if (ra) ra.addEventListener("click", () => { $("btn-resume").click(); });
  const ga = $("view").querySelector("[data-go]"); if (ga) ga.addEventListener("click", () => setView(ga.dataset.go));
  const rp = $("view").querySelector("[data-replay]"); if (rp) rp.addEventListener("click", async () => {
    const { json } = await api("GET", `/goals/${encodeURIComponent(S.goalId)}/replay`);
    openDrawer(`<h2>Deterministic replay <button class="close-x">×</button></h2><p class="muted">rebuilt from ${json?.eventCount ?? 0} events with zero model calls</p><pre>${esc(JSON.stringify({ goal: json?.goal?.status, agents: json?.agents?.map((a) => [a.agentId, a.lifecycle]), artifacts: json?.artifacts?.length, budgets: json?.budgets }, null, 1))}</pre>`);
  });
  const bt = $("view").querySelector("[data-boot]");
  if (bt) bt.addEventListener("click", async () => {
    bt.disabled = true;
    const { status, json } = await post("/mission/start");
    toast(status === 200 ? "mission started" : "could not start", json?.note ?? json?.error ?? "scheduler live", status === 200 ? "ok" : "bad");
    await refreshStatus();
    setView("overview");
  });
}
function banner(status, openEsc, active, waiting) {
  let msg = null;
  if (status === "ESCALATED") msg = { k: "bad", t: "Mission escalated.", a: "Review & respond in Escalations to unblock it → " };
  else if (status === "PAUSED") msg = { k: "warn", t: "Mission paused — agents are idle.", a: "Resume when ready. " };
  else if (status === "COMPLETED") msg = { k: "ok", t: "Mission complete — every mandatory criterion is evidenced by artifacts.", a: "Replay the run: " };
  else if (status === "FAILED") msg = { k: "bad", t: "Mission failed.", a: "" };
  else if (active === 0 && waiting === 0 && openEsc === 0 && status === "ACTIVE") msg = { k: "", t: "All agents asleep.", a: "Wake one, send it a message, or run the demo. " };
  if (!msg) return "";
  const acts =
    status === "ESCALATED" ? `<a class="banner-act" data-go="escalations">open Escalations</a>` :
    status === "PAUSED" ? `<button class="banner-act" data-resume>resume</button>` :
    status === "COMPLETED" ? `<button class="banner-act" data-replay>replay this goal</button>` : "";
  return `<div class="card banner ${msg.k}" style="margin-bottom:12px">${msg.t} <span class="muted">${msg.a}</span> ${acts}</div>`;
}
function critRow(c) {
  const icon = c.status === "EVIDENCED" ? "✔" : c.status === "WAIVED" ? "◌" : "○";
  return `<div class="crit ${c.status}"><span class="icon">${icon}</span><div class="desc"><b>${esc(c.id)}</b>${c.mandatory ? "" : ' <span class="chip">optional</span>'}<small>${esc(c.description)}</small></div><span class="evcount" title="evidence items">${c.evidence?.length ?? 0} ev</span></div>`;
}
function evRow(e) {
  return `<div class="ev" data-seq="${e.seq}"><time>${hhmmss(e.timestamp)}</time><span class="seq">#${e.seq}</span><span class="type ${evClass(e.type)}">${esc(e.type)}</span><span class="summary">${evSummary(e)}</span></div>`;
}

/* ------------------------------------------------------------------- AGENTS */
function agentCard(a) {
  const run = RUNNING.has(a.lifecycle);
  const color = { architect: "#8fa7ff", developer: "#43d6a0", qa: "#f0b429", security: "#f0717f", "tech-lead": "#56b6c2", pm: "#c792ea", explorer: "#7fdbca" }[a.role] || "var(--accent)";
  return `<div class="card agent-card" data-agent="${esc(a.id)}">
    <div class="agent-head"><span class="avatar" style="background:${color}22;color:${color};border:1px solid ${color}55">${esc(a.id[0].toUpperCase())}</span>
      <div style="min-width:0"><b>${esc(a.id)}</b><div class="role">${esc(a.role)}</div></div>
      <span class="row-actions"><button data-act="wake" data-id="${esc(a.id)}">wake</button>${a.lifecycle === "SUSPENDED" ? `<button data-act="resume" data-id="${esc(a.id)}">resume</button>` : `<button data-act="suspend" data-id="${esc(a.id)}">suspend</button>`}</span></div>
    <div><span class="pill ${pillCls(a.lifecycle)}${run ? " running-pulse" : ""}">${esc(a.lifecycle)}</span></div>
    <div class="agent-meta"><span title="tokens">◲ ${fmt(a.tokens)}</span><span title="unread mail">✉ ${a.mailbox}</span>${a.taskId ? `<span title="active task" class="mono">⚙ ${esc(String(a.taskId).slice(0, 10))}</span>` : ""}</div>
  </div>`;
}
async function renderAgents(box) {
  const st = S.status || (await api("GET", "/status")).json;
  S.status = st;
  box.innerHTML = `<div class="view-title"><h2>Agents</h2><span class="muted">${st.agents.length - 1} seats + human</span></div>
    <div class="grid agents">${st.agents.filter((a) => a.id !== "human").map(agentCard).join("")}</div>`;
  bindAgentCards();
}
function bindAgentCards() {
  $$("#view .agent-card").forEach((card) => card.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-act]");
    if (btn) { void agentAction(btn.dataset.id, btn.dataset.act); ev.stopPropagation(); return; }
    void agentDrawer(card.dataset.agent);
  }));
}
async function agentAction(id, act) {
  const { status, json } = await post(`/agents/${encodeURIComponent(id)}/${act}`);
  if (status === 200) toast(act, `${id}: ok`, "ok");
  else toast(`${act} blocked`, `${id}: ${json?.reason ?? "denied"}`, "warn");
  setTimeout(() => void renderView(), 400);
}
async function agentDrawer(id) {
  const { json } = await api("GET", `/agents/${encodeURIComponent(id)}`);
  if (!json || json.error) return toast("agent", json?.error || "not found", "bad");
  const d = json.definition, s = json.state;
  openDrawer(`
    <h2><span class="avatar" style="background:var(--accent)22;color:var(--accent);border:1px solid var(--accent)55">${esc(id[0].toUpperCase())}</span>${esc(id)}
      <span class="pill ${pillCls(s.lifecycle)}${RUNNING.has(s.lifecycle) ? " running-pulse" : ""}">${esc(s.lifecycle)}</span>
      <button class="close-x">×</button></h2>
    <div class="row" style="margin:8px 0 4px">
      <button class="small" onclick="void 0" id="dw-wake">wake</button>
      <button class="small" id="dw-suspend">suspend</button>
      <button class="small" id="dw-resume">resume</button>
    </div>
    <h4>Definition</h4>
    <table class="tbl">
      <tr><td>role</td><td class="mono">${esc(d.role)}</td></tr>
      <tr><td>runtime</td><td class="mono">${esc(d.runtime)}${d.model ? " · " + esc(d.model) : ""}</td></tr>
      <tr><td>mode</td><td class="mono">${esc(d.mode)}${d.mode === "service" ? " <span class='muted'>(request-only activation, cached answers)</span>" : ""}</td></tr>
      <tr><td>capabilities</td><td>${(d.capabilities || []).map((c) => `<span class="chip">${esc(c)}</span>`).join("") || '<span class="muted">—</span>'}</td></tr>
      <tr><td>authority</td><td>${(d.authority || []).map((c) => `<span class="chip hot">${esc(c)}</span>`).join("") || '<span class="muted">—</span>'}</td></tr>
      <tr><td>interests</td><td>${(d.interests || []).map((c) => `<span class="chip">${esc(c)}</span>`).join("") || '<span class="muted">—</span>'}</td></tr>
      <tr><td>delegation</td><td class="mono">${d.delegationPolicy?.allowDelegation ? `depth ${d.delegationPolicy.maxDepth}, ${d.delegationPolicy.maxWorkers} workers` : "not allowed"}</td></tr>
      <tr><td>budget</td><td class="mono">${fmt(d.budget?.tokens ?? 0)} tokens</td></tr>
    </table>
    <h4>Runtime state</h4>
    <table class="tbl">
      <tr><td>tokens consumed</td><td class="mono">${fmt(s.tokensConsumed)}</td><td>activations</td><td class="mono">${s.activations}</td></tr>
      <tr><td>session</td><td class="mono">${esc(json.session?.sessionId ?? "(none)")}</td><td>runtime</td><td class="mono">${esc(json.session?.runtime ?? "-")}</td></tr>
      <tr><td>last activity</td><td class="mono">${esc(ago(s.lastActivityAt))}</td><td>active task</td><td class="mono">${esc(s.activeTaskId ?? "-")}</td></tr>
      ${s.lastError ? `<tr><td>last error</td><td colspan="3" style="color:var(--bad)">${esc(s.lastError)}</td></tr>` : ""}
    </table>
    <h4>Memory (L2)</h4>
    ${json.memory?.length ? json.memory.map((m) => `<div style="margin:4px 0"><span class="chip">${esc(m.key)}</span> <span class="muted" style="font-size:12px">${esc(m.value.slice(0, 160))}</span></div>`).join("") : '<div class="muted">nothing remembered yet</div>'}
    <h4>Unread mail</h4>
    ${json.unread?.length ? json.unread.map((mid) => `<div style="margin:4px 0"><span class="chip mono">${esc(mid)}</span></div>`).join("") : '<div class="muted">mailbox empty</div>'}`);
  $("dw-wake").addEventListener("click", () => void agentAction(id, "wake"));
  $("dw-suspend").addEventListener("click", () => void agentAction(id, "suspend"));
  $("dw-resume").addEventListener("click", () => void agentAction(id, "resume"));
}

/* -------------------------------------------------------------------- GRAPH */
async function renderGraph(box) {
  const { json } = await api("GET", "/graph");
  S.graph = json;
  const kinds = ["REQUEST", "APPROVE", "BLOCK", "ESCALATE", "INFORM", "OTHER"];
  const recentFlows = new Set(S.events.slice(-40).filter((e) => e.type === "message.sent").map((e) => `${e.payload?.message?.from}|${e.payload?.message?.to?.join(",")}`));
  box.innerHTML = `
    <div class="view-title"><h2>Collaboration graph</h2><span class="muted">live edges from the event stream</span></div>
    <div class="card graph-wrap">
      <svg id="graph-svg" role="img" aria-label="mesh graph"></svg>
      <div class="legend" style="margin-top:8px">${kinds.map((k) => `<span><b style="background:var(--${{ REQUEST: "accent", APPROVE: "ok", BLOCK: "bad", ESCALATE: "warn", INFORM: "info", OTHER: "line-strong" }[k]})"></b>${k}</span>`).join("")}</div>
    </div>`;
  const svg = $("graph-svg");
  const nodes = json.nodes.filter((n) => n.id !== "human");
  const human = json.nodes.find((n) => n.id === "human");
  const W = svg.clientWidth || 900, H = svg.clientHeight || 480, cx = W / 2, cy = H / 2;
  const R = Math.min(W, H) / 2 - 60;
  const pos = {};
  const n = Math.max(nodes.length, 1);
  nodes.forEach((nd, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    pos[nd.id] = { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a), nd };
  });
  let out = "<defs><marker id='ar' viewBox='0 0 8 8' refX='7' refY='4' markerWidth='5' markerHeight='5' orient='auto'><path d='M0 0L8 4L0 8z' fill='context-stroke'/></marker></defs>";
  for (const e of json.edges) {
    const p = pos[e.from], q = pos[e.to];
    if (!p || !q) continue;
    const dx = q.x - p.x, dy = q.y - p.y, dist = Math.hypot(dx, dy) || 1;
    const sx = p.x + (dx / dist) * 26, sy = p.y + (dy / dist) * 26;
    const ex = q.x - (dx / dist) * 30, ey = q.y - (dy / dist) * 30;
    const mx = (sx + ex) / 2 + dy * 0.14, my = (sy + ey) / 2 - dx * 0.14;
    const flow = [...recentFlows].some((f) => f.startsWith(`${e.from}|`) && f.includes(e.to)) ? " flowing" : "";
    out += `<path class="edge ${esc(e.kind)}${flow}" d="M ${sx} ${sy} Q ${mx} ${my} ${ex} ${ey}" marker-end="url(#ar)" stroke-width="${Math.min(4, 1 + e.count * 0.4)}"><title>${esc(e.from)} ${esc(e.kind)} ${esc(e.to)} ×${e.count}</title></path>`;
  }
  for (const id of Object.keys(pos)) {
    const { x, y, nd } = pos[id];
    const cls = RUNNING.has(nd.lifecycle) ? "active" : nd.lifecycle === "WAITING" ? "waiting" : "";
    out += `<g class="gn" data-id="${esc(id)}" style="cursor:pointer"><circle class="node ${cls}" cx="${x}" cy="${y}" r="18"></circle>
      <text x="${x}" y="${y + 4}" text-anchor="middle" style="font:600 11px var(--mono);fill:var(--text)">${esc(id.slice(0, 2).toUpperCase())}</text>
      <text x="${x}" y="${y + 34}" text-anchor="middle">${esc(id)}</text>
      <text class="dim" x="${x}" y="${y - 26}" text-anchor="middle">${esc(nd.lifecycle)} · ${fmt(nd.tokens)}t</text></g>`;
  }
  svg.innerHTML = out;
  svg.addEventListener("click", (ev) => { const g = ev.target.closest(".gn"); if (g) void agentDrawer(g.dataset.id); });
}

/* ------------------------------------------------------------------- EVENTS */
const EV_GROUP = (t) => String(t).split(".")[0];
async function renderEvents(box) {
  if (!S.events.length) {
    const { json } = await api("GET", "/events?limit=300");
    for (const e of (json || [])) ingestEvent({ seq: e.seq, type: e.type, timestamp: e.at, actorId: e.actor, payload: { summary: e.summary } });
  }
  const groups = [...new Set(S.events.map((e) => EV_GROUP(e.type)))].sort();
  box.innerHTML = `
    <div class="view-title"><h2>Event stream</h2><span class="muted">append-only log · SSE live · <button class="small" id="autoscroll">${S.autoScroll ? "⦿ auto-scroll" : "○ auto-scroll off"}</button></span></div>
    <div class="card">
      <div class="ev-filters">
        <input class="search" id="ev-search" placeholder="search… (press /)" value="${esc(S.evSearch)}">
        ${groups.map((g) => `<button class="fchip ${!S.evFilter || S.evFilter === g ? "on" : ""}" data-g="${esc(g)}">${esc(g)}·*</button>`).join("")}
      </div>
      <div class="ev-list" id="ev-list"></div>
    </div>`;
  $("autoscroll").addEventListener("click", () => { S.autoScroll = !S.autoScroll; void renderView(); });
  $("ev-search").addEventListener("input", (ev) => { S.evSearch = ev.target.value; renderEventsIntoList(); });
  for (const b of $$("#view .fchip")) b.addEventListener("click", () => { S.evFilter = S.evFilter === b.dataset.g ? "" : b.dataset.g; void renderView(); });
  $("ev-list").addEventListener("click", (ev) => { const row = ev.target.closest(".ev"); if (row) eventDrawer(Number(row.dataset.seq)); });
  renderEventsIntoList();
}
function renderEventsIntoList() {
  const list = $("ev-list");
  if (!list) return;
  const q = S.evSearch.toLowerCase();
  const rows = S.events.slice().reverse().filter((e) =>
    (!S.evFilter || EV_GROUP(e.type) === S.evFilter) &&
    (!q || (e.type + " " + (e.actorId || "") + " " + JSON.stringify(e.payload || {}).slice(0, 400)).toLowerCase().includes(q)),
  ).slice(0, 260);
  list.innerHTML = rows.map(evRow).join("") || '<div class="muted" style="padding:20px">no matching events</div>';
  if (S.autoScroll) window.requestAnimationFrame(() => {});
}
function eventDrawer(seq) {
  const e = S.events.find((x) => x.seq === seq);
  if (!e) return;
  openDrawer(`<h2><span class="type ${evClass(e.type)}">${esc(e.type)}</span><button class="close-x">×</button></h2>
    <div class="muted mono">seq #${e.seq} · ${esc(e.timestamp)} · actor ${esc(e.actorId ?? "-")}</div>
    <pre>${esc(JSON.stringify(e, null, 2))}</pre>`);
}

/* ---------------------------------------------------------------- ARTIFACTS */
async function renderArtifacts(box) {
  const arts = (await getArtifacts()).slice().reverse();
  box.innerHTML = `
    <div class="view-title"><h2>Artifacts</h2><span class="muted">immutable versions · owner = single writer</span></div>
    <div class="card" style="padding:6px 0"><table class="tbl"><tr><th>name</th><th>type</th><th>ver</th><th>state</th><th>owner</th><th>age</th></tr>
    ${arts.map((a) => `<tr class="clickable" data-art="${esc(a.id)}"><td><b>${esc(a.name)}</b></td><td class="muted">${esc(a.type)}</td><td class="mono">v${a.version}</td>
      <td><span class="pill ${["APPROVED", "VERIFIED", "MERGEABLE", "MERGED", "FINAL", "ACCEPTED", "QA_VERIFIED", "SECURITY_VERIFIED"].includes(a.status) ? "completed" : a.status === "REJECTED" ? "failed" : a.status === "UNDER_REVIEW" ? "waiting" : "idle"}">${esc(a.status)}</span></td>
      <td class="mono">${esc(a.owner)}</td><td class="muted">${esc(ago(a.createdAt))}</td></tr>`).join("") || '<tr><td colspan="6"><div class="empty"><div class="big">▤</div>no artifacts yet</div></td></tr>'}
    </table></div>`;
  $$("#view tr[data-art]").forEach((tr) => tr.addEventListener("click", () => void artifactDrawer(tr.dataset.art)));
}
async function artifactDrawer(id) {
  const a = (await getArtifacts()).find((x) => x.id === id);
  if (!a) return;
  const { json: versions } = await api("GET", `/artifacts/${encodeURIComponent(id)}/versions`);
  const content = await getText(`/artifacts/${encodeURIComponent(id)}/content`);
  openDrawer(`<h2>${esc(a.name)} <span class="muted" style="font-weight:400;font-size:13px">v${a.version} · ${esc(a.type)}</span><span class="pill ${["MERGED", "ACCEPTED", "APPROVED", "FINAL", "VERIFIED", "MERGEABLE", "QA_VERIFIED", "SECURITY_VERIFIED"].includes(a.status) ? "completed" : a.status === "REJECTED" ? "failed" : "idle"}">${esc(a.status)}</span><button class="close-x">×</button></h2>
    <div class="muted mono" style="margin-bottom:6px">id ${esc(a.id)} · owner ${esc(a.owner)} · digest ${esc(String(a.digest).slice(0, 18))}… · provenance ${esc(a.provenance?.source ?? "agent")} (${esc(a.provenance?.trustLevel ?? 50)})</div>
    <div class="muted" style="font-size:12px;margin-bottom:8px">lineage: ${(versions || []).map((v) => `v${v.version}[${v.status}]`).join(" → ")}</div>
    <h4>content</h4><pre>${esc(content.slice(0, 8000))}${content.length > 8000 ? "… truncated" : ""}</pre>`);
}

/* --------------------------------------------------------------------- COST */
async function renderCost(box) {
  const [{ json: budgets }, { json: st }] = await Promise.all([api("GET", "/budgets"), api("GET", "/status")]);
  S.status = st;
  const cost = budgets?.cost || { perAgent: [], missionTokens: 0, missionBudget: 0 };
  const max = Math.max(1, ...cost.perAgent.map((p) => p.tokens));
  const pct = cost.missionBudget ? Math.round((cost.missionTokens / cost.missionBudget) * 100) : 0;
  const models = budgets?.models || {};
  const modelList = Object.entries(models).sort((a, b) => b[1].tokens - a[1].tokens);
  box.innerHTML = `
    <div class="view-title"><h2>Cost accounting</h2><span class="muted">every reservation/consumption is an event</span></div>
    <div class="grid kpis" style="margin-bottom:12px">
      <div class="card kpi"><small>mission</small><b>${fmt(cost.missionTokens)}</b><div class="progress"><div style="width:${Math.min(100, pct)}%"></div></div><div class="delta">${pct}% of ${fmt(cost.missionBudget)}</div></div>
      <div class="card kpi"><small>model calls</small><b>${modelList.reduce((s, [, v]) => s + v.calls, 0)}</b><div class="delta">${modelList.length ? modelList.map(([m, v]) => `${esc(m)} (${fmt(v.tokens)}t)`).join(" · ") : "no model turns yet"}</div></div>
    </div>
    <div class="card"><h3>Per agent</h3>
      ${cost.perAgent.filter((p) => p.agentId !== "human").sort((a, b) => b.tokens - a.tokens).map((p) => `
        <div class="bar-row"><span class="lbl">${esc(p.agentId)} <span class="muted">· ${p.activations} act</span></span>
          <div class="track"><div style="width:${Math.round((p.tokens / max) * 100)}%"></div></div>
          <span class="num">${fmt(p.tokens)} t</span></div>`).join("") || '<div class="muted">no spend yet</div>'}
    </div>
    <div class="card" style="margin-top:12px"><h3>Budget ledger</h3><table class="tbl"><tr><th>key</th><th>kind</th><th>consumed</th><th>reserved</th><th>limit</th><th>state</th></tr>
      ${(budgets?.entries || []).map((b) => `<tr><td class="mono">${esc(b.key)}</td><td>${esc(b.limitKind)}</td><td class="mono">${fmt(b.consumed)}</td><td class="mono">${fmt(b.reserved)}</td><td class="mono">${b.limit === null ? "—" : fmt(b.limit)}</td><td>${b.exceeded ? '<span class="pill failed">EXCEEDED</span>' : '<span class="pill idle">ok</span>'}</td></tr>`).join("")}
    </table></div>`;
}

/* ------------------------------------------------------------ ESCALATIONS */
async function renderEscalations(box) {
  const { json } = await api("GET", "/escalations");
  S.escalations = json || [];
  const open = S.escalations.filter((e) => e.status === "OPEN");
  box.innerHTML = `
    <div class="view-title"><h2>Escalations</h2><span class="muted">human is a seat in the mesh, not an external override</span></div>
    ${S.escalations.length ? S.escalations.slice().reverse().map((e) => `
      <div class="card esc-card ${e.status === "OPEN" ? "" : "responded"}" style="margin-bottom:10px">
        <div class="row"><b>${esc(e.reason)}</b><span class="pill ${e.status === "OPEN" ? "failed" : "completed"}">${esc(e.status)}</span><span class="muted mono" style="margin-left:auto">${esc(e.id)}</span></div>
        <div class="muted" style="margin:6px 0">${esc(e.raisedBy)} · ${esc(ago(e.createdAt))}${e.conflictKey ? ` · conflict <code>${esc(e.conflictKey)}</code>` : ""}</div>
        ${e.detail ? `<pre style="max-height:120px;overflow:auto">${esc(JSON.stringify(e.detail, null, 1).slice(0, 1200))}</pre>` : ""}
        ${e.status === "OPEN" ? `
        <form class="respond-form" data-id="${esc(e.id)}" id="respond-form-${esc(e.id)}">
          <div class="row" style="margin-top:8px"><input class="txt" style="flex:1" placeholder="operator response… (this wakes the raiser)" required><button class="primary" type="submit">respond</button></div>
        </form>` : `<div class="muted" style="margin-top:6px">✔ ${esc(e.response || "")} ${e.respondedAt ? `· ${esc(ago(e.respondedAt))}` : ""}</div>`}
      </div>`).join("")
      : `<div class="card"><div class="empty"><div class="big">⚑</div><div>no escalations — the mesh is converging on its own.<br><span class="muted">Escalations appear on budget exhaustion, stalemate (deadlock detector), runtime failure, or an agent asking via <code>mesh_escalate</code>.</span></div></div></div>`}`;
  for (const f of $$("#view form.respond-form")) {
    f.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const text = f.querySelector("input").value.trim();
      const { status } = await post(`/escalations/${encodeURIComponent(f.dataset.id)}/respond`, { response: text });
      toast(status === 200 ? "responded" : "failed", `${f.dataset.id}`, status === 200 ? "ok" : "bad");
      void renderEscalations($("view"));
      void refreshStatus();
    });
  }
}

/* ----------------------------------------------------------------- DESIGNER */
function designerTemplate() {
  return {
    version: 1,
    mesh: { id: "my-mesh", name: "My Mesh", goal: "Describe the mission goal here.", workspace: { path: "./workspace" }, runtime: { default: "stub" } },
    startup: { activate: ["architect"] },
    agents: {
      architect: { role: "architect", capabilities: ["repository.read", "architecture.write", "review.design"], authority: ["architecture.approve"], interests: ["architecture.*", "design.question"], session: { persistent: true }, budget: { tokens: 300000 } },
      developer: { role: "developer", capabilities: ["repository.read", "repository.write", "test.execute", "git.commit"], interests: ["architecture.approved", "review.rejected"], budget: { tokens: 700000 } },
      qa: { role: "qa", capabilities: ["test.execute", "test.write"], authority: ["quality.block"], interests: ["patch.ready", "release.candidate"], budget: { tokens: 200000 } },
    },
    policies: { communication: { architect: { may_contact: ["developer", "qa"] }, developer: { may_contact: ["architect", "qa"] }, qa: { may_contact: ["architect", "developer"] } }, transitions: { "patch.merge": { requires: ["architect.approve"] } }, escalation: { thread: { max_depth: 8 }, repeated_conflict: { threshold: 3 }, artifact_review_rounds: { max: 5 } } },
    budgets: { mission: { tokens: 2000000, wall_clock_minutes: 240, max_events: 10000 }, thread: { tokens: 50000 } },
    scheduling: { mode: "event-driven", activation: { strategy: "interest" }, concurrency: { max_active_agents: 4 } },
    server: { port: 7420 },
  };
}
const dmodel = () => S.designer.model;
function densure() {
  const m = dmodel();
  m.mesh ||= {}; m.mesh.workspace ||= { path: "./workspace" }; m.mesh.runtime ||= { default: "stub" };
  m.startup ||= { activate: [] }; m.agents ||= {}; m.policies ||= {};
  m.policies.communication ||= {}; m.policies.transitions ||= {};
  m.policies.escalation ||= { thread: { max_depth: 8 }, repeated_conflict: { threshold: 3 }, artifact_review_rounds: { max: 5 } };
  m.budgets ||= { mission: { tokens: 2000000, wall_clock_minutes: 240, max_events: 10000 }, thread: { tokens: 50000 } };
  m.scheduling ||= { mode: "event-driven", activation: { strategy: "interest" }, concurrency: { max_active_agents: 4 } };
}
function dtouch() {
  clearTimeout(S.designer.timer);
  S.designer.timer = setTimeout(dvalidate, 550);
}
async function dvalidate() {
  if (!dmodel()) return;
  const { status, json } = await post("/config/validate", { config: dmodel() });
  S.designer.lastResult = { status, json };
  dpaintOutput();
}
function dpaintOutput() {
  const out = $("d-out"); const yaml = $("d-yaml");
  if (!out) return;
  const r = S.designer.lastResult;
  if (!r) { out.innerHTML = '<div class="muted">editing…</div>'; return; }
  if (r.status === 200) {
    yaml.textContent = r.json.yaml;
    const s = r.json.summary;
    out.innerHTML = `<div class="verdict ok">valid · mesh “${esc(s.meshId)}” — ${s.agents.length} agents${s.services.length ? ` (${s.services.join(", ")} service)` : ""} · gates: ${s.gates.join(", ") || "none"}</div>` +
      (r.json.warnings?.length ? `<div class="verdict warn">${r.json.warnings.map(esc).join("<br>")}</div>` : "");
  } else {
    out.innerHTML = `<div class="verdict bad">${(r.json.errors || ["invalid"]).length} error(s)</div><ul class="errs">${(r.json.errors || []).map((e) => `<li>${esc(e)}</li>`).join("")}</ul>`;
  }
}
async function renderDesigner(box) {
  if (!S.vocab) { const { json } = await api("GET", "/config/vocabulary"); S.vocab = json || S.vocab; }
  if (!dmodel()) S.designer.model = designerTemplate(), densure(), S.designer.currentAgent = "architect";
  box.innerHTML = `<div class="view-title"><h2>Designer</h2><span class="muted">live server-side validation — same engine as <code>mesh validate</code></span></div>
    <div class="designer-cols">
      <div><div class="card" id="d-form"></div></div>
      <div>
        <div class="card">
          <div class="row" style="flex-wrap:wrap">
            <button class="small" id="d-load">load running</button>
            <button class="small" id="d-new">template</button>
            <button class="small" id="d-import">import yaml</button>
            <button class="primary" id="d-save" style="margin-left:auto">save mesh.yaml</button>
          </div>
          <div class="field" style="margin-top:8px"><label>save path</label><input class="txt" id="d-path" value="${esc(S.designer.savedTo)}"></div>
          <div id="d-out"></div>
          <textarea id="d-import-box" class="txt hidden" rows="8" placeholder="paste mesh.yaml…" style="margin-top:8px"></textarea>
          <button class="small hidden" id="d-import-go">apply import</button>
        </div>
        <div class="card" style="margin-top:12px"><h3 style="display:flex">YAML preview <span class="muted" style="text-transform:none;margin-left:6px" id="d-saveto"></span></h3><pre class="yaml-pane" id="d-yaml">…</pre></div>
      </div>
    </div>`;
  dpaintDesignerForm();
  $("d-load").addEventListener("click", async () => {
    const { json } = await api("GET", "/config");
    if (!json?.raw) return toast("designer", "no running config", "bad");
    S.designer.model = JSON.parse(JSON.stringify(json.raw)); densure();
    S.designer.savedTo = json.filePath || S.designer.savedTo;
    $("d-path").value = S.designer.savedTo;
    S.designer.currentAgent = Object.keys(S.designer.model.agents)[0];
    dpaintDesignerForm(); dtouch();
  });
  $("d-new").addEventListener("click", () => { S.designer.model = designerTemplate(); densure(); S.designer.currentAgent = "architect"; dpaintDesignerForm(); dtouch(); });
  $("d-import").addEventListener("click", () => { $("d-import-box").classList.toggle("hidden"); $("d-import-go").classList.toggle("hidden"); });
  $("d-import-go").addEventListener("click", async () => {
    const { status, json } = await post("/config/parse", { yaml: $("d-import-box").value });
    if (status !== 200) return toast("parse failed", (json.errors || []).join("; ").slice(0, 200), "bad");
    S.designer.model = json.config; densure(); S.designer.currentAgent = Object.keys(S.designer.model.agents)[0];
    $("d-import-box").classList.add("hidden"); $("d-import-go").classList.add("hidden");
    dpaintDesignerForm(); dtouch();
  });
  $("d-save").addEventListener("click", async () => {
    const path = $("d-path").value.trim();
    const { status, json } = await post("/config/save", { config: dmodel(), path });
    if (status === 200) {
      S.designer.savedTo = json.savedTo;
      toast("saved", `${json.savedTo} — start it with: npm run mesh -- run ${json.savedTo}`, "ok");
      $("d-saveto").textContent = json.savedTo;
    } else toast("save failed", (json?.errors || ["invalid"]).join("; ").slice(0, 240), "bad");
  });
  $("d-path").addEventListener("change", (ev) => { S.designer.savedTo = ev.target.value; });
  dtouch();
}
function dpaintDesignerForm() {
  const host = $("d-form"); if (!host || !dmodel()) return;
  const m = dmodel();
  const ids = Object.keys(m.agents);
  const cur = ids.includes(S.designer.currentAgent) ? S.designer.currentAgent : ids[0];
  S.designer.currentAgent = cur;
  const a = m.agents[cur] || {};
  const caps = ["repository.read", "repository.write", "architecture.write", "architecture.read", "review.design", "code.review", "task.assign", "test.execute", "test.write", "security.scan", "security.review", "git.commit", "git.merge", "shell.execute", "network.request"];
  const ints = [...new Set([...(S.vocab?.eventTypes || ["patch.ready", "architecture.approved", "goal.escalated"]), ...(S.vocab?.eventTypes || []).map((t) => t.split(".")[0] + ".*")])];
  host.innerHTML = `
    <h3>Mission</h3>
    <div class="grid2">
      <div class="field"><label>mesh id</label><input class="txt" data-m="mesh.id" value="${esc(m.mesh.id)}"></div>
      <div class="field"><label>display name</label><input class="txt" data-m="mesh.name" value="${esc(m.mesh.name || "")}"></div>
    </div>
    <div class="field"><label>goal</label><textarea class="txt" data-m="mesh.goal" rows="2">${esc(m.mesh.goal || "")}</textarea></div>
    <div class="grid3">
      <div class="field"><label>default runtime</label><select class="sel" data-m="mesh.runtime.default"><option ${m.mesh.runtime?.default === "opencode" ? "selected" : ""}>opencode</option><option ${m.mesh.runtime?.default !== "opencode" ? "selected" : ""}>stub</option><option>http</option></select></div>
      <div class="field"><label>concurrency</label><input class="txt" type="number" min="1" data-m="scheduling.concurrency.max_active_agents" value="${m.scheduling?.concurrency?.max_active_agents ?? 4}"></div>
      <div class="field"><label>activation</label><select class="sel" data-m="scheduling.activation.strategy"><option value="interest">interest</option><option value="interest+triage" ${m.scheduling?.activation?.strategy === "interest+triage" ? "selected" : ""}>interest+triage</select></div>
    </div>
    <div class="section-h">acceptance criteria</div>
    <div id="d-crits">${(m.mesh.acceptance_criteria || []).map((c, i) => `
      <div class="row-edit"><input class="txt" data-c="id" data-i="${i}" value="${esc(c.id)}"><input class="txt" data-c="description" data-i="${i}" value="${esc(c.description)}">
      <label class="chk"><input type="checkbox" data-c="mandatory" data-i="${i}" ${c.mandatory !== false ? "checked" : ""}></label>
      <button class="small danger" data-cdel="${i}">✕</button></div>`).join("")}
      <button class="small" id="d-crit-add">+ criterion</button><div id="d-crit-default" class="muted" style="font-size:12px;margin-top:4px">${(m.mesh.acceptance_criteria || []).length ? "" : "none declared — the five default criteria are used"}</div></div>
    <div class="section-h">agents</div>
    <div class="row" style="flex-wrap:wrap">
      <select class="sel" id="d-agnet" style="flex:1">${ids.map((i) => `<option ${i === cur ? "selected" : ""}>${esc(i)}</option>`).join("")}</select>
      <button class="small" id="d-agent-add">+ add</button><button class="small" id="d-agent-dup">duplicate</button><button class="small danger" id="d-agent-del">delete</button>
    </div>
    ${cur ? `
    <div class="grid2" style="margin-top:10px">
      <div class="field"><label>id</label><input class="txt" id="d-a-id" value="${esc(cur)}"></div>
      <div class="field"><label>role</label><input class="txt" data-a="role" value="${esc(a.role || "")}"></div>
      <div class="field"><label>runtime (blank = mesh default)</label><input class="txt" data-a="runtime" value="${esc(a.runtime || "")}" placeholder="${esc(m.mesh.runtime?.default || "opencode")}"></div>
      <div class="field"><label>mode</label><select class="sel" data-a="mode"><option value="peer" ${a.mode !== "service" ? "selected" : ""}>peer</option><option value="service" ${a.mode === "service" ? "selected" : ""}>service</option></select></div>
      <div class="field"><label>prompt file (optional)</label><input class="txt" data-a="prompt" value="${esc(a.prompt || "")}" placeholder="../../roles/architect.md"></div>
      <div class="field"><label>token budget</label><input class="txt" type="number" step="10000" id="d-a-budget" value="${a.budget?.tokens ?? 200000}"></div>
    </div>
    <div class="field"><label>capabilities</label><input class="txt" id="d-a-caps" value="${esc((a.capabilities || []).join(", "))}"><div class="chips" style="margin-top:4px">${caps.map((c) => `<button class="chip-toggle ${(a.capabilities || []).includes(c) ? "on" : ""}" data-cap="${c}">${c}</button>`).join("")}</div></div>
    <div class="field" style="margin-top:8px"><label>authority</label><input class="txt" id="d-a-auth" value="${esc((a.authority || []).join(", "))}" placeholder="architecture.approve, quality.block…"></div>
    <div class="field" style="margin-top:8px"><label>interests (wake-on-event)</label><input class="txt" id="d-a-ints" value="${esc((a.interests || []).join(", "))}"><div class="chips" style="max-height:76px;overflow:auto;margin-top:4px">${ints.map((c) => `<button class="chip-toggle ${(a.interests || []).includes(c) ? "on" : ""}" data-int="${c}">${c}</button>`).join("")}</div></div>
    <div class="row" style="margin-top:8px;flex-wrap:wrap">
      <label class="chk"><input type="checkbox" id="d-a-persist" ${a.session?.persistent !== false ? "checked" : ""}> persistent session</label>
      <label class="chk"><input type="checkbox" id="d-a-deleg" ${a.delegation?.allow ? "checked" : ""}> delegation allowed</label>
      <label class="chk">workers ≤ <input class="txt" id="d-a-dw" type="number" min="0" max="4" value="${a.delegation?.max_workers ?? 0}" style="width:52px"> depth ≤ <input class="txt" id="d-a-dd" type="number" min="0" max="2" value="${a.delegation?.max_depth ?? 0}" style="width:52px"></label>
    </div>` : '<div class="muted" style="margin-top:8px">no agents — add one</div>'}
    <div class="section-h">who may start threads to whom</div>
    <div class="matrix-wrap"><table><tr><th></th>${ids.map((t) => `<th>${esc(t.length > 7 ? t.slice(0, 6) + "…" : t)}</th>`).join("")}</tr>
      ${ids.map((src) => `<tr><th>${esc(src)}</th>${ids.map((tgt) => `<td style="text-align:center"><input type="checkbox" data-mx="${esc(src)}|${esc(tgt)}" ${((m.policies.communication[src] || {}).may_contact || []).includes(tgt) ? "checked" : ""} ${src === tgt ? "disabled" : ""}></td>`).join("")}</tr>`).join("")}
    </table></div>
    <div class="section-h">gates &amp; limits</div>
    <div id="d-gates">${Object.entries(m.policies.transitions).map(([g, v], i) => `
      <div class="row-edit"><input class="txt" data-g="name" data-i="${i}" value="${esc(g)}" list="d-gnames"><input class="txt" data-g="requires" data-i="${i}" value="${esc((v.requires || []).join(", "))}" placeholder="tech-lead.approve, qa.pass"><span></span><button class="small danger" data-gdel="${i}">✕</button></div>`).join("")}
      <datalist id="d-gnames">${(S.vocab?.gateKinds || []).map((g) => `<option>${g}</option>`).join("")}</datalist>
      <button class="small" id="d-gate-add">+ gate</button></div>
    <div class="grid3" style="margin-top:10px">
      <div class="field"><label>thread depth</label><input class="txt" type="number" data-m="policies.escalation.thread.max_depth" value="${m.policies.escalation?.thread?.max_depth ?? 8}"></div>
      <div class="field"><label>conflict threshold</label><input class="txt" type="number" data-m="policies.escalation.repeated_conflict.threshold" value="${m.policies.escalation?.repeated_conflict?.threshold ?? 3}"></div>
      <div class="field"><label>review rounds</label><input class="txt" type="number" data-m="policies.escalation.artifact_review_rounds.max" value="${m.policies.escalation?.artifact_review_rounds?.max ?? 5}"></div>
    </div>
    <div class="grid3" style="margin-top:8px">
      <div class="field"><label>mission tokens</label><input class="txt" type="number" step="100000" data-m="budgets.mission.tokens" value="${m.budgets?.mission?.tokens ?? 2000000}"></div>
      <div class="field"><label>wall-clock minutes</label><input class="txt" type="number" data-m="budgets.mission.wall_clock_minutes" value="${m.budgets?.mission?.wall_clock_minutes ?? 240}"></div>
      <div class="field"><label>max events</label><input class="txt" type="number" step="500" data-m="budgets.mission.max_events" value="${m.budgets?.mission?.max_events ?? 10000}"></div>
    </div>
    <div class="section-h">startup activation</div>
    <div class="chips">${ids.map((i) => `<button class="chip-toggle ${(m.startup.activate || []).includes(i) ? "on" : ""}" data-start="${esc(i)}">${esc(i)}</button>`).join("") || '<span class="muted">no agents</span>'}</div>`;

  const setPath = (obj, p, v) => { const k = p.split("."); let o = obj; for (let i = 0; i < k.length - 1; i++) o = o[k[i]] ??= {}; o[k[k.length - 1]] = v; };
  host.querySelectorAll("[data-m]").forEach((el) => el.addEventListener("input", () => { setPath(m, el.dataset.m, el.type === "number" ? Number(el.value) || 0 : el.value); dtouch(); }));
  host.querySelectorAll("[data-a]").forEach((el) => el.addEventListener("input", () => { const v = el.value.trim(); if (v) a[el.dataset.a] = v; else delete a[el.dataset.a]; dtouch(); }));
  const listMap = (id, key, sel) => { $(id)?.addEventListener("input", () => { a[key] = $(id).value.split(",").map((x) => x.trim()).filter(Boolean); dpaintDesignerForm(); dtouch(); void sel; }); };
  listMap("d-a-caps", "capabilities"); listMap("d-a-auth", "authority"); listMap("d-a-ints", "interests");
  $("d-a-budget")?.addEventListener("input", (ev) => { a.budget = { ...(a.budget || {}), tokens: Number(ev.target.value) || 0 }; dtouch(); });
  $("d-a-persist")?.addEventListener("change", (ev) => { a.session = { ...(a.session || {}), persistent: ev.target.checked }; dtouch(); });
  $("d-a-deleg")?.addEventListener("change", (ev) => { a.delegation = { ...(a.delegation || {}), allow: ev.target.checked }; dpaintDesignerForm(); dtouch(); });
  $("d-a-dw")?.addEventListener("input", (ev) => { a.delegation = { ...(a.delegation || {}), max_workers: Number(ev.target.value) || 0 }; dtouch(); });
  $("d-a-dd")?.addEventListener("input", (ev) => { a.delegation = { ...(a.delegation || {}), max_depth: Number(ev.target.value) || 0 }; dtouch(); });
  for (const b of host.querySelectorAll("[data-cap]")) b.addEventListener("click", () => { const c = b.dataset.cap; const l = new Set(a.capabilities || []); l.has(c) ? l.delete(c) : l.add(c); a.capabilities = [...l]; dpaintDesignerForm(); dtouch(); });
  for (const b of host.querySelectorAll("[data-int]")) b.addEventListener("click", () => { const c = b.dataset.int; const l = new Set(a.interests || []); l.has(c) ? l.delete(c) : l.add(c); a.interests = [...l]; dpaintDesignerForm(); dtouch(); });
  for (const b of host.querySelectorAll("[data-start]")) b.addEventListener("click", () => { const l = new Set(m.startup.activate || []); l.has(b.dataset.start) ? l.delete(b.dataset.start) : l.add(b.dataset.start); m.startup.activate = [...l]; b.classList.toggle("on"); dtouch(); });
  for (const b of host.querySelectorAll("[data-mx]")) b.addEventListener("change", () => { const [src, tgt] = b.dataset.mx.split("|"); m.policies.communication[src] ||= { may_contact: [] }; const l = new Set(m.policies.communication[src].may_contact || []); b.checked ? l.add(tgt) : l.delete(tgt); m.policies.communication[src].may_contact = [...l]; dtouch(); });
  $("d-agnet")?.addEventListener("change", (ev) => { S.designer.currentAgent = ev.target.value; dpaintDesignerForm(); });
  $("d-a-id")?.addEventListener("change", (ev) => { const old = S.designer.currentAgent, nn = ev.target.value.trim(); if (!nn || nn === old || m.agents[nn]) { dpaintDesignerForm(); return; } m.agents[nn] = m.agents[old]; delete m.agents[old]; for (const [k, p] of Object.entries(m.policies.communication)) { p.may_contact = (p.may_contact || []).map((x) => (x === old ? nn : x)); p.may_be_contacted_by = (p.may_be_contacted_by || []).map((x) => (x === old ? nn : x)); if (k === old) { delete m.policies.communication[k]; m.policies.communication[nn] = p; } } m.startup.activate = (m.startup.activate || []).map((x) => (x === old ? nn : x)); if (m.budgets?.agent?.[old] !== undefined) { m.budgets.agent[nn] = m.budgets.agent[old]; delete m.budgets.agent[old]; } S.designer.currentAgent = nn; dpaintDesignerForm(); dtouch(); });
  $("d-agent-add")?.addEventListener("click", () => { let i = 1; while (m.agents[`agent-${i}`]) i++; m.agents[`agent-${i}`] = { role: `role-${i}`, capabilities: [], authority: [], interests: [] }; S.designer.currentAgent = `agent-${i}`; dpaintDesignerForm(); dtouch(); });
  $("d-agent-dup")?.addEventListener("click", () => { if (!S.designer.currentAgent) return; let i = 1; while (m.agents[`${S.designer.currentAgent}-${i}`]) i++; m.agents[`${S.designer.currentAgent}-${i}`] = JSON.parse(JSON.stringify(m.agents[S.designer.currentAgent])); S.designer.currentAgent += `-${i}`; dpaintDesignerForm(); dtouch(); });
  $("d-agent-del")?.addEventListener("click", () => { const cur = S.designer.currentAgent; if (!cur) return; delete m.agents[cur]; for (const p of Object.values(m.policies.communication)) { p.may_contact = (p.may_contact || []).filter((x) => x !== cur); p.may_be_contacted_by = (p.may_be_contacted_by || []).filter((x) => x !== cur); } delete m.policies.communication[cur]; m.startup.activate = (m.startup.activate || []).filter((x) => x !== cur); if (m.budgets?.agent) delete m.budgets.agent[cur]; for (const r of (m.policies.rules || [])) if (r.when?.actor === cur) r.when.actor = ""; S.designer.currentAgent = Object.keys(m.agents)[0] || null; dpaintDesignerForm(); dtouch(); });
  $("d-crit-add")?.addEventListener("click", () => { m.mesh.acceptance_criteria ||= []; m.mesh.acceptance_criteria.push({ id: `criterion-${m.mesh.acceptance_criteria.length + 1}`, description: "", mandatory: true }); dpaintDesignerForm(); dtouch(); });
  host.querySelectorAll("[data-c]").forEach((el) => el.addEventListener("input", () => { const c = m.mesh.acceptance_criteria[Number(el.dataset.i)]; if (!c) return; if (el.dataset.c === "mandatory") c.mandatory = el.checked; else c[el.dataset.c] = el.value; dtouch(); }));
  host.querySelectorAll("[data-cdel]").forEach((b) => b.addEventListener("click", () => { m.mesh.acceptance_criteria.splice(Number(b.dataset.cdel), 1); dpaintDesignerForm(); dtouch(); }));
  $("d-gate-add")?.addEventListener("click", () => { m.policies.transitions["patch.merge"] = { requires: [] }; dpaintDesignerForm(); dtouch(); });
  host.querySelectorAll("[data-g]").forEach((el) => el.addEventListener("input", () => { const names = Object.keys(m.policies.transitions); const g = names[Number(el.dataset.i)]; if (!g) return; if (el.dataset.g === "name") { const nv = el.value.trim() || g; m.policies.transitions[nv] = m.policies.transitions[g]; if (nv !== g) delete m.policies.transitions[g]; } else m.policies.transitions[g].requires = el.value.split(",").map((x) => x.trim()).filter(Boolean); dtouch(); }));
  host.querySelectorAll("[data-gdel]").forEach((b) => b.addEventListener("click", () => { delete m.policies.transitions[Object.keys(m.policies.transitions)[Number(b.dataset.gdel)]]; dpaintDesignerForm(); dtouch(); }));
  dpaintOutput();
}

/* ------------------------------------------------------------------ wiring */
async function fullRefresh() {
  await refreshStatus();
  if (S.view === "graph" || S.view === "escalations" || S.view === "cost") { /* light views refetch on demand */ }
}

function help() {
  openDrawer($("tpl-help").innerHTML + '<button class="close-x" style="position:absolute;top:16px;right:18px">×</button>');
}

function initKeys() {
  window.addEventListener("keydown", (ev) => {
    if (ev.target.matches("input, textarea, select")) { if (ev.key === "Escape") ev.target.blur(); return; }
    const map = { 1: "overview", 2: "agents", 3: "graph", 4: "events", 5: "artifacts", 6: "cost", 7: "escalations", 8: "designer" };
    if (map[ev.key]) return setView(map[ev.key]);
    if (ev.key === "Escape") return closeDrawer();
    if (ev.key === "?") return help();
    if (ev.key === "t") return $("btn-theme").click();
    if (ev.key === "p" && S.goalId) return void post(`/goals/${S.goalId}/pause`).then(() => refreshStatus());
    if (ev.key === "r" && S.goalId) return void post(`/goals/${S.goalId}/resume`).then(() => refreshStatus());
    if (ev.key === "/") { ev.preventDefault(); const s = $("ev-search"); if (s) s.focus(); }
  });
}

async function init() {
  const savedTheme = localStorage.getItem("mesh-theme");
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;
  $("btn-theme").addEventListener("click", () => {
    const cur = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = cur;
    localStorage.setItem("mesh-theme", cur);
  });
  $("btn-help").addEventListener("click", help);
  $("btn-message").addEventListener("click", () => drawerControls("message"));
  $("btn-approval").addEventListener("click", () => drawerControls("approval"));
  $("btn-pause").addEventListener("click", async () => { if (S.goalId) { await post(`/goals/${S.goalId}/pause`); toast("mission", "paused", "warn"); void refreshStatus(); } });
  $("btn-resume").addEventListener("click", async () => { if (S.goalId) { await post(`/goals/${S.goalId}/resume`); toast("mission", "resumed", "ok"); void refreshStatus(); } });
  for (const t of $$("#nav .tab")) t.addEventListener("click", () => setView(t.dataset.view));
  initKeys();
  try { await fullRefresh(); } catch { toast("mesh", "server unreachable — retrying…", "bad"); }
  setView(S.view);
  connectSse();
  setInterval(() => { void refreshStatus().catch(() => {}); }, 4000);
}
window.addEventListener("hashchange", () => { const v = location.hash.replace("#/", ""); if (v && v !== S.view) setView(v); });
init().catch((e) => { $("top-goal").textContent = `boot failed: ${e.message}`; });
