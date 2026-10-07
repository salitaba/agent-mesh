/**
 * The licence, as the console shows it: a card on Host settings that says what plan this install is on, what that plan allows and
 * how much of it is in use, when it ends and what to do next, and a banner above every view for the few cases that need doing
 * something about.
 *
 * Read-only on purpose. A licence is a signed line of text, installed with `curule license install` on the machine that runs the
 * host, where the file is written owner-only; a web form that wrote it would be a second, weaker way to do the same thing. It is
 * checked offline, so nothing here is a sign-in or a checkout, and nothing says otherwise.
 *
 * The banner is quiet for a healthy licence and for no licence at all: Community is a plan, not an error. It speaks when a key was
 * not accepted, has lapsed or is about to, or more projects are open than the plan allows. Opening the plan from it acknowledges
 * what it said, for the rest of the session, until what it says changes.
 *
 * The facts and the sentences are in license-facts.ts, which has the tests.
 */
import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import "./views/settings.css";
import { api } from "./api";
import { Banner, Button, CopyButton, IconTile, Pill, Progress, Skeleton, Stat, useNow } from "./components";
import { Icon } from "./icons";
import { useMesh } from "./store";
import { useProjectsOptional } from "./projects";
import {
  OFFLINE_NOTE,
  RUN_WHERE,
  bannerOf,
  enforcementSentence,
  expiryOf,
  featureName,
  headline,
  inUseOf,
  isOver,
  limitRows,
  nextSteps,
  planName,
  stateOf,
  whereFound,
  type LicenseView,
} from "./license-facts";

export type { LicenseView } from "./license-facts";

const REFRESH_MS = 5 * 60 * 1000;

export interface LicenseState {
  /** The host's licence. Kept while it is read again, so a refresh does not blank the card. */
  license: LicenseView | null;
  status: "loading" | "ready" | "unavailable";
  reload: () => void;
}

/*
 * One reading of the licence for the whole console. The banner above the views and the card on Host settings both show it, and a
 * card that read again while the banner kept the old answer would leave a lapsed-licence banner up after the key was renewed. So
 * the answer lives here, outside any component: every user of the hook sees the same one, one timer keeps it fresh while anything
 * is looking, and a read that is asked for while another is under way is run again straight after it, so it is never the older one.
 */
type Snapshot = Pick<LicenseState, "license" | "status">;
const FIRST: Snapshot = { license: null, status: "loading" };
let snapshot: Snapshot = FIRST;
const listeners = new Set<() => void>();
let timer: number | undefined;
let reading = false;
let again = false;

function publish(next: Snapshot): void {
  snapshot = next;
  for (const l of listeners) l();
}

async function readLicense(): Promise<void> {
  if (reading) {
    again = true;
    return;
  }
  reading = true;
  try {
    const res = await api("GET", "/api/license");
    if (res.status === 200 && res.json) publish({ license: res.json as LicenseView, status: "ready" });
    else if (snapshot.status !== "ready") publish({ license: null, status: "unavailable" });
  } catch {
    if (snapshot.status !== "ready") publish({ license: null, status: "unavailable" });
  } finally {
    reading = false;
    if (again) {
      again = false;
      void readLicense();
    }
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    void readLicense();
    timer = window.setInterval(() => void readLicense(), REFRESH_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.clearInterval(timer);
      timer = undefined;
      // Whoever looks next, perhaps after signing in as someone else, starts from "loading", not from this answer.
      snapshot = FIRST;
    }
  };
}

const reload = (): void => void readLicense();

/**
 * The host's licence, read when something first looks at it, every five minutes while anything does, and again when `refreshKey`
 * changes (the number of open projects, so opening a second one is noticed at once and not five minutes later). A host with no
 * such route (an older build) is "unavailable".
 */
export function useLicense(refreshKey: number | null = null): LicenseState {
  const snap = useSyncExternalStore(subscribe, () => snapshot);
  const first = useRef(true);
  useEffect(() => {
    // The first look is the subscription's own read.
    if (first.current) {
      first.current = false;
      return;
    }
    reload();
  }, [refreshKey]);
  return { license: snap.license, status: snap.status, reload };
}

const ACK_KEY = "curule-license-ack";
const readAck = (): string | null => {
  try {
    return window.sessionStorage.getItem(ACK_KEY);
  } catch {
    return null;
  }
};
const writeAck = (signature: string): void => {
  try {
    window.sessionStorage.setItem(ACK_KEY, signature);
  } catch {
    /* a private window keeps nothing; the banner then shows again, which is the safe way to be wrong */
  }
};

/**
 * How many seats the project in view has, which is what the plan's per-mesh limit is checked against. The host's own `/api/license`
 * cannot say (a host has many meshes), so this asks the project's server, whose `/license` reports `usage.seats`. It is not the
 * status field `startupActivateCount`, which counts the seats boot woke, not the seats there are. Null when no project is open or
 * the server will not say; the card then shows a gap, never a zero. `reread` changes when the licence is read again.
 */
function useSeats(reread: unknown): number | null {
  const { client, projectId } = useMesh();
  const [seats, setSeats] = useState<number | null>(null);
  useEffect(() => {
    let dead = false;
    if (!projectId) {
      setSeats(null);
      return undefined;
    }
    client
      .api("GET", "/license")
      .then(({ json }) => {
        if (!dead) setSeats(typeof json?.usage?.seats === "number" ? (json.usage.seats as number) : null);
      })
      .catch(() => {
        if (!dead) setSeats(null);
      });
    return () => {
      dead = true;
    };
  }, [client, projectId, reread]);
  return seats;
}

/** The number of projects open now, which is what the plan limits and what a refresh keys on. */
function useOpenProjects(): number | null {
  const projects = useProjectsOptional();
  return projects ? projects.projects.filter((p) => p.status === "open").length : null;
}

/**
 * Above the views. Silent unless something needs doing about the licence, and silent on Host settings, where the plan is already on
 * the page. One action: it opens the plan, and counts as having been read.
 */
export function LicenseBanner({ onOpen }: { onOpen: () => void }): React.JSX.Element | null {
  const { view } = useMesh();
  const { license } = useLicense(useOpenProjects());
  const [acked, setAcked] = useState<string | null>(readAck);
  if (!license || view === "hostsettings") return null;
  const b = bannerOf(license, inUseOf(license, null, null), new Date());
  if (!b || b.signature === acked) return null;
  return (
    <Banner
      tone="warn"
      className="server-banner"
      id="license-banner"
      title={b.title}
      actions={
        <Button
          variant="banner-act"
          onClick={() => {
            writeAck(b.signature);
            setAcked(b.signature);
            onOpen();
          }}
        >
          See plan
        </Button>
      }
    >
      {b.body}
    </Banner>
  );
}

/** What plan this install is on: its limits against what is in use, when it ends, and what to do next. */
export function LicenseCard(): React.JSX.Element {
  const projects = useProjectsOptional();
  const { license, status, reload } = useLicense(useOpenProjects());
  const seats = useSeats(license);
  const now = new Date(useNow(60_000));

  const head = (
    <header className="hs-head">
      <IconTile icon="key" />
      <h3 id="lic-h">Plan and licence</h3>
      <Button variant="small" icon="refresh" extra="hs-head-act" onClick={reload} title="Read the licence again">Read again</Button>
    </header>
  );

  if (!license) {
    return (
      <section className="card hs-card lic" aria-labelledby="lic-h">
        {head}
        {status === "loading" ? (
          <div className="lic-skel" role="status" aria-busy="true">
            <span className="sr-only">Reading the licence</span>
            <Skeleton w="30%" h={34} /><Skeleton w="70%" h={14} /><Skeleton w="100%" h={56} />
          </div>
        ) : (
          <p className="hs-note">This host did not report its licence, so the plan is not shown. An older build has no licence route.</p>
        )}
      </section>
    );
  }

  const use = inUseOf(license, seats, projects?.hostSpend?.runningTurns ?? null);
  const rows = limitRows(license, use);
  const over = isOver(rows);
  const st = stateOf(license, now, over);
  const ex = expiryOf(license, now);
  const where = whereFound(license);
  const steps = nextSteps(license, use, now);

  return (
    <section className="card hs-card lic" aria-labelledby="lic-h">
      {head}
      <div className="lic-top">
        <b className="lic-name">{planName(license.plan)}</b>
        <Pill tone={st.tone}><Icon name={st.tone === "ok" ? "check" : "alert"} size={12} />{st.label}</Pill>
      </div>
      <p className="lic-sub">{headline(license, over)}</p>

      <div className="card stat-strip lic-limits" role="group" aria-label="What the plan allows, and what is in use">
        {rows.map((r) => {
          const tone = r.over ? (r.transient ? "warn" : "bad") : undefined;
          return (
            <div className="stat-cell" key={r.key}>
              <Stat
                label={r.label}
                value={r.inUse === null ? "Not shown here" : r.inUse}
                size={r.inUse === null ? "sm" : undefined}
                unit={r.inUse === null ? undefined : `of ${r.allowed === null ? "unlimited" : r.allowed}`}
                tone={tone}
                sub={r.inUse === null ? undefined : (
                  <>
                    {r.per}{r.over ? (r.transient ? ", over for the moment" : ", over the limit") : ""}
                    {r.key === "projects" && use.registered !== null ? <span className="lic-aside">{use.registered} registered; the limit counts open ones</span> : null}
                  </>
                )}
              >
                {r.ratio !== null && r.allowed !== null && r.inUse !== null ? <Progress value={r.inUse} max={r.allowed} label={`${r.label}: ${r.inUse} of ${r.allowed} used`} tone={tone} /> : null}
              </Stat>
            </div>
          );
        })}
      </div>

      <dl className="kv lic-facts">
        <dt>Expiry</dt><dd>{ex.text}</dd>
        <dt>Enforcement</dt><dd>{enforcementSentence(license.enforcement)} <span className="lic-aside">Set by MESH_LICENSE_ENFORCEMENT on the host: {license.enforcement}.</span></dd>
        <dt>Licence key</dt><dd>{where.text}{where.code ? <> <code>{where.code}</code></> : null}</dd>
        <dt>Features</dt><dd>{license.features.length ? license.features.map(featureName).join(", ") : "No extra features on this plan."}</dd>
      </dl>

      <h4 className="hs-h2">What to do next</h4>
      <ul className="lic-next">
        {steps.map((s, i) => (
          <li key={i}>
            <span>{s.text}</span>
            {s.command ? <span className="lic-cmd"><code>{s.command}</code><CopyButton text={s.command} label="Copy" title={`Copy: ${s.command}`} /></span> : null}
          </li>
        ))}
      </ul>
      <p className="hs-note">{RUN_WHERE}</p>
      <p className="hs-note">{OFFLINE_NOTE}</p>
    </section>
  );
}
