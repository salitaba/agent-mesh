import { useState } from "react";
import { Button, Chip, Progress } from "../components";
import { Icon } from "../icons";
import { checkView, checksSummary, evidenceChips, goalNeedsItsCard } from "../overview-model";
import { Panel } from "./Panel";
import "./overview.css";

/** Past this many characters the goal is folded to four lines with a way to read the rest. Counted, not measured: no DOM read on render. */
const LONG_GOAL = 280;

function GoalText({ text }: { text: string }): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const long = text.length > LONG_GOAL;
  if (!text.trim()) return null;
  return (
    <>
      <p className={`ov-goal-text${long && !open ? " clamp" : ""}`}>{text.trim()}</p>
      {long ? <Button variant="linklike" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Show less" : "Show the full goal"}</Button> : null}
    </>
  );
}

/**
 * Every check against the goal, under a line that shows how many are done. A claim an agent made without verifying anything reads as
 * "claimed, not verified", differently from both done and to do, because the operator is the one who needs to know a claim is
 * standing unproven. Evidence sits on the check it supports, and a chip that names a file opens it. The goal's own text is shown
 * here only when the hero could not show all of it: a short goal is already the line under the headline, and saying it twice is noise.
 */
export function GoalChecks({ goal, arts, openArt }: { goal: any; arts: any[]; openArt: (a: any) => void }): React.JSX.Element {
  const criteria: any[] = goal?.acceptanceCriteria || [];
  const sum = checksSummary(criteria);
  return (
    <Panel id="ov-goal" className="ov-goalcard" title="Goal checks" meta={sum.total ? `${sum.done} of ${sum.total} mandatory evidenced` : undefined}>
      {sum.total ? <Progress value={sum.done} max={sum.total} label="Mandatory checks evidenced" tone="ok" /> : null}
      {goalNeedsItsCard(String(goal?.description || "")) ? <GoalText text={String(goal?.description || "")} /> : null}
      {criteria.length ? (
        <ul className="ov-checks">
          {criteria.map((c) => {
            const v = checkView(c);
            const chips = evidenceChips(c, arts);
            return (
              <li key={c.id} className="ov-check">
                <span className={`ck ${v.mark}`} aria-hidden="true">
                  {v.mark === "done" ? <Icon name="check" size={12} /> : v.mark === "claimed" ? <Icon name="alert" size={12} /> : null}
                </span>
                <div className="what">
                  <b>{c.id}</b> <span className={`word${v.mark === "claimed" ? " claimed" : ""}`}>· {v.word}</span>
                  {c.mandatory ? null : <> <Chip>optional</Chip></>}
                  <small>{c.description}</small>
                  {chips.length ? (
                    <div className="ov-ev">
                      {chips.map((ch, i) => ch.artifact
                        ? <Chip key={i} title={ch.title} onClick={() => openArt(ch.artifact)}>{ch.label}</Chip>
                        : <Chip key={i} title={ch.title}>{ch.label}</Chip>)}
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : <p className="ov-empty">This goal declares no checks.</p>}
    </Panel>
  );
}
