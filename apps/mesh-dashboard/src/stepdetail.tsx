import { useEffect, useRef, useState } from "react";
import { useMesh } from "./store";
import { Button } from "./components";
import { type Outcome } from "./format";

/* Step-drawer companions: the permission strip and the tool-call helpers. Both
   answer one question the raw turn record cannot — "what was this agent
   *allowed* to do, and did it try anything the runtime refused?" */

/** How the runtime's gate treats one tool family. `scoped` is a partial
 *  grant: today only shell, narrowed to the git commit path by `git.commit`. */
export type PermLevel = "allow" | "deny" | "approval" | "scoped";
export type PermKey = "read" | "edit" | "shell" | "web";

/**
 * The runtime's actual gate for a seat, as `GET /agents/:id` reports it.
 * `families` is null when the runtime has no local gate (an http agent decides
 * for itself), which is a different fact from "everything allowed".
 *
 * This used to be derived client-side from the seat's capabilities by a
 * mirror of the opencode adapter's permission block. That adapter was deleted
 * and the Claude runtime gates differently (architecture.write opens edits;
 * git.commit opens only the commit path), so the mirror showed "edit: deny"
 * beside Write calls that had succeeded. The server now says what its gate
 * does; the dashboard no longer guesses.
 */
export interface SandboxPerms {
  runtime: string;
  families: Record<PermKey, { level: PermLevel; via: string }> | null;
}

const PERM_ORDER: PermKey[] = ["read", "edit", "shell", "web"];
const PERM_LEVELS: readonly PermLevel[] = ["allow", "deny", "approval", "scoped"];

/** Shape-checks the server's `permissions` field. Anything unrecognised is
 *  `undefined` — the strip is dropped rather than drawn from a guess. */
export function permsFromServer(raw: unknown, fallbackRuntime?: string): SandboxPerms | undefined {
  if (raw === null) return { runtime: fallbackRuntime ?? "", families: null };
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as { runtime?: unknown; families?: unknown };
  const runtime = typeof r.runtime === "string" ? r.runtime : fallbackRuntime ?? "";
  if (r.families === null) return { runtime, families: null };
  const f = r.families as Record<string, { level?: unknown; via?: unknown } | undefined> | undefined;
  if (!f || typeof f !== "object") return undefined;
  const families = {} as Record<PermKey, { level: PermLevel; via: string }>;
  for (const k of PERM_ORDER) {
    const e = f[k];
    if (!e || !PERM_LEVELS.includes(e.level as PermLevel)) return undefined;
    families[k] = { level: e.level as PermLevel, via: typeof e.via === "string" ? e.via : "" };
  }
  return { runtime, families };
}

/** Fetches the agent once per id; `null` until loaded, `undefined` when the
 *  server did not say (an older server, or a failed request) so callers drop
 *  the strip instead of rendering a wrong one. */
export function useSandboxPerms(agentId: string | undefined): { perms: SandboxPerms | null | undefined; runtime?: string } {
  const { client } = useMesh();
  const [state, setState] = useState<{ perms: SandboxPerms | null | undefined; runtime?: string }>({ perms: null });
  useEffect(() => {
    if (!agentId) { setState({ perms: undefined }); return; }
    let dead = false;
    setState({ perms: null });
    client.api("GET", `/agents/${encodeURIComponent(agentId)}`, undefined, { timeoutMs: 8000 })
      .then(({ json }) => {
        if (dead) return;
        const body = (json ?? {}) as { definition?: { runtime?: unknown }; permissions?: unknown };
        const defRt = typeof body.definition?.runtime === "string" ? body.definition.runtime : undefined;
        // Absent is not null: a server that predates the field says nothing
        // about the gate, and nothing is what the strip then shows.
        const perms = "permissions" in body ? permsFromServer(body.permissions, defRt) : undefined;
        setState({ perms, runtime: perms?.runtime || defRt });
      })
      .catch(() => { if (!dead) setState({ perms: undefined }); });
    return () => { dead = true; };
  }, [agentId, client]);
  return state;
}

const LEVEL_WORD: Record<PermLevel, string> = { allow: "allowed", deny: "blocked", approval: "needs approval", scoped: "git only" };

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
  const rt = runtime || perms.runtime;
  // The label is the strip's own: the step view mounts it without a heading.
  const label = <span className="sbx-label" title="What this runtime's permission gate lets the agent's tools do, as the server reports it">sandbox</span>;
  if (!perms.families) {
    return (
      <div className="sbx" role="group" aria-label="tool permissions">
        {label}
        <span className="sbx-chip sbx-none" title="this runtime has no local permission gate — the agent behind it decides what it may do">no local gate</span>
        {rt ? <span className="sbx-rt mono" title="runtime adapter">{rt}</span> : null}
      </div>
    );
  }
  const fam = perms.families;
  return (
    <div className="sbx" role="group" aria-label="tool permissions">
      {label}
      {PERM_ORDER.map((k) => {
        const p = fam[k];
        return (
          <span key={k} className={`sbx-chip sbx-${p.level}`} title={`${k}: ${LEVEL_WORD[p.level]}${p.via ? ` — ${p.via}` : ""}`}>
            <i aria-hidden="true" />
            <span>{k}</span>
            <small>{LEVEL_WORD[p.level]}</small>
          </span>
        );
      })}
      {rt ? <span className="sbx-rt mono" title="the runtime whose gate this is">{rt}</span> : null}
    </div>
  );
}

/** One-line environment summary for the step view's context card: "read/write
 *  · shell git only · web blocked". Null until permissions load. */
export function envLine(perms?: SandboxPerms | null): string | null {
  if (!perms) return null;
  const f = perms.families;
  if (!f) return `permissions are decided by the ${perms.runtime || "agent's"} runtime, not gated here`;
  const phrase = (k: PermKey, on: string): string =>
    f[k].level === "allow" ? on : `${k} ${LEVEL_WORD[f[k].level]}`;
  const bits: string[] = [];
  bits.push({ allow: "read/write", approval: "edits need approval", scoped: "edits scoped", deny: "read only" }[f.edit.level]);
  bits.push(phrase("shell", "shell on"));
  bits.push(phrase("web", "web on"));
  return bits.join(" · ");
}

/* ---------- primary status: what happened, why, next ---------- */

export interface StepState { label: string; tone: string; headline: string; next: string }

/** Classifies a turn for the status block. Raw "waiting" reads like "stuck",
 *  so a finished turn that intentionally parked says "Waiting — no work
 *  produced" and always carries the next expected action. */
export function stateMeta(outcome: Outcome, status: string, produced: string): StepState {
  if (outcome === "live") return { label: "Working", tone: "live", headline: "Still working", next: "No action needed — live output streams below." };
  if (outcome === "shipped") return { label: "Produced", tone: "ship", headline: produced || "Left work behind", next: "No action needed — select an action under Outcome to see what it landed." };
  // Only classified this way when nothing landed (see `outcomeOf`), so the
  // headline can say "every": a turn that also produced something is "shipped".
  if (outcome === "rejected") return { label: "Refused", tone: "rej", headline: "Every action it attempted was refused", next: "Review the refusals under Events before this step is retried." };
  if (outcome === "blocked") return { label: "Blocked", tone: "block", headline: "Waiting on something it cannot do alone", next: "A human or another agent must clear the blocker first." };
  if (outcome === "crashed") return { label: "Failed", tone: "crash", headline: "The runtime failed mid-step", next: "The supervisor decides whether this step is retried." };
  if (status === "waiting") return { label: "Waiting", tone: "wait", headline: "No work produced", next: "It is parked on its mailbox and wakes when new mail arrives — no action needed unless it stays parked while work waits on it." };
  return { label: "No action", tone: "quiet", headline: "Nothing was written", next: "Nothing to re-run — the step attempted nothing." };
}

/**
 * The card that answers "what happened, why, and what next". The badge and the
 * attempt count live in the sticky header, which stays on screen; repeating
 * them here put the same fact on the page two and three times.
 */
export function StepStatusBlock({ outcome, status, produced, why }: {
  outcome: Outcome; status: string; produced: string; why?: string;
}): React.JSX.Element {
  const st = stateMeta(outcome, status, produced);
  return (
    <section className={`sstat sstat-${st.tone}`} aria-label="step status">
      <h3 className="sstat-head">{st.headline}</h3>
      {/* Labelled: this is the wake note the kernel handed the seat, and set
          bare under the headline it read as the dashboard's diagnosis. */}
      {why ? (
        <div className="sstat-why">
          <span className="sstat-why-l">Woke because</span>
          <p>{why}</p>
        </div>
      ) : null}
      <div className="sstat-next">
        <span className="sstat-next-l">Next</span>
        <p>{st.next}</p>
      </div>
    </section>
  );
}

/* ---------- tool calls: family, salient argument, recorded failure ---------- */

export type ToolGroup = PermKey | "mesh" | "other";

const MCP_NAME = /^mcp__(.+?)__(.+)$/;

/**
 * The tool's own name, without an MCP server prefix. Adapters report MCP tools
 * as `mcp__<server>__<tool>`; classifying the prefixed name tagged every mesh
 * call OTHER, which is most of the calls a seat makes.
 */
export function bareToolName(name: string): string {
  return MCP_NAME.exec(name)?.[2] ?? name;
}

/** Families mirror the Claude runtime's gate (packages/runtime-claude
 *  EDIT/EXEC/NETWORK/READ_TOOLS), plus the names other adapters use. */
export function toolGroupOf(name: string): ToolGroup {
  const server = MCP_NAME.exec(name)?.[1];
  const n = bareToolName(name).toLowerCase();
  if (server === "mesh" || n.startsWith("mesh_")) return "mesh";
  if (server) return "other";
  if (["read", "glob", "grep", "list", "ls", "todowrite"].includes(n)) return "read";
  if (["edit", "write", "patch", "multiedit", "notebookedit"].includes(n)) return "edit";
  if (["bash", "bashoutput", "killshell"].includes(n)) return "shell";
  if (["webfetch", "websearch", "fetch"].includes(n)) return "web";
  return "other";
}

/** Mesh-tool arguments that name what the call acted on, most telling first.
 *  Recipients are handled apart: they read as "→ pm, qa", not a bare list. */
const MESH_SALIENT = ["name", "title", "artifactId", "artifactRef", "artifactUri", "fromPath", "taskId", "decisionId", "messageId", "key", "topic", "question", "reason", "summary", "type"];

/** The one argument a reader wants at a glance; falls back to compact JSON. */
export function salientArg(name: string, args: unknown): string {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  switch (toolGroupOf(name)) {
    case "shell": return str(a.command) ?? str(a.cmd) ?? compact(a);
    case "edit":
    case "read":
      // The Claude tools spell it `file_path`; `filePath` is other adapters'.
      return str(a.file_path) ?? str(a.notebook_path) ?? str(a.filePath) ?? str(a.path) ?? str(a.pattern) ?? compact(a);
    case "web": return str(a.url) ?? str(a.query) ?? compact(a);
    case "mesh": {
      const who = [a.to, a.reviewers].flatMap((v) => (Array.isArray(v) ? v : [v])).filter((v): v is string => typeof v === "string" && Boolean(v));
      const what = MESH_SALIENT.map((k) => str(a[k])).find(Boolean);
      const steps = Array.isArray(a.steps) ? `${a.steps.length} step${a.steps.length === 1 ? "" : "s"}` : null;
      const bits = [who.length ? `→ ${[...new Set(who)].join(", ")}` : null, what?.split("\n")[0] ?? steps].filter(Boolean);
      return bits.length ? bits.join(" · ") : compact(a);
    }
    default: return compact(a);
  }
}
function compact(a: Record<string, unknown>): string {
  const s = JSON.stringify(a);
  return s === "{}" ? "" : s;
}

/**
 * One captured call. `status`/`error` come from the runtime's own record of the
 * call's result; a server that predates them sends neither, and then nothing
 * is flagged — a flag is never inferred from what the seat was configured to
 * be allowed, which is how successful Write calls came to be marked "sandbox".
 */
export interface ToolCall {
  name?: string; args?: unknown; resultDigest?: string; status?: "completed" | "failed"; error?: string;
  /** Strings in `args` the server cut at storage: dotted path → original length. */
  argsClipped?: Record<string, number>;
  /** 0-based position among ALL the turn's calls. The record keeps 30 non-mesh
   *  plus 120 mesh calls, so list position stops matching once calls are
   *  skipped; absent on records written before the server sent it. */
  index?: number;
}

/** The Claude gate's refusal wording (buildPermissionGate): a call the runtime
 *  denied, as opposed to one that ran and failed. */
const DENIAL = /denied|not available to curule agents|needs operator approval/i;

/** "denied" / "failed" when the record says the call failed, else null. */
export function toolFailure(c: ToolCall): "denied" | "failed" | null {
  if (c.status !== "failed") return null;
  return DENIAL.test(String(c.error ?? "")) ? "denied" : "failed";
}

/* ---------- small shared bits ---------- */

/** Copy button with its own two-second "copied" state. */
/**
 * `navigator.clipboard` is undefined on an http:// origin that is not
 * localhost — precisely how this dashboard gets opened when the mesh runs on
 * another box. Swallowing that made the button look merely broken, so the
 * failure now says so and the title explains why.
 */
export function CopyBtn({ text }: { text: string }): React.JSX.Element {
  const [state, setState] = useState<"idle" | "done" | "fail">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const go = async (): Promise<void> => {
    let next: "done" | "fail" = "done";
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      next = "fail";
    }
    setState(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2000);
  };
  return (
    <Button
      variant="small"
      onClick={() => void go()}
      title={state === "fail" ? "The browser blocked clipboard access on this origin" : undefined}
    >
      {state === "done" ? "copied ✓" : state === "fail" ? "can't copy" : "copy"}
    </Button>
  );
}

export function textStats(s: string): string {
  const lines = s ? s.split("\n").length : 0;
  const chars = s.length;
  return `${lines} ${lines === 1 ? "line" : "lines"} · ${chars >= 1000 ? `${(chars / 1000).toFixed(1)}k` : chars} chars`;
}

/**
 * Skeleton for the step view while /turns/:id is in flight. Drawn in the step
 * view's own shape (and inside `.stepv`, so the drawer is already wide) so the
 * loaded page does not jump; `close` is the drawer's × — it lives in
 * drawers.tsx, which imports this file.
 */
export function StepSkeleton({ close }: { close?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="stepv" aria-busy="true" aria-label="loading step">
      <header className="sv-head">
        <div className="sv-topbar"><span className="sk" style={{ width: 110, height: 22 }} />{close}</div>
        <div className="sv-ident">
          <span className="sk" style={{ width: 28, height: 28, borderRadius: "50%" }} />
          <span className="sk" style={{ width: 160, height: 18 }} />
          <span className="sk" style={{ width: 70, height: 18, borderRadius: 20 }} />
        </div>
        <div className="sv-metrics"><span className="sk" style={{ width: 300, height: 12 }} /></div>
        <div className="sv-jump"><span className="sk" style={{ width: 340, height: 22 }} /></div>
      </header>
      <div className="sv-body">
        <div className="sv-main">
          <span className="sk" style={{ height: 96 }} />
          <span className="sk" style={{ height: 140 }} />
          <span className="sk" style={{ height: 180 }} />
        </div>
        <aside className="sv-side"><span className="sk" style={{ height: 150 }} /></aside>
      </div>
    </div>
  );
}
