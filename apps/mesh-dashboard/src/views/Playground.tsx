import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { FormEvent } from "react";
import "./playground.css";
import { dur } from "../format";
import { useMesh } from "../store";
import { Button, CopyButton, ErrorState, Input, PageHeader, Pill, Skeleton } from "../components";
import { Icon } from "../icons";
import { createPlayground, isBusy, isLive, outcomeOf, type PlayRun } from "../playground";

/* The Playground: the operator's own terminal for the thing they paid for.
 *
 * The seats have always been able to run the product (`test.execute`); the person who owns the workspace could not, so a
 * mesh could deliver a CLI whose `--help` worked the first time a human typed it — and had nowhere to type it. This page is
 * that box: a command, Run, and the raw output, kept after the run ends so the answer to the last command is still there.
 *
 * All the state is in `playground.ts`, which has no DOM in it and is driven by the tests. This file is its rendering: a
 * form, the product's declared entry points as shortcuts, the server's refusal when it will not start a command, and the log.
 */

function StatusChip({ run }: { run: PlayRun }): React.JSX.Element {
  const outcome = outcomeOf(run);
  const took = run.endedAt ? ` in about ${dur(run.endedAt - run.startedAt)}` : "";
  switch (outcome) {
    case "running": return <Pill tone="info" pulse>Running</Pill>;
    case "passed": return <Pill tone="ok">Exit code 0{took}</Pill>;
    case "failed": return <Pill tone="bad">Exit code {run.exitCode}{took}</Pill>;
    case "stopped": return <Pill tone="warn">{run.stopped ? "Stopped" : "Ended by a signal"}{took}</Pill>;
    default: return <Pill tone="warn">Output lost</Pill>;
  }
}

export default function Playground(): React.JSX.Element {
  const { client, projectId } = useMesh();
  // One controller per mounted view. It is not a module singleton: a background project's provider renders no Playground,
  // but two of them must never share one run's state if that changes.
  const [pg] = useState(() => createPlayground());
  const state = useSyncExternalStore(pg.subscribe, pg.getState);
  const [command, setCommand] = useState("");
  const logRef = useRef<HTMLPreElement>(null);
  // Follow the end of the output while the person has not scrolled up to read something.
  const stick = useRef(true);

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

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    void pg.start(client, command);
  };

  return (
    <>
      <PageHeader
        title="Playground"
        lede="Run the product's own commands in its checkout and read exactly what they print."
      />

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
        {/* Stop is only offered while there is a run to stop: one run at a time is the host's rule, so the button that
            ends it is the way to run something else. */}
        {isLive(run) ? (
          <Button variant="soft" icon="stop" disabled={run!.stopped} onClick={() => void pg.stop(client)}>
            {run!.stopped ? "Stopping…" : "Stop"}
          </Button>
        ) : null}
      </form>
      <p className="pg-note">
        The command runs in the product&apos;s checkout on the host, under the same hygiene as a script run: every
        <code> MESH_</code> variable and the model keys are withheld. One command runs at a time, and it is stopped on a
        clock if it does not end on its own.
      </p>

      {state.commandsError ? (
        <ErrorState what="the product's commands" detail={state.commandsError} onRetry={() => void pg.loadCommands(client)} />
      ) : !state.commandsLoaded ? (
        <div className="pg-skel" role="status">
          <span className="sr-only">Reading the commands this product declares</span>
          <Skeleton w="40%" h={14} />
          <Skeleton w="60%" h={14} />
        </div>
      ) : state.commands.length ? (
        <div className="pg-quick" role="group" aria-label="Commands this product declares for itself">
          {state.commands.map((c) => (
            <button
              key={`${c.kind}:${c.command}`}
              type="button"
              className="pg-quick-btn"
              disabled={busy}
              title={`Run ${c.command}`}
              onClick={() => void pg.start(client, c.command)}
            >
              <span className="pg-quick-l">{c.label}</span>
              <span className="pg-quick-c mono">{c.command}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="pg-note">This product declares no entry points of its own. Type a command above.</p>
      )}

      {/* The server's own words. It is the one that knows why (a run already in progress names the other run, which this
          page cannot see), and the last run's output stays below: being refused a command is not losing the answer to the
          one before it. */}
      {state.refusal ? (
        <p className="pg-refusal" role="alert">
          <Icon name="alert" size={14} />
          <span className="pg-refusal-t">{state.refusal}</span>
        </p>
      ) : null}

      {run ? (
        <section className="card pg-out" aria-labelledby="pg-out-h" tabIndex={-1}>
          <div className="pg-out-h">
            <h3 id="pg-out-h">Output of <code>{run.command}</code></h3>
            <StatusChip run={run} />
            <span className="grow" />
            {run.log ? <CopyButton text={run.log} label="Copy output" /> : null}
            {isLive(run) ? null : <Button variant="small" icon="x" onClick={pg.clear}>Dismiss</Button>}
          </div>
          {run.lost ? (
            <p className="pg-note">
              The host no longer has this run: it restarted, and a host keeps its runs in memory. Run the command again to
              see its output.
            </p>
          ) : (
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
          )}
        </section>
      ) : null}
    </>
  );
}
