import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { FormEvent } from "react";
import "./playground.css";
import { dur } from "../format";
import { useMesh } from "../store";
import { Button, CopyButton, ErrorState, Input, NextLinks, PageHeader, Pill, useNow } from "../components";
import { Icon } from "../icons";
import { YourProduct } from "./YourProduct";
import { clockWords, createPlayground, isBusy, isLive, outcomeOf, stopReason, RUN_CEILING_MS, type PlayRun } from "../playground";

/* The Playground: the operator's own terminal for the thing they paid for.
 *
 * The seats have always been able to run the product (`test.execute`); the person who owns the workspace could not, so a
 * mesh could deliver a CLI whose `--help` worked the first time a human typed it — and had nowhere to type it. This page is
 * that box: a command, Run, and the raw output, kept after the run ends so the answer to the last command is still there.
 *
 * Above it sits the product itself — the page it ships, and its own UI running — because "open the console, use my
 * product" should not require knowing which other view holds that. All the terminal's state is in `playground.ts`, which
 * has no DOM in it and is driven by the tests. This file is its rendering.
 */

function Elapsed({ since }: { since: number }): React.JSX.Element {
  const now = useNow(1000);
  return <>{dur(Math.max(0, now - since))}</>;
}

function StatusChip({ run }: { run: PlayRun }): React.JSX.Element {
  const outcome = outcomeOf(run);
  const took = run.endedAt ? ` in about ${dur(run.endedAt - run.startedAt)}` : "";
  switch (outcome) {
    case "running": return <Pill tone="info" pulse>Running <Elapsed since={run.startedAt} /></Pill>;
    case "passed": return <Pill tone="ok">Exit code 0{took}</Pill>;
    case "failed": return <Pill tone="bad">Exit code {run.exitCode}{took}</Pill>;
    case "stopped":
      // The console's own clock is not a mystery signal: whoever stopped it is said, and after how long.
      return stopReason(run) === "clock"
        ? <Pill tone="warn">Stopped by the clock{took}</Pill>
        : <Pill tone="warn">{run.stopped ? "Stopped" : "Ended by a signal"}{took}</Pill>;
    default: return <Pill tone="warn">Output lost</Pill>;
  }
}

export default function Playground(): React.JSX.Element {
  const { client, projectId, setView } = useMesh();
  // One controller per mounted view. It is not a module singleton: a background project's provider renders no Playground,
  // but two of them must never share one run's state if that changes.
  const [pg] = useState(() => createPlayground());
  const state = useSyncExternalStore(pg.subscribe, pg.getState);
  const [command, setCommand] = useState("");
  const logRef = useRef<HTMLPreElement>(null);
  // Follow the end of the output while the person has not scrolled up to read something.
  const stick = useRef(true);
  // A run that has just started brings its output into view and takes focus: the button that started it disables on the
  // spot, which drops a keyboard user's place, and on a phone the output is below the quick buttons.
  const justStarted = useRef(false);

  // The product's own entry points, asked of the project rather than guessed. A new project is a new product.
  useEffect(() => {
    void pg.loadCommands(client);
  }, [pg, client, projectId]);

  const run = state.run;
  const busy = isBusy(state);
  const log = run?.log ?? "";
  useEffect(() => {
    const el = logRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [log]);

  useEffect(() => {
    if (!run || !justStarted.current) return;
    justStarted.current = false;
    const panel = document.getElementById("pg-out");
    panel?.focus({ preventScroll: true });
    panel?.scrollIntoView({ block: "nearest" });
  }, [run]);

  const runIt = (cmd: string): void => {
    justStarted.current = true;
    void pg.start(client, cmd);
  };

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    runIt(command);
  };

  return (
    <>
      <PageHeader
        title="Playground"
        lede="Run the product's own commands in its checkout and read exactly what they print."
      />

      {/* The terminal first, because it is what the page is for: measured at 360, the product card above it put the
          command box at y=657 and Run at 709, so the page opened on another page's card and its own action sat at the
          foot of the first screen. The product follows the output, where it is the answer to "now what?". */}
      <form className="pg-form" onSubmit={submit} aria-label="Run a command in the product's checkout">
        <Input
          mono
          extra="pg-cmd"
          id="pg-cmd"
          aria-label="Command to run"
          placeholder="node bin/skillctl.js --help"
          spellCheck={false}
          autoComplete="off"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
        />
        <Button variant="primary" size="lg" type="submit" icon="play" loading={state.starting} disabled={busy}>
          {state.starting ? "Starting…" : "Run"}
        </Button>
      </form>
      <p className="pg-note">
        The command runs in the product&apos;s own checkout on the host, and what it prints appears below exactly as it
        printed it. One command runs at a time; if one does not finish by itself, the console stops it after
        {" "}{RUN_CEILING_MS / 60_000} minutes — the longest any command may run here. It cannot see this console&apos;s
        own settings or keys: every <code>MESH_</code> variable and the model keys are withheld from it.
      </p>

      {state.commandsError ? (
        <ErrorState what="the product's commands" detail={state.commandsError} onRetry={() => void pg.loadCommands(client)} />
      ) : !state.commandsLoaded ? (
        <p className="pg-note" role="status">Reading the commands this product declares…</p>
      ) : state.commands.length ? (
        <div className="pg-quick" role="group" aria-label="Commands this product declares for itself">
          {state.commands.map((c) => (
            <button
              key={`${c.kind}:${c.command}`}
              type="button"
              className="pg-quick-btn"
              disabled={busy}
              title={`Run ${c.command}`}
              onClick={() => runIt(c.command)}
            >
              <span className="pg-quick-l">{c.label}</span>
              <span className="pg-quick-c mono">{c.command}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="pg-note">This product declares no commands of its own. Type one above.</p>
      )}

      {/* The server's own words, and — when it names the run that is in the way — a way out of them in one press. The
          last run's output stays below: being refused a command is not losing the answer to the one before it. */}
      {state.refusal ? (
        <div className="pg-refusal" role="alert">
          <Icon name="alert" size={14} />
          <div className="pg-refusal-b">
            <p className="pg-refusal-t">{state.refusal}</p>
            {state.blocked ? (
              <>
                <p className="pg-refusal-run">
                  It is <code>{state.blocked.command}</code>, going for the last{" "}
                  <Elapsed since={state.blocked.startedAt} />.
                  {state.pending && state.pending !== state.blocked.command ? (
                    <> Yours — <code>{state.pending}</code> — is waiting.</>
                  ) : null}
                </p>
                <Button variant="soft" icon="stop" loading={state.clearing} onClick={() => void pg.stopBlocking(client)}>
                  {state.clearing
                    ? "Stopping it…"
                    : state.pending && state.pending !== state.blocked.command
                      ? "Stop it and run mine"
                      : "Stop it"}
                </Button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      {run ? (
        <section className="card pg-out" id="pg-out" aria-labelledby="pg-out-h" tabIndex={-1}>
          <div className="pg-out-h">
            <h3 id="pg-out-h">Output of <code>{run.command}</code></h3>
            <StatusChip run={run} />
            <span className="grow" />
            {/* Stop lives where the eye is while a run is going: on the output it would end, not back up in the form. */}
            {isLive(run) ? (
              <Button variant="soft" icon="stop" disabled={run.stopped} onClick={() => void pg.stop(client)}>
                {run.stopped ? "Stopping…" : "Stop"}
              </Button>
            ) : null}
            {run.log ? <CopyButton text={run.log} label="Copy output" /> : null}
            {isLive(run) ? null : <Button variant="small" icon="x" onClick={pg.clear}>Dismiss</Button>}
          </div>
          {run.lost ? (
            <p className="pg-note">
              The host no longer has this run: it restarted, and a host keeps its runs in memory. Run the command again to
              see its output.
            </p>
          ) : (
            <>
              {run.done && stopReason(run) === "clock" ? (
                <p className="pg-note" role="status">{clockWords(run.timeoutMs)}</p>
              ) : null}
              <pre
                ref={logRef}
                className="pg-log"
                role="region"
                aria-label={`Output of ${run.command}`}
                tabIndex={0}
                onScroll={(e) => {
                  const el = e.currentTarget;
                  stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
                }}
              >{log || "No output yet."}</pre>
            </>
          )}
        </section>
      ) : null}
      {/* The product itself, after the terminal: the page it ships and its own UI, running, for the moment a command
          answered the question and the next is "now use it". */}
      <YourProduct client={client} projectId={projectId} />

      <NextLinks links={[
        { label: "Open the product", hint: "Use what the team built, running from this workspace", icon: "product", onGo: () => setView("product") },
        { label: "Read the files", hint: "Each file the team made, its versions and what changed", icon: "files", onGo: () => setView("artifacts") },
      ]} />
    </>
  );
}
