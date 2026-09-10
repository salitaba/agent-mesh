# Designer Page — Senior Product Design Review (input spec)

Source: user-provided review of the mesh-dashboard Designer page, 2026-09-10.
Target: `apps/mesh-dashboard` Designer page, working tree at baseline
`398331d37b4e51cb8a056008b4cb4f214503ad2e` (dirty: dashboard + core files modified, uncommitted).

Overall score: ~7/10 visual, 6/10 UX.

## Overall impression

The product communicates: "This is a serious engineering control center for configuring
and running an AI-agent team." Good. But the page feels like several tools competing for
the same screen:

* run monitoring
* mesh designer
* agent editor
* graph editor
* file/configuration editor
* policy editor
* diagnostics
* runtime control

Everything is technically available, but the UI doesn't establish a sufficiently strong
hierarchy between these activities. High information density, lower-than-ideal cognitive
hierarchy.

---

## 1. The biggest issue: what am I supposed to do here?

At the top: build title > Designer > "Editing `/home/.../mesh.yaml`" > Crew 6 >
advisory notes > "restored unsaved draft" > the graph > an individual agent config panel >
bottom runtime controls. ~8–10 different states/tasks visible simultaneously.

A new user must figure out: am I running the system, designing it, debugging it, or
configuring an agent? The interface knows the answer; the user doesn't.

Better approach — make the current task explicit:

```text
Mesh Designer
TrackBench / line-following simulator
6 agents · 25 connections · Valid

Editing mesh
```

Establish: Workspace -> Current mesh -> Current state -> Current object, instead of putting
all concepts at the same visual level.

## 2. The top navigation/header is overloaded

Top bar contains: LIVE, build title, checks, spending, working, need you, pause, message,
decide. Especially `2.8M/230M SPENT`, `1 WORKING`, `1 NEED YOU` compete with the editing task.

Separate runtime telemetry from workspace controls:

```text
TrackBench
Mesh Designer

● Running     6 agents     25 wires     Valid

                                      Pause   Message   1 decision
```

Or a compact status strip. The most important action shouldn't compete with three numerical
metrics.

## 3. "Designer" and "Agent Mesh" terminology are slightly inconsistent

"Agent Mesh" (left), then "Designer", "Crew", "Mesh", "Policy & Budget", "Agents". Define one
clear hierarchy:

```text
Agent Mesh
 ├── Run
 │    ├── Overview
 │    ├── Steps
 │    ├── Agents
 │    └── Needs You
 │
 ├── Inspect
 │    ├── Events
 │    ├── Graph
 │    ├── Files
 │    ├── Product
 │    └── Cost
 │
 └── Build
      └── Designer
```

The left sidebar currently mixes navigation + workflow stages + debugging tools.

## 4. The graph is visually impressive, but UX-wise it's doing too much

6 nodes, many curved edges, bidirectional communication, overlapping edges, arrows crossing
the center, different node states, selection states, hidden interaction semantics. With only
six nodes it becomes visually noisy: more connections = less graph comprehension.

The hint "drag to arrange · click to inspect · hover an arrow to cut it" is hidden as tiny
text. The interaction model should be explicit, e.g. mode toolbar:

```text
[Arrange] [Connect] [Inspect] [Delete]
```

instead of forcing users to remember the model. Classic discoverability problem.

## 5. "Hover an arrow to cut it" is particularly questionable

Deleting a connection is destructive, yet the affordance is implicit. Use select edge ->
Delete (or keyboard Delete), with a tooltip/confirmation for dangerous actions:

```text
Communication
developer -> QA

[Inspect] [Disable] [Delete]
```

## 6. The right panel is strong, but too dense

Selected-agent panel: Crew / Mesh / Policy & Budget tabs; PM config has rename, duplicate,
delete, boot, role, model, runtime, mode, prompt file, permissions. Correct information, but
vertical density is high; by "CAN DO (1)" the user is already scrolling, then dozens of
permission chips. Use progressive disclosure:

```text
Agent
PM — Product Manager

General        Role / Model / Runtime / Mode
Behavior       Prompt / Startup
Permissions    13 permissions
Advanced       ...
```

Collapsed by default; show "Permissions · 13".

## 7. Permission chips need stronger information architecture

`repository.read repository.write architecture.write architecture.read review.design
code.review task.assign test.execute test.write security.scan` — powerful, but all have
approximately equal weight. Group them:

### Repository — read, write
### Architecture — read, write
### Review — design, code
### Execution — test.execute, test.write
### Security — security.scan

## 8. The bottom bar is one of the weakest areas

Region: running | copy | `/home/.../mesh.yaml` | matches running valid | template | reload
running | import | reset... | Save running mesh. Too much at once, and "Save running mesh"
is a high-impact action visually just another button. Distinguish environment/state from
actions:

```text
Running from: mesh.yaml
● Matches runtime

Reload     Import     Reset        Save changes
```

Prefer "Save to runtime" or "Apply changes" over "Save running mesh" depending on actual
behavior; if saving changes the active running system, "Apply changes" is clearest.

## 9. "Restored your unsaved draft" is good, but presentation too dominant

The banner occupies a full-width high-attention area. The user needs: (1) there is a draft,
(2) it differs from runtime, (3) keep it, (4) discard it — a version/state conflict. Make it
explicit:

```text
⚠ Unsaved local changes
Your browser draft differs from the running mesh.
[Keep draft]   [Discard draft]
```

And show `LOCAL DRAFT ≠ RUNNING` visually.

## 10. The status system is good, but needs semantic consistency

Statuses: LIVE, running, saved, valid, advisory, restored, boots, working, need you. The
problem is no obvious semantic hierarchy. Establish categories:

* System state — Running / Paused / Failed
* Configuration state — Saved / Unsaved
* Validation state — Valid / Warning / Error
* Agent state — Working / Idle / Waiting
* Human intervention — Needs you

## 11. The left sidebar is visually solid

Clear section headers, icons, labels, numbering, active state, "Needs you" notification.
But why are some nav items numbered (Overview 1, Steps 2, Agents 3, Needs you 4, Events 5,
Graph 6, Files 7) and others not? It looks like a workflow sequence rather than navigation.
If meaningful, make progression explicit; if shortcuts/hotkeys, don't display step numbers.

## 12. "Needs you" deserves much more prominence

The core value proposition: agents work autonomously, humans intervene when necessary.
"Needs you 1" appears in sidebar and top bar but neither dominates. Could become a core
concept:

```text
● Running

Agents     6
Working    1
Waiting    4
Needs you  1  <-

```

Clicking opens a focused intervention inbox. Arguably more important than most configuration UI.

## 13. "Advice" vs "Need you" needs a stronger distinction

`ADVICE 4` vs `NEED YOU 1` is good conceptually; make the distinction obvious:
Advisory = "You might want to..." vs Blocking = "I need your decision." Replace
"4 advisory notes — not blocking, worth a look" with `4 Suggestions` and
`1 Decision required`.

## 14. The page has too many borders

Almost everything is inside cards/panels/borders/pills/nested cards: panel inside panel
inside panel. Reduce borders; use spacing and background contrast to establish hierarchy:
Page -> status, graph, inspector rather than border > border > border > content. Reducing
container borders would make it feel more premium.

## 15. Typography needs slightly stronger hierarchy

Increase distinction between page title, section title, field label, field value, metadata.
Example:

```text
PRODUCT MANAGER

ROLE
product-manager

MODEL
mesh default

RUNTIME
opencode
```

Small labels are quite small; interface pushes toward terminal aesthetic where everything
becomes tiny. Be careful.

## 16. The interface feels optimized for expert users, maybe too much

Distinguish expert density vs expert usability. Experts want the right information at the
right time: `25 wires` yes; every permission visible simultaneously no; `mesh.yaml` access
yes, but its filesystem path need not always be prominent.

## 17. The product needs a clearer "source of truth"

Running mesh, local draft, saved state, YAML, editor state — which version is actually
running? Existing hint: "this console loaded. Saving overwrites it; restart to pick changes
up." That deserves an explicit state model:

```text
LOCAL mesh.yaml -> SAVED -> RUNTIME
RUNNING v1.8
LOCAL DRAFT v1.9
⚠ Runtime differs from draft
```

## 18. Buttons need stronger hierarchy

Many similar-looking buttons: pause, message, decide, discard draft, edit running mesh,
arrange, rename, duplicate, delete, reload, import, reset, save. Primary action on this
screen should probably be Save / Apply changes; everything else secondary. Destructive
actions (delete, reset, discard) should be visually and spatially separated.

## 19. The "decide" button is intriguing but ambiguous

Top-right "✓ decide" doesn't explain: decide what? Use:

* Review decision · 1
* Approve 1 request
* 1 decision required

This makes the human-agent handoff clearer.

## 20. The graph needs a better selected-object experience

Clicking an agent changes the inspector, but selection relies mostly on outline + right-side
inspector. Add a stronger visual relationship: highlight all selected node connections and
dim unrelated edges; show inbound/outbound communication paths.

## 21. One major feature I'd add: focus mode

The graph is the central conceptual object. Add Graph Focus mode hiding sidebar, inspector,
runtime controls; give graph 70–80% of viewport:

```text
[Graph Focus] [Fit] [Arrange]

     A
  ↗       ↘
PM          Architect
 ↓ ↘          ↙
QA ← Developer
```

## 22. Another major feature: search / command palette

⌘K / Ctrl+K: Search agent, Search file, Go to event, Add agent, Connect agents,
Run validation, Open PM, Show errors. Scales better than adding more buttons.

## 23. Responsive behavior is a concern

Four horizontal regions (Sidebar | agent list | graph | inspector) depend on wide screens.
Define priority:

* Wide desktop: Sidebar + crew + graph + inspector
* Medium desktop: Sidebar + graph + inspector; crew becomes drawer
* Narrow: sidebar collapses; inspector becomes drawer; crew becomes modal/drawer

## 24. Some microcopy could be significantly improved

`CREW 6` — ambiguous; prefer "6 agents" (`CREW · 6 AGENTS` keeps the product language).
`CAN DO (1)` -> "Permissions · 1 enabled".

## 25. What I would keep

* Dark visual direction
* Graph-first concept
* Agent identity colors
* Runtime information
* Local draft recovery
* Inspector panel
* Validation state

---

## Redesign hierarchy

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ Agent Mesh     TrackBench / Line-following simulator                        │
│                                                                             │
│ ● Running   6 agents   25 connections   Valid     1 decision required      │
│                                                     Pause   ...             │
├───────────────┬─────────────────────────────────────────────┬───────────────┤
│               │                                             │               │
│ RUN           │                                             │ AGENT         │
│ Overview      │                                             │               │
│ Steps         │                  MESH GRAPH                 │ PM            │
│ Agents        │                                             │               │
│ Needs you  1  │                                             │ General       │
│               │                                             │ Behavior      │
│ INSPECT       │                                             │ Permissions   │
│ Events        │                                             │               │
│ Graph         │                                             │               │
│ Files         │                                             │               │
│ Cost          │                                             │               │
│               │                                             │               │
│ BUILD         │                                             │               │
│ Designer      │                                             │               │
│               │                                             │               │
├───────────────┴─────────────────────────────────────────────┴───────────────┤
│ ⚠ Local draft differs from runtime     [Review] [Apply changes]             │
└─────────────────────────────────────────────────────────────────────────────┘
```

Mental model: Where am I (Mesh Designer) / What am I working on (TrackBench) / What's the
current state (Running, Valid, 1 decision) / What's the main object (Graph) / What am I
inspecting (selected agent) / What requires action (decision, draft conflict).

## Priority ranking

| Priority | Issue                                        | Impact    |
| -------- | -------------------------------------------- | --------- |
| P0       | Unclear primary task/state                   | Very high |
| P0       | Too much information competing for attention | Very high |
| P0       | Draft vs runtime mental model                | Very high |
| P1       | Graph interaction discoverability            | High      |
| P1       | Right-panel information density              | High      |
| P1       | Weak action hierarchy                        | High      |
| P2       | Permission organization                      | Medium    |
| P2       | Excessive borders/nested containers          | Medium    |
| P2       | Typography hierarchy                         | Medium    |
| P3       | Microcopy refinement                         | Lower     |
| P3       | More advanced shortcuts/focus mode           | Later     |

## Senior-level verdict

Not a poorly designed UI: a technically capable product whose information architecture
hasn't caught up with its functionality. Visual foundation is good; graph + inspector +
runtime concept is strong. Next maturity step: from "Show the user everything the system can
do" to "Show the user exactly what matters for the decision they are making right now."

One thing to change above everything else: make the UI answer five questions within ~2
seconds — What am I building? Is it running? Is it valid? What needs my attention? What will
happen if I press the primary button?
