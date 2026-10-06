/* The first screen of a mesh that has nothing in it yet, or only what the scaffold wrote.
 *
 * A new project holds a placeholder goal and one seat. Without a word about it the Designer opened on a lone circle and a toolbar,
 * and a person who had never seen it had to work out for themselves that there was a goal to write, seats to add and wires to draw.
 * Two pieces: EmptySeats for a mesh with no seat at all (which the server refuses to save), and SetupGuide for a mesh that has a
 * seat or two and is not yet a team. The guide says where the person is (done, now, next: guidemodel.ts) and gives the step that is
 * now its main action: for a lone seat, describing the team to the assistant. */

import { useEffect, useRef, useState } from "react";
import { Button, EmptyState, TextArea, useDismissable } from "../components";
import { Icon } from "../icons";
import { guideProgress, seatsText } from "./guidemodel";
import { GOAL_MAX, goalIsPlaceholder, TEMPLATES, type Template } from "./model";
import { CloseButton, ToolButton } from "./ui";

const KEYS: Array<[string, string]> = [
  ["Arrow keys", "Move to the next seat in that direction."],
  ["Enter", "Open the seat in the inspector."],
  ["Shift and an arrow key", "Move the seat."],
  ["W", "Start a wire from the seat. Arrow to the seat it may message, then press Enter."],
  ["B", "Flip whether the seat starts with the mission."],
  ["Delete", "Cut the selected wire. Click a wire to select it."],
  ["Esc", "Stop wiring, or let go of a wire."],
  ["Ctrl or Cmd and Z", "Undo. Add Shift to redo."],
];

/**
 * Every pointer gesture on the canvas has a key, and this is where they are written down: a keyboard equivalent nobody can find is not one.
 * It is a popover, not a page of help, because the person is mid-task with a seat in their hand.
 */
export function KeysHelp(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement | null>(null);
  const ref = useDismissable<HTMLDivElement>(open, () => setOpen(false));
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => { if (!anchor.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);
  return (
    <div className="ms-keys-anchor" ref={anchor}>
      <ToolButton icon="help" label="Canvas keys" text expanded={open} haspopup="dialog" title="The keys that move, wire and edit seats" onClick={() => setOpen((v) => !v)} />
      {open ? (
        <div className="ms-pop ms-keys" role="dialog" aria-label="Keyboard shortcuts for the canvas" ref={ref} tabIndex={-1}>
          <div className="ms-pop-head">
            <h3>Canvas keys</h3>
            <CloseButton label="Close the keyboard help" onClick={() => setOpen(false)} />
          </div>
          <dl>
            {KEYS.map(([k, what]) => (
              <div key={k}><dt><kbd>{k}</kbd></dt><dd>{what}</dd></div>
            ))}
          </dl>
          <p className="ms-hint">Wires can also be set without the canvas: select a seat, then use Communication in the inspector. Where seats sit is kept in this browser only: mesh.yaml does not store positions.</p>
        </div>
      ) : null}
    </div>
  );
}

/** A mesh with no seats: say what a seat is, and offer the three ways in. */
export function EmptySeats({ onAddSeat, onTemplate, onAsk }: { onAddSeat: () => void; onTemplate: (t: Template) => void; onAsk: () => void }): React.JSX.Element {
  return (
    <div className="ms-empty">
      <EmptyState
        icon="agents" title="This mesh has no seats yet"
        action={(
          <>
            <Button variant="primary" icon="plus" onClick={onAddSeat}>Add the first seat</Button>
            <Button variant="soft" icon="spark" onClick={onAsk}>Describe the team to the designer</Button>
          </>
        )}
      >
        A seat is one agent with a role and the authority to act. A mesh needs at least one. Start from a template, or add a seat and name its role.
      </EmptyState>
      <div className="ms-templates">
        {TEMPLATES.map((t) => (
          <button key={t.key} type="button" className="ms-template" onClick={() => onTemplate(t)}>
            <b>{t.name}</b>
            <span>{t.desc}</span>
            <em>{t.seats} {t.seats === 1 ? "seat" : "seats"}</em>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Whether the guide has anything to say: a goal still to write, fewer than two seats, or seats nobody may message. */
export function needsGuide(goal: unknown, seats: number, wires: number): boolean {
  return goalIsPlaceholder(goal) || seats < 2 || wires === 0;
}

export interface SetupGuideProps {
  goal: string;
  onGoal: (goal: string) => void;
  seats: number;
  wires: number;
  onAddSeat: () => void;
  onAsk: () => void;
  onHide: () => void;
}

export function SetupGuide({ goal, onGoal, seats, wires, onAddSeat, onAsk, onHide }: SetupGuideProps): React.JSX.Element {
  const progress = guideProgress({ goal, seats, wires });
  const stateOf = (key: string) => progress.steps.find((s) => s.key === key)?.state ?? "next";
  const steps: Array<{ key: string; title: string; body: React.ReactNode }> = [
    {
      key: "goal", title: "Describe the goal",
      body: (
        <>
          <span className="ms-step-text">What should this team deliver? Say it in a sentence or two. Every seat reads it on every turn.</span>
          <TextArea
            rows={2} maxLength={GOAL_MAX} aria-label="Mission goal" data-field="goal" value={goal}
            placeholder="Build a payment API with idempotent charges."
            onFocus={(e) => { if (goalIsPlaceholder(goal)) e.currentTarget.select(); }}
            onChange={(e) => onGoal(e.target.value)}
          />
        </>
      ),
    },
    {
      key: "seats", title: "Add the seats that do the work",
      body: (
        <>
          <span className="ms-step-text">{seatsText(seats)}</span>
          <span className="ms-step-acts">
            {/* A team of fewer than two is still to be described: the designer proposes it (and the person reviews it), and that is the move. */}
            {seats < 2 ? <Button variant={progress.now === "seats" ? "primary" : "soft"} icon="spark" onClick={onAsk}>Ask the designer</Button> : null}
            <Button variant="small" icon="plus" onClick={onAddSeat}>Add a seat</Button>
          </span>
        </>
      ),
    },
    {
      key: "wires", title: "Decide who may message whom",
      body: (
        <span className="ms-step-text">
          {seats < 2
            ? "Wires connect seats, so they start once there are two."
            : "A seat can start a thread only with seats it is wired to. Select a seat and drag from its arrow to another seat, or press Wire seats."}
        </span>
      ),
    },
    {
      key: "save", title: "Save, then start the mission",
      body: <span className="ms-step-text">Save changes writes mesh.yaml. Starting the mission is a separate step, in the top bar.</span>,
    },
  ];
  return (
    <section className="card ms-guide" aria-labelledby="ms-guide-title">
      <div className="ms-guide-head">
        <h3 id="ms-guide-title">Set up your team</h3>
        <Button variant="ghost" onClick={onHide}>Hide the guide</Button>
      </div>
      <ol className="ms-steps">
        {steps.map((s, i) => {
          const state = stateOf(s.key);
          return (
            <li key={s.key} className={state} aria-current={state === "now" ? "step" : undefined}>
              <span className="ms-step-mark" aria-hidden="true">{state === "done" ? <Icon name="check" size={14} /> : i + 1}</span>
              <div className="ms-step-body">
                <b>{s.title}{state === "done" ? <span className="sr-only"> (done)</span> : state === "now" ? <span className="sr-only"> (to do now)</span> : null}</b>
                {s.body}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
