/**
 * Host settings — the cross-project limits, on their own screen.
 *
 * Its own screen and not a section of Overview because these keys are
 * host-wide: the same ceiling parks every project, so editing it from inside
 * one mission's console would misreport whose limit it is.
 *
 * Two rules this screen exists to honour, both learned from the incident that
 * prompted it (a `$50` ceiling nobody set, in a file that did not exist):
 *
 *   1. Show the effective value *and* whether a human chose it. A default and
 *      a deliberate setting render identically as a number, and "nobody chose
 *      this" is the most useful thing to know about a limit that just stopped
 *      your mesh.
 *   2. Say per key when the edit lands. One undifferentiated Save button is
 *      the original trap rebuilt with better manners, so the effect label
 *      comes from the server (`effects`) and the toast after a save repeats it.
 *
 * No validation lives here. The rules are in `packages/projects/host-config`
 * so CLI and server boots see them too; this screen sends what was typed and
 * renders whatever the server says is wrong with it.
 */
import React, { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useMesh } from "../store";
import { Button, Card, Chip, ErrorState, Input } from "../components";

type Effect = "live" | "host-restart";

interface HostConfigView {
  path: string;
  config: {
    projectMemoryMb: number | null;
    maxConcurrentTurns: number | null;
    spendCeilingUsd: number | null;
    defaultUsdPerMtok: number;
    modelPrices: Record<string, unknown>;
  };
  explicit: string[];
  effects: Record<string, Effect>;
  warnings: string[];
}

type Field = "spendCeilingUsd" | "maxConcurrentTurns" | "defaultUsdPerMtok" | "projectMemoryMb";

interface Row {
  yaml: string;
  field: Field;
  label: string;
  prefix?: string;
  suffix?: string;
  /** What it does when it bites — the half a settings form usually omits. */
  what: string;
  /** What a blank input means, or null when blank is not a legal value. */
  blank: string | null;
}

const ROWS: Row[] = [
  {
    yaml: "spend_ceiling_usd",
    field: "spendCeilingUsd",
    label: "Spend ceiling",
    prefix: "$",
    what: "Parks every open project once host-wide spend reaches it.",
    blank: "no ceiling — nothing stops a run on cost",
  },
  {
    yaml: "max_concurrent_turns",
    field: "maxConcurrentTurns",
    label: "Concurrent turns",
    what: "Parks the newest projects, oldest kept running, until the host-wide count of turns in flight fits.",
    blank: "no cap on turns in flight",
  },
  {
    yaml: "default_usd_per_mtok",
    field: "defaultUsdPerMtok",
    label: "Default price",
    prefix: "$",
    suffix: "per Mtok",
    what: "What a model with no entry in model_prices is billed at, which is what the ceiling counts.",
    // Deliberately not nullable server-side: a model billed at zero is an
    // invisible way to spend past the ceiling, and a backstop cannot allow that.
    blank: null,
  },
  {
    yaml: "project_memory_mb",
    field: "projectMemoryMb",
    label: "Project memory",
    suffix: "MB",
    what: "The memory cap handed to each project process when it is spawned.",
    blank: "no memory cap",
  },
];

const show = (v: number | null): string => (v === null ? "" : String(v));

export default function HostSettings(): React.JSX.Element {
  const { toast, confirm } = useMesh();
  const [data, setData] = useState<HostConfigView | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [drafts, setDrafts] = useState<Partial<Record<Field, string>>>({});
  const [saving, setSaving] = useState<Field | null>(null);

  useEffect(() => {
    let dead = false;
    void (async () => {
      const res = await api("GET", "/api/host/config");
      if (dead) return;
      if (res.status !== 200) {
        setLoadErr(res.json?.error || `status ${res.status}`);
        return;
      }
      setLoadErr(null);
      setData(res.json as HostConfigView);
      setDrafts({});
    })();
    return () => {
      dead = true;
    };
  }, [attempt]);

  const save = useCallback(
    async (row: Row, raw: string): Promise<void> => {
      const trimmed = raw.trim();
      // A blank box means null, and anything that is not cleanly a number goes
      // to the server *as typed* rather than through `Number()`. Coercing here
      // would turn a fat-fingered "5o" into NaN, then into JSON `null`, and
      // silently remove the operator's ceiling instead of refusing the edit.
      const value: number | string | null =
        trimmed === "" ? null : Number.isFinite(Number(trimmed)) ? Number(trimmed) : trimmed;
      const body: Record<string, unknown> = { [row.field]: value };

      setSaving(row.field);
      try {
        let res = await api("PUT", "/api/host/config", body);

        // The server, not this screen, decides that a raise needs asking. It
        // answers 409 and we relay its sentence — so the rule holds for the CLI
        // and any other client too, instead of living in one form's onClick.
        if (res.status === 409 && res.json?.needsConfirm) {
          const answer = await confirm({
            title: "Raise the spend ceiling?",
            body: [
              String(res.json.error),
              "The ceiling is a backstop against a mesh that is burning money with nothing to show for it — the incident behind this screen was $53.33 in with every mandatory criterion still unsatisfied, and the ceiling was the only thing that noticed.",
              "Projects the host already parked stay parked. Raising the ceiling stops new parks; it does not resume anything, so reopen them yourself.",
            ],
            danger: true,
            confirmLabel: "Raise it",
          });
          if (answer === null) return;
          res = await api("PUT", "/api/host/config", { ...body, confirm: true });
        }

        if (res.status !== 200) {
          toast("couldn't save host settings", res.json?.error || `status ${res.status}`, "bad");
          return;
        }

        const next = res.json as HostConfigView;
        setData(next);
        setDrafts((d) => {
          const { [row.field]: _dropped, ...rest } = d;
          return rest;
        });
        toast(
          `${row.label} saved`,
          next.effects[row.yaml] === "live"
            ? "In force now — the host enforced it on this request, and every heartbeat from here uses it."
            : "Written to host.yaml. It changes nothing until the host restarts.",
          "ok",
        );
      } finally {
        setSaving(null);
      }
    },
    [confirm, toast],
  );

  if (loadErr !== null) {
    return (
      <ErrorState what="Couldn't read the host settings" detail={loadErr} onRetry={() => setAttempt((a) => a + 1)} />
    );
  }
  if (data === null) return <div className="empty">loading…</div>;

  const priced = Object.keys(data.config.modelPrices ?? {}).length;

  return (
    <>
      <h2 className="view-title">Host settings</h2>
      <p className="muted">
        Limits that apply to every project on this host, not just the one you are looking at. Stored in{" "}
        <code>{data.path}</code>.
      </p>

      {data.warnings.length > 0 ? (
        <div className="banner warn" role="alert">
          <b>host.yaml has problems.</b>{" "}
          <span className="muted">
            These keys were ignored and the default used instead: {data.warnings.join(" · ")}
          </span>
        </div>
      ) : null}

      {ROWS.map((row) => {
        const current = data.config[row.field];
        const isExplicit = data.explicit.includes(row.yaml);
        const effect = data.effects[row.yaml];
        const draft = drafts[row.field] ?? show(current as number | null);
        const dirty = draft.trim() !== show(current as number | null);

        return (
          <Card key={row.yaml} title={row.label}>
            <p className="muted">{row.what}</p>

            <div className="page-actions">
              {row.prefix ? <span className="muted">{row.prefix}</span> : null}
              <Input
                mono
                value={draft}
                aria-label={`${row.label} (${row.yaml})`}
                placeholder={row.blank ?? "required"}
                onChange={(e) => setDrafts((d) => ({ ...d, [row.field]: e.target.value }))}
              />
              {row.suffix ? <span className="muted">{row.suffix}</span> : null}
              <Button
                variant="small"
                danger={row.field === "spendCeilingUsd"}
                disabled={!dirty || saving !== null}
                onClick={() => void save(row, draft)}
              >
                {saving === row.field ? "saving…" : "Save"}
              </Button>
            </div>

            <div className="page-actions">
              {/* The whole lesson of the incident, per key: a number in force
                  and a number somebody chose are not the same thing. */}
              <Chip title={isExplicit ? `Set explicitly in ${data.path}` : "You never set this — it is the built-in default"}>
                {isExplicit ? "set in host.yaml" : "default — nobody chose this"}
              </Chip>
              <Chip
                warn={effect !== "live"}
                title={
                  effect === "live"
                    ? "Saving is enough. The next heartbeat enforces the new value."
                    : "The running host captured this value at startup, so saving the file is not enough."
                }
              >
                {effect === "live" ? "takes effect immediately" : "needs a host restart"}
              </Chip>
              {current === null ? <Chip warn>currently {row.blank ?? "unset"}</Chip> : null}
            </div>
          </Card>
        );
      })}

      <Card title="Model prices">
        <p className="muted">
          Per-model token prices, {priced === 0 ? "none set" : `${priced} set`}. These feed the spend ceiling, so a
          mispriced model trips it early and parks everything — which makes them blocking config even though nothing
          here refuses a turn.
        </p>
        {/* Honest about the gap rather than rendering a field that 400s: the
            server reports model_prices as live, but its update path takes only
            the scalar keys above, so this screen would be promising an edit it
            cannot perform. */}
        <p className="muted">
          Editing them here is not wired up yet. Change <code>model_prices</code> in <code>{data.path}</code> by hand;
          the host re-reads the file on the next save from this screen, or on restart.
        </p>
      </Card>
    </>
  );
}
