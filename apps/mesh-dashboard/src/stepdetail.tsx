import { useEffect, useState } from "react";
import { api } from "./api";
import { Button, rowKey } from "./components";
import { type Outcome } from "./format";

/* Step-drawer companions: the sandbox permission strip and the grouped tool
   call list. Both answer one question the raw turn record cannot — "what was
   this agent *allowed* to do, and did it try anything the sandbox refused?" */

export type PermLevel = "allow" | "ask" | "deny";
export type PermKey = "read" | "edit" | "bash" | "webfetch";
export type SandboxPerms = Record<PermKey, { level: PermLevel; via: string }>;

const PERM_ORDER: PermKey[] = ["read", "edit", "bash", "webfetch"];
const PERM_LABEL: Record<PermKey, string> = { read: "read", edit: "edit", bash: "shell", webfetch: "web" };

/** Mirror of packages/runtime-opencode `permissionsFor`: capability grants
 *  decide which OpenCode tool families the sandbox opens. Keep in lockstep. */
export function permsFromCapabilities(caps: string[]): SandboxPerms {
  const has = (c: string): boolean => caps.includes(c);
  const pick = (grants: string[], deny: string, askOn?: string): { level: PermLevel; via: string } => {
    const hit = grants.find(has);
    if (hit) return { level: "allow", via: hit };
    if (askOn && has(askOn)) return { level: "ask", via: askOn };
    return { level: "deny", via: deny };
  };
  return {
    read: { level: "allow", via: "always on" },
    edit: pick(["repository.write"], "needs repository.write"),
    bash: pick(["shell.execute", "test.execute"], "needs shell.execute or test.execute", "git.commit"),
    webfetch: pick(["network.request"], "needs network.request"),
  };
}

interface AgentDef { capabilities?: string[]; runtime?: string }

/** Fetches the agent once per id; `null` until loaded, `undefined` on failure
 *  so callers can drop the strip instead of rendering a wrong one. */
export function useSandboxPerms(agentId: string | undefined): { perms: SandboxPerms | null | undefined; runtime?: string } {
  const [state, setState] = useState<{ perms: SandboxPerms | null | undefined; runtime?: string }>({ perms: null });
  useEffect(() => {
    if (!agentId) { setState({ perms: undefined }); return; }
    let dead = false;
    setState({ perms: null });
    api("GET", `/agents/${encodeURIComponent(agentId)}`, undefined, { timeoutMs: 8000 })
      .then(({ json }) => {
        if (dead) return;
        const d: AgentDef = (json as any)?.definition ?? {};
        setState({ perms: permsFromCapabilities(Array.isArray(d.capabilities) ? d.capabilities : []), runtime: d.runtime });
      })
      .catch(() => { if (!dead) setState({ perms: undefined }); });
    return () => { dead = true; };
  }, [agentId]);
  return state;
}

const LEVEL_WORD: Record<PermLevel, string> = { allow: "allowed", ask: "asks first", deny: "blocked" };

export function SandboxStrip({ perms, runtime, loading }: { perms?: SandboxPerms; runtime?: string; loading?: boolean }): React.JSX.Element | null {
  if (loading) {
    return (
      <div className="sbx" aria-hidden="true">
        <span className="sbx-label">sandbox</span>
        {PERM_ORDER.map((k) => <span key={k} className="sk sbx-sk" />)}
      </div>
    );
  }
  if (!perms) return null;
  return (
    <div className="sbx" role="group" aria-label="sandbox permissions">
      <span className="sbx-label" title="What the OpenCode sandbox lets this agent do, derived from its capabilities">sandbox</span>
      {PERM_ORDER.map((k) => {
        const p = perms[k];
        return (
          <span key={k} className={`sbx-chip sbx-${p.level}`} title={`${PERM_LABEL[k]}: ${LEVEL_WORD[p.level]} — ${p.via}`}>
            <i aria-hidden="true" />
            <span>{PERM_LABEL[k]}</span>
            <small>{p.level}</small>
          </span>
        );
      })}
      {runtime ? <span className="sbx-rt mono" title="runtime adapter">{runtime}</span> : null}
    </div>
  );
}

/** One-line environment summary for the Trace disclosure: "read only · shell
 *  disabled · web disabled". Null until permissions load. */
export function envLine(perms?: SandboxPerms | null): string | null {
  if (!perms) return null;
  const bits: string[] = [];
  if (perms.read.level === "allow") bits.push(perms.edit.level === "allow" ? "read/write" : "read only");
  bits.push(perms.bash.level === "allow" ? "shell on" : perms.bash.level === "ask" ? "shell asks first" : "shell disabled");
  bits.push(perms.webfetch.level === "allow" ? "web on" : "web disabled");
  return bits.join(" · ");
}

/* ---------- primary status: what happened, why, next ---------- */

export interface StepState { label: string; tone: string; headline: string; next: string }

/** Classifies a turn for the status block. Raw "waiting" reads like "stuck",
 *  so a finished turn that intentionally parked says "Waiting — no work
 *  produced" and always carries the next expected action. */
export function stateMeta(outcome: Outcome, status: string, produced: string): StepState {
  if (outcome === "live") return { label: "Working", tone: "live", headline: "Still working", next: "No action needed — live output streams under Now." };
  if (outcome === "shipped") return { label: "Produced", tone: "ship", headline: produced || "Left work behind", next: "No action needed — open the linked work under Verified by system." };
  if (outcome === "rejected") return { label: "Refused", tone: "rej", headline: "The kernel refused the attempted actions", next: "Review the refusals under Trace before this step is retried." };
  if (outcome === "blocked") return { label: "Blocked", tone: "block", headline: "Waiting on something it cannot do alone", next: "A human or another agent must clear the blocker first." };
  if (outcome === "crashed") return { label: "Failed", tone: "crash", headline: "The runtime failed mid-step", next: "The supervisor decides whether this step is retried." };
  if (status === "waiting") return { label: "Waiting", tone: "wait", headline: "No work produced", next: "Another agent will take over automatically on the next rotation." };
  return { label: "No action", tone: "quiet", headline: "Nothing was written", next: "Nothing to re-run — the step attempted nothing." };
}

export function StepStatusBlock({ outcome, status, produced, why, attempt }: {
  outcome: Outcome; status: string; produced: string; why?: string; attempt?: number;
}): React.JSX.Element {
  const st = stateMeta(outcome, status, produced);
  return (
    <section className={`sstat sstat-${st.tone}`} aria-label="step status">
      <div className="sstat-top">
        <span className={`sstat-badge sstat-${st.tone}`}>{st.label}</span>
        <h3 className="sstat-head">{st.headline}</h3>
        {attempt != null && attempt > 1 ? <span className="sstat-att mono">attempt {attempt}</span> : null}
      </div>
      {why ? <p className="sstat-why">{why}</p> : null}
      <div className="sstat-next">
        <span className="sstat-next-l">Next</span>
        <p>{st.next}</p>
      </div>
    </section>
  );
}

/* ---------- tool calls, grouped by sandbox family ---------- */

export type ToolGroup = PermKey | "mesh" | "other";
const GROUP_ORDER: ToolGroup[] = ["edit", "bash", "webfetch", "read", "mesh", "other"];
const GROUP_LABEL: Record<ToolGroup, string> = { read: "reads", edit: "edits", bash: "shell", webfetch: "web", mesh: "mesh", other: "other" };

export function toolGroupOf(name: string): ToolGroup {
  const n = name.toLowerCase();
  if (n.startsWith("mesh_")) return "mesh";
  if (["read", "glob", "grep", "list", "ls"].includes(n)) return "read";
  if (["edit", "write", "patch", "multiedit"].includes(n)) return "edit";
  if (n === "bash") return "bash";
  if (n === "webfetch" || n === "fetch") return "webfetch";
  return "other";
}

/** The one argument a reader wants at a glance; falls back to compact JSON. */
export function salientArg(name: string, args: unknown): string {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  switch (toolGroupOf(name)) {
    case "bash": return str(a.command) ?? str(a.cmd) ?? compact(a);
    case "edit":
    case "read": return str(a.filePath) ?? str(a.path) ?? str(a.pattern) ?? compact(a);
    case "webfetch": return str(a.url) ?? compact(a);
    default: return compact(a);
  }
}
function compact(a: Record<string, unknown>): string {
  const s = JSON.stringify(a);
  return s === "{}" ? "" : s;
}

export interface ToolCall { name?: string; args?: unknown; resultDigest?: string }

export function ToolCallGroups({ calls, perms }: { calls: ToolCall[]; perms?: SandboxPerms }): React.JSX.Element {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const grouped = new Map<ToolGroup, { call: ToolCall; idx: number }[]>();
  calls.forEach((call, idx) => {
    const g = toolGroupOf(String(call.name ?? ""));
    const list = grouped.get(g) ?? [];
    list.push({ call, idx });
    grouped.set(g, list);
  });
  const groups = GROUP_ORDER.filter((g) => grouped.has(g));
  return (
    <div className="tcg-list">
      {groups.map((g) => {
        const rows = grouped.get(g)!;
        const perm = perms && (g in perms) ? perms[g as PermKey] : undefined;
        const blocked = perm?.level === "deny";
        const isOpen = open[g] ?? (blocked || groups.length === 1);
        const toggle = (): void => setOpen((o) => ({ ...o, [g]: !isOpen }));
        return (
          <div className={`tcg${blocked ? " tcg-blocked" : ""}`} key={g}>
            <div className="tcg-head" role="button" tabIndex={0} aria-expanded={isOpen} onClick={toggle} onKeyDown={rowKey(toggle)}>
              <span className={`tcg-caret${isOpen ? " open" : ""}`} aria-hidden="true">▸</span>
              <span className="tcg-name">{GROUP_LABEL[g]}</span>
              <span className="tcg-n mono">{rows.length}</span>
              {blocked ? <span className="tcg-flag" title={perm?.via}>blocked by sandbox</span> : null}
              {perm?.level === "ask" ? <span className="tcg-flag ask" title={perm.via}>asks first</span> : null}
            </div>
            {isOpen ? (
              <div className="tcg-rows">
                {rows.slice(0, 40).map(({ call, idx }) => {
                  const name = String(call.name ?? "tool");
                  const arg = salientArg(name, call.args);
                  return (
                    <div className="tcg-row" key={idx}>
                      <span className="tcg-i mono">{idx + 1}</span>
                      <span className="tcg-tool mono">{name}</span>
                      <span className="tcg-arg mono" title={arg}>{arg || "—"}</span>
                      {call.resultDigest ? <span className="tcg-res" title={call.resultDigest}>{String(call.resultDigest).slice(0, 60)}</span> : null}
                    </div>
                  );
                })}
                {rows.length > 40 ? <div className="tcg-more muted">+{rows.length - 40} more</div> : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/* ---------- small shared bits ---------- */

/** Copy button with its own two-second "copied" state. */
export function CopyBtn({ text }: { text: string }): React.JSX.Element {
  const [done, setDone] = useState(false);
  const go = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 2000);
    } catch { /* clipboard unavailable */ }
  };
  return <Button variant="small" onClick={() => void go()}>{done ? "copied ✓" : "copy"}</Button>;
}

export function textStats(s: string): string {
  const lines = s ? s.split("\n").length : 0;
  const chars = s.length;
  return `${lines} ${lines === 1 ? "line" : "lines"} · ${chars >= 1000 ? `${(chars / 1000).toFixed(1)}k` : chars} chars`;
}

/** Skeleton for the drawer while /turns/:id is in flight. */
export function StepSkeleton(): React.JSX.Element {
  return (
    <div className="stepd-skel" aria-busy="true" aria-label="loading step">
      <div className="row"><span className="sk" style={{ width: 28, height: 28, borderRadius: "50%" }} /><span className="sk" style={{ width: 140, height: 16 }} /><span className="sk" style={{ width: 64, height: 16 }} /></div>
      <span className="sk" style={{ width: "70%", height: 11 }} />
      <span className="sk" style={{ width: "100%", height: 30 }} />
      <div className="stepd-kpis">{[0, 1, 2, 3].map((i) => <span key={i} className="sk" style={{ height: 48 }} />)}</div>
      <span className="sk" style={{ width: "100%", height: 90 }} />
    </div>
  );
}
