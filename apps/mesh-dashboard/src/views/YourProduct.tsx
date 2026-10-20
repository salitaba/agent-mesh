import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import "./product.css";
import { projectPath } from "../route";
import { Button, Skeleton, useNow } from "../components";
import { Icon } from "../icons";
import type { ProjectClient } from "../api";
import {
  createLiveUi,
  lifetimeText,
  problemOf,
  rememberedCommand,
  rememberCommand,
  type LiveUiState,
} from "../productlive";

/* Your product, from the console's side: the page it ships, and its own UI running.
 *
 * This is the shortest path the console has from arriving to *using* the thing the mesh delivered, and it lives on two
 * pages (Product, and Playground) because the question "where is my product" is the same question in both. The state is
 * in `productlive.ts`, which has no DOM in it and is driven by the tests; this file draws it.
 *
 * Two frames can be opened here and only one at a time: the page the product ships, and the product's own UI served
 * through the console's proxy. Both are `sandbox` without `allow-same-origin` — the page runs, and it can reach neither
 * this console nor its API with the owner's session.
 */

type PageState = { got: boolean; failed: boolean; file: string | null; alts: { dir: string; file: string }[] };
interface PageFrame { open: boolean; src: string | null; failed: boolean }

const CLOSED_PAGE: PageFrame = { open: false, src: null, failed: false };

/** The waiting sentence, in its own component so the clock it reads only ticks while there is something to wait for. */
function Waiting({ state }: { state: LiveUiState }): React.JSX.Element | null {
  const now = useNow(1000);
  const said = problemOf(state, now);
  if (!said) return null;
  return (
    <p className="prod-live-said" role="status">
      <Icon name="info" size={14} />
      <span>{said}</span>
    </p>
  );
}

/** How long the host will keep this UI before its own clock ends it — said while it is up, not discovered when it dies. */
function Lifetime({ expiresAt }: { expiresAt: string | null }): React.JSX.Element | null {
  const now = useNow(30_000);
  const said = lifetimeText(expiresAt, now);
  return said ? <p className="prod-live-said" role="status"><Icon name="info" size={14} /><span>{said}</span></p> : null;
}

export function YourProduct({ client, projectId, refreshKey = 0 }: {
  client: ProjectClient;
  projectId: string | null;
  /** Bumped when something may have written a page (a build that just passed): the probe is asked again. */
  refreshKey?: number;
}): React.JSX.Element {
  const live = useMemo(
    () => createLiveUi({ readRemembered: () => rememberedCommand(projectId), writeRemembered: (c) => rememberCommand(projectId, c) }),
    [projectId],
  );
  const state = useSyncExternalStore(live.subscribe, live.getState);
  const [text, setText] = useState(state.command);
  const [page, setPage] = useState<PageState>({ got: false, failed: false, file: null, alts: [] });
  const [probeAttempt, setProbeAttempt] = useState(0);
  const [pg, setPg] = useState<PageFrame>(CLOSED_PAGE);
  const wasOpen = useRef(false);

  // Ask the host what it has, on arrival and every time the project changes. This is the call the panel never made: a UI
  // started in another tab, or before a reload, was invisible, and pressing Start answered "already running" — true, and
  // a dead end, because Stop was only drawn beside a UI this page believed in.
  useEffect(() => {
    void live.refresh(client);
  }, [live, client, projectId]);
  // Then only while there is something to watch: a UI that is starting, one that is up (its dying has to be noticed), or
  // an answer on its way.
  useEffect(() => {
    if (!live.due()) return;
    const id = setInterval(() => { if (live.due()) void live.refresh(client); }, 1500);
    return () => clearInterval(id);
  }, [live, client, state.phase, state.busy]);

  // The box opens with the command this product's UI was last started with; a UI started elsewhere fills it in.
  useEffect(() => { setText((t) => (t.trim() ? t : state.command)); }, [state.command]);

  // Which page the console would open, asked of the server rather than guessed from a path: it looks in apps/playground/
  // first and then where products put their own UI (public/, dist/, build/, a root index.html), and names what it found.
  useEffect(() => {
    let dead = false;
    client.api("GET", "/playground/commands").then(({ json, status, timeout }) => {
      if (dead) return;
      // A 502 body is `{error}`, and it used to be read as an answer: `page` became "it ships no page", a claim about the
      // product made by a server that never looked at it. A failed probe says it failed.
      if (timeout || status >= 400) {
        setPage({ got: false, failed: true, file: null, alts: [] });
        return;
      }
      const answer = (json ?? {}) as { page?: { file?: unknown } | null; alternates?: { dir?: unknown; file?: unknown }[] };
      setPage({
        got: true,
        failed: false,
        file: typeof answer.page?.file === "string" ? answer.page.file : null,
        alts: Array.isArray(answer.alternates)
          ? answer.alternates.filter((a): a is { dir: string; file: string } => typeof a?.file === "string" && typeof a?.dir === "string")
          : [],
      });
    }).catch(() => { if (!dead) setPage({ got: false, failed: true, file: null, alts: [] }); });
    return () => { dead = true; };
  }, [client, projectId, refreshKey, probeAttempt]);

  /** The product's page is opened the way it always was: a probe, then a signed link from the server, then the frame. */
  const openPage = (dir?: string): void => {
    if (pg.open) {
      setPg(CLOSED_PAGE);
      return;
    }
    live.close();
    setPg({ open: true, src: null, failed: false });
    client.api("GET", "/playground/").then(async ({ status, timeout }) => {
      if (timeout || status >= 400) { setPg((p) => ({ ...p, failed: true })); return; }
      const minted = await client.api("POST", "/playground/session", dir ? { dir } : {});
      const link = typeof minted.json?.path === "string" ? (minted.json.path as string) : null;
      if (minted.status >= 400 || !link) { setPg((p) => ({ ...p, failed: true })); return; }
      setPg({ open: true, src: projectPath(projectId, link), failed: false });
    }).catch(() => setPg((p) => ({ ...p, failed: true })));
  };

  const toggleUi = (): void => {
    if (state.open) { live.close(); return; }
    setPg(CLOSED_PAGE);
    live.open(projectId);
  };

  const start = (): void => void live.start(client, text);

  // Bringing a started UI into view is the one thing that has to move the page: on a phone the frame is below the fold,
  // and a person who has just pressed Start should be looking at it.
  useEffect(() => {
    if (state.open && !wasOpen.current) requestAnimationFrame(() => document.getElementById("yp-frame")?.scrollIntoView({ block: "nearest" }));
    wasOpen.current = state.open;
  }, [state.open]);

  const startable = state.phase === "idle" || state.phase === "ended";
  return (
    <section className="card prod-pg" aria-labelledby="yp-h">
      <div className="prod-h">
        <h3 id="yp-h">Your product</h3>
        <span className="grow" />
        {state.phase === "starting" ? (
          <Button variant="small" icon="stop" disabled={state.busy} onClick={() => void live.stop(client)}>
            {state.busy ? "Stopping…" : "Stop it"}
          </Button>
        ) : null}
      </div>

      {page.got && page.file ? (
        <div className="prod-have">
          <span className="prod-have-ic" aria-hidden="true"><Icon name="files" size={14} /></span>
          <p className="prod-have-t">
            It ships a page at <code>{page.file}</code>. It is shown in a sandbox: its scripts run, and they can reach
            neither this console nor its API.
          </p>
          <Button variant="small" onClick={() => openPage()}>{pg.open ? "Close the page" : "Open the page"}</Button>
          {page.alts.map((a) => (
            <Button key={a.file} variant="small" extra="prod-alt" onClick={() => openPage(a.dir)}>Open {a.file}</Button>
          ))}
        </div>
      ) : page.failed ? (
        <div className="prod-note prod-page-failed" role="alert">
          <p>The console could not ask the server which page this product ships. It may be restarting.</p>
          <Button variant="small" icon="refresh" onClick={() => setProbeAttempt((n) => n + 1)}>Try again</Button>
        </div>
      ) : page.got ? (
        <p className="prod-note">
          It ships no page for this console to open. Run its build from the Product page if it has one, or start its own
          UI below.
        </p>
      ) : (
        <p className="prod-note" role="status">Looking for a page this product ships…</p>
      )}

      <div className="prod-live">
        <div className="prod-live-h">
          <b>Its own UI</b>
          {state.phase === "live" ? <span className="prod-live-on">Running on port {state.port}</span> : null}
          {state.phase === "starting" ? <span className="prod-live-wait"><i className="dot" aria-hidden="true" />Starting</span> : null}
          {state.phase === "ended" ? <span className="prod-live-off">Not running</span> : null}
        </div>
        {state.phase !== "live" ? (
          <p className="prod-note prod-live-lede">
            A product that serves its own UI is started by a command of its own, on a port only this machine can reach.
            The console learns that port from what the command prints and shows the UI here.
          </p>
        ) : (
          <p className="prod-note prod-live-lede">
            Running on port {state.port}, which only this machine can reach: that address in the log is not one your
            phone can open. Every byte loads through the console instead — press <b>Use it here</b>. The page keeps its
            own sandbox, so it can read neither this console nor its API.
          </p>
        )}
        <Waiting state={state} />
        {state.phase === "live" ? <Lifetime expiresAt={state.expiresAt} /> : null}
        {state.phase === "live" ? (
          <div className="prod-live-start">
            <Button variant="primary" size="lg" icon="play" onClick={toggleUi}>{state.open ? "Close it" : "Use it here"}</Button>
            <Button variant="small" icon="stop" disabled={state.busy} onClick={() => void live.stop(client)}>
              {state.busy ? "Stopping…" : "Stop it"}
            </Button>
          </div>
        ) : null}
        {startable ? (
          <div className="prod-live-start">
            <label htmlFor="yp-cmd">How this product starts its own UI</label>
            <input
              id="yp-cmd"
              className="txt mono"
              value={text}
              spellCheck={false}
              autoComplete="off"
              placeholder="node bin/skillctl.js ui"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") start(); }}
            />
            <Button variant="primary" size="lg" icon="play" loading={state.busy} onClick={start}>Start it</Button>
          </div>
        ) : null}
        {state.log ? (
          state.phase === "live" ? (
            <details className="disc prod-live-log">
              <summary>What it printed</summary>
              <pre className="prod-log" tabIndex={0} aria-label="What the product's UI printed">{state.log.slice(-4000)}</pre>
            </details>
          ) : (
            <pre className="prod-log" tabIndex={0} aria-label="What the product's UI printed">{state.log.slice(-4000)}</pre>
          )
        ) : null}
      </div>

      <div className="prod-frame" id="yp-frame">
        {state.open && state.src ? (
          <iframe title="The product's UI" src={state.src} sandbox="allow-scripts allow-forms allow-popups allow-modals" className="playframe" />
        ) : pg.open ? (
          pg.failed ? (
            <p className="prod-note" role="alert">
              The host would not serve {page.file ?? "the product's page"}. If the product builds one, run its build from
              the Product page, then open it again.
            </p>
          ) : pg.src ? (
            <iframe title="The product's page" src={pg.src} sandbox="allow-scripts allow-forms allow-popups allow-modals" className="playframe" />
          ) : (
            <p className="prod-note" role="status">Opening the page…</p>
          )
        ) : null}
      </div>
    </section>
  );
}
