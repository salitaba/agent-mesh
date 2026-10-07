/**
 * The console's kit gallery (kit.html, served as /kit.html): every primitive of components.tsx drawn by the real component, in every
 * state it has, in both themes. It is what a person restyling a view photographs and checks their work against, and what
 * tests/dashboard/kit-gallery.test.ts keeps complete: a primitive exported from components.tsx that is not drawn here fails it.
 *
 * It shows no data and asks for no sign-in. The states a pointer or a keyboard puts a control in (hover, pressed, focus) are drawn with
 * the classes .is-hover, .is-active and .is-focus, which the stylesheet writes beside the real pseudo-classes, so what is shown is the
 * production rule. The overlays (a dialog, the palette, a drawer) are drawn inside a stage that contains their fixed positioning.
 */
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./kit.css";
import {
  AgentAvatar, Banner, Button, Card, Checkbox, Chip, ConfirmDialog, CopyButton, Dialog, DialogPanel, DrawerHead, EmptyState, ErrorState, EventRow,
  Field, IconButton, IdChip, Input, Kbd, LifecyclePill, Menu, OutcomePill, PageHeader, Pill, Progress, Radio, Ring, Segmented, Select, Skeleton,
  SkeletonText, Sparkline, Stat, StatusPill, StepMini, Switch, TabPanel, Tabs, TextArea, ToastCard, Tooltip, Wordmark, ZoneNote, agentColor,
  type ConfirmRequest, type MenuItem, type PillTone,
} from "./components";
import { CommandPalette, type PaletteLook } from "./commandpalette";
import { register } from "./commands";
import { Icon, ICON_NAMES, type IconName } from "./icons";
import { budgetTone } from "./cost";
import type { TimelineEvent, TurnStep } from "./store";

/* ------------------------------------------------------------------ the page's own furniture */

type ThemeChoice = "light" | "dark" | "system";
const systemTheme = (): "light" | "dark" => (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");

function applyTheme(choice: ThemeChoice): void {
  try {
    if (choice === "system") localStorage.removeItem("mesh-theme");
    else localStorage.setItem("mesh-theme", choice);
  } catch { /* the choice lasts as long as the page */ }
  document.documentElement.dataset.theme = choice === "system" ? systemTheme() : choice;
}

function savedTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem("mesh-theme");
    return v === "light" || v === "dark" ? v : "system";
  } catch { return "system"; }
}

const SECTIONS: Array<{ id: string; title: string; nav: string }> = [
  { id: "colour", title: "Colour", nav: "Colour" },
  { id: "type", title: "Type", nav: "Type" },
  { id: "depth", title: "Depth, shape and motion", nav: "Depth" },
  { id: "buttons", title: "Buttons", nav: "Buttons" },
  { id: "fields", title: "Fields and choices", nav: "Fields" },
  { id: "badges", title: "Badges and tags", nav: "Badges" },
  { id: "surfaces", title: "Cards and tables", nav: "Cards" },
  { id: "feedback", title: "Banners and states", nav: "States" },
  { id: "charts", title: "Meters and charts", nav: "Charts" },
  { id: "navigation", title: "Tabs, menus and tips", nav: "Menus" },
  { id: "overlays", title: "Dialogs, panels and notices", nav: "Overlays" },
  { id: "shell", title: "The shell", nav: "Shell" },
  { id: "icons", title: "Icons", nav: "Icons" },
];

function Section({ id, title, lede, children }: { id: string; title: string; lede?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="gal-sec" id={id} aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>{title}</h2>
      {lede ? <p className="gal-lede">{lede}</p> : null}
      {children}
    </section>
  );
}

/** A captioned specimen. */
function Spec({ name, note, wide, short, tall, children }: { name: string; note?: string; wide?: boolean; short?: boolean; tall?: boolean; children: React.ReactNode }): React.JSX.Element {
  return (
    <figure className={`gal-spec${wide ? " wide" : ""}${short ? " short" : ""}${tall ? " tall" : ""}`}>
      <div className="gal-cap"><b>{name}</b>{note ? <span>{note}</span> : null}</div>
      <div className="gal-body">{children}</div>
    </figure>
  );
}

/** A column of states, each under its own name. */
function States({ items }: { items: Array<[string, React.ReactNode]> }): React.JSX.Element {
  return (
    <div className="gal-states">
      {items.map(([name, node]) => (
        <div className="gal-state" key={name}>
          <span className="gal-state-name">{name}</span>
          {node}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ colour */

const ROLES: Array<{ group: string; tokens: Array<[string, string]> }> = [
  { group: "Ground", tokens: [["--bg", "the page"], ["--bg-2", "the frame: sidebar, top bar"], ["--panel", "a card"], ["--panel-2", "a hovered row, a table head"], ["--sunken", "a well, a track, a code block"], ["--raised", "a card inside a drawer"], ["--drawer", "the panel on the right"]] },
  { group: "Lines", tokens: [["--line", "a hairline"], ["--line-strong", "the edge of a raised thing"], ["--line-control", "the edge of a field (3:1)"]] },
  { group: "Text", tokens: [["--text", "what a block is about"], ["--text-dim", "the sentence that explains it"], ["--muted", "what labels and dates it"]] },
  { group: "Accent", tokens: [["--k-accent", "a fill, a ring"], ["--k-accent-hover", "the fill under the pointer"], ["--k-accent-press", "the fill pressed"], ["--k-accent-ink", "the blue as text"], ["--k-accent-soft", "selected, active"], ["--accent", "the console's accent (views)"], ["--accent-2", "the console's accent as text"]] },
  { group: "Status", tokens: [["--ok", "done, running well"], ["--warn", "worth a look"], ["--bad", "a fault"], ["--rej", "refused by the kernel"], ["--info", "completed, information"]] },
];

function Swatch({ token, use, version }: { token: string; use: string; version: number }): React.JSX.Element {
  const [value, setValue] = useState("");
  useEffect(() => {
    setValue(getComputedStyle(document.documentElement).getPropertyValue(token).trim());
  }, [token, version]);
  return (
    <li className="gal-swatch">
      <span className="chipc" style={{ background: `var(${token})` }} />
      <span className="meta"><b>{token}</b><span>{use}</span><code>{value}</code></span>
    </li>
  );
}

/* ------------------------------------------------------------------ fixtures: the sample data these specimens are drawn from */

const SAMPLE_EVENT: TimelineEvent = { seq: 14, id: "gallery-14", type: "agent.created", timestamp: "2026-10-07T07:36:41.000Z", payload: { agent: { id: "explorer", role: "explorer" } } };
const SAMPLE_STEP: TurnStep = {
  turnId: "turn-gallery-1", agentId: "developer", reasonKind: "new-message", startedAt: new Date(Date.now() - 42_000).toISOString(), endedAt: new Date(Date.now() - 38_000).toISOString(),
  durationMs: 4000, status: "ok", lifecycle: "idle", ops: { messages: 1, artifacts: 1, tasks: 0, decisions: 0 }, messageIds: [], artifactIds: [], tokens: 1800, seqStart: 10, seqEnd: 14, eventCount: 5,
};

const CONFIRM_PLAIN: ConfirmRequest = {
  title: "Start the mission?",
  body: ["This is a scripted team. It makes no model calls and spends nothing, and it runs until it finishes or you park the mission."],
  confirmLabel: "Start the mission",
};
const CONFIRM_DANGER: ConfirmRequest = {
  title: "Reset the mission to zero?",
  body: ["Every event, message, file and decision of this mission is deleted, and the goal starts again from nothing.", "This cannot be undone."],
  confirmLabel: "Reset the mission",
  danger: true,
  require: { kind: "match", value: "demo", label: "Type the project's name to arm the button" },
};

const BUTTON_STATES: Array<[string, { cls?: string; disabled?: boolean; loading?: boolean }]> = [
  ["Default", {}], ["Hover", { cls: "is-hover" }], ["Pressed", { cls: "is-active" }], ["Focus", { cls: "is-focus" }], ["Disabled", { disabled: true }], ["Loading", { loading: true }],
];

const noop = (): void => undefined;
const MENU_SAMPLE: MenuItem[] = [
  { icon: "approve", label: "Approve or reject…", onClick: noop },
  { icon: "undo", label: "Reopen with feedback", onClick: noop },
  { icon: "bell", label: "Notify me when the mission needs me", hint: "n", onClick: noop },
  { icon: "trash", label: "Reset mission to zero…", danger: true, separated: true, onClick: noop },
];

const PILL_TONES: PillTone[] = ["neutral", "accent", "ok", "warn", "bad", "info"];

const TAB_SET = [
  { id: "now", label: "Now" },
  { id: "work", label: "Work", badge: 12 },
  { id: "comms", label: "Comms", badge: 3, badgeHot: true },
  { id: "memory", label: "Memory" },
];

const PALETTE_GROUPS = ["Go to", "Agents", "Actions"] as const;
const lookOf = (c: { id: string }): PaletteLook => {
  if (c.id.startsWith("go.")) return { group: "Go to", icon: (({ overview: "overview", agents: "agents", steps: "steps", cost: "cost" }) as Record<string, IconName>)[c.id.slice(3)] ?? "arrow-right", hint: c.id.endsWith("overview") ? "1" : undefined };
  if (c.id.startsWith("agent.")) return { group: "Agents", icon: "agents" };
  return { group: "Actions", icon: c.id === "help.open" ? "help" : "spark", hint: c.id === "help.open" ? "?" : undefined };
};

function Gallery(): React.JSX.Element {
  const [theme, setTheme] = useState<ThemeChoice>(savedTheme);
  const [version, setVersion] = useState(0);
  const [tab, setTab] = useState("now");
  const [seg, setSeg] = useState("5m");
  const [open, setOpen] = useState<null | "plain" | "danger" | "dialog">(null);
  const [checked, setChecked] = useState(true);

  useEffect(() => {
    register("gallery", [
      { id: "go.overview", label: "Go to Overview", scope: "global", run: () => undefined },
      { id: "go.agents", label: "Go to Agents", scope: "global", run: () => undefined },
      { id: "go.steps", label: "Go to Steps", scope: "global", run: () => undefined },
      { id: "go.cost", label: "Go to Cost", scope: "global", run: () => undefined },
      { id: "agent.developer", label: "Jump to agent: developer", scope: "global", run: () => undefined },
      { id: "agent.qa", label: "Jump to agent: qa", scope: "global", run: () => undefined },
      { id: "help.open", label: "Open help", scope: "global", run: () => undefined },
      { id: "chat.ask", label: "Ask the designer", scope: "global", run: () => undefined },
    ]);
  }, []);

  const choose = (c: ThemeChoice): void => {
    setTheme(c);
    applyTheme(c);
    setVersion((v) => v + 1);
  };

  return (
    <>
      <header className="gal-top">
        <div className="gal-top-in">
          <Wordmark height={22} />
          <span className="gal-title">Console kit</span>
          <nav className="gal-nav" aria-label="Sections">
            {SECTIONS.map((s) => <a key={s.id} href={`#${s.id}`} title={s.title}>{s.nav}</a>)}
          </nav>
          <Segmented label="Theme" value={theme} onChange={choose} options={[{ id: "light", label: "Light" }, { id: "dark", label: "Dark" }, { id: "system", label: "System" }]} />
        </div>
      </header>

      <main className="gal-main">
        <PageHeader
          title="Console kit"
          lede="Every primitive the console is built from, drawn by the real component, in every state it has. Hover and focus a control to see the rest. The page follows the theme above."
        />

        {/* -------------------------------------------------------------------------------- colour */}
        <Section id="colour" title="Colour" lede="Neutrals and one blue; the status colours are for status. Each name is the token a stylesheet uses, with the value it has in this theme.">
          {ROLES.map((g) => (
            <div key={g.group}>
              <h3 className="gal-h3">{g.group}</h3>
              <ul className="gal-swatches">{g.tokens.map(([t, u]) => <Swatch key={t} token={t} use={u} version={version} />)}</ul>
            </div>
          ))}
        </Section>

        {/* -------------------------------------------------------------------------------- type */}
        <Section id="type" title="Type" lede="The system's own fonts, nothing downloaded. A page title is 24, a card's label is small capitals, a figure is the sans at 650 with tabular numerals; monospace is for ids, paths and code.">
          <div className="gal-grid two">
            <Spec name="The ramp" note="11 12 13 14 15 16 18 20 24 30">
              <div className="gal-ramp">
                {[11, 12, 13, 14, 15, 16, 18, 20, 24, 30].map((n) => <div key={n} style={{ fontSize: n }}><span className="gal-n">{n}</span>Build and ship a small idempotent payment endpoint.</div>)}
              </div>
            </Spec>
            <Spec name="Roles">
              <div className="gal-roles">
                <div><span className="caps">Label in capitals</span></div>
                <div className="view-title"><h2>Page title</h2></div>
                <div><b className="fig">49.3k</b> <span className="muted">tokens, a figure</span></div>
                <div><b className="fig lg">7 of 7</b></div>
                <div><span className="fig sm">22s</span> <span className="muted">small figure</span></div>
                <div className="mono">src/tx/Pipeline.java · goal-M4AMP2070</div>
                <p className="prose" style={{ margin: 0, maxWidth: "52ch" }}>Body text is 15 pixels on a 1.5 line, and a sentence that explains it is the second ink. <span className="muted">What dates it is the third.</span></p>
              </div>
            </Spec>
            <Spec name="Tabular figures" note="a column of numbers lines up">
              <div className="num-col">
                {["14.4k", "9.0k", "9.0k", "7.2k", "5.4k", "650"].map((n, i) => <div key={i}><span className="muted">{["tech-lead", "architect", "qa", "pm", "developer", "explorer"][i]}</span><b>{n}</b></div>)}
              </div>
            </Spec>
          </div>
        </Section>

        {/* -------------------------------------------------------------------------------- depth */}
        <Section id="depth" title="Depth, shape and motion" lede="Elevation says what can be pressed and what floats. Static text stays flat. Shadows are soft and layered, and in dark a lit top edge does the work a shadow cannot.">
          <div className="gal-grid">
            {[
              ["1", "a card on the page"],
              ["2", "a card that can be pressed, hovered"],
              ["3", "a menu, a toast, a tooltip"],
              ["4", "a dialog, a drawer"],
              ["5", "the hero's device frame"],
            ].map(([n, use]) => (
              <div key={n} className="gal-rung" style={{ boxShadow: `var(--k-hl), var(--k-shadow-${n})` }}><b>Rung {n}</b><span>{use}</span></div>
            ))}
          </div>
          <div className="gal-grid">
            {[["xs", "4", "a key"], ["sm", "6", "a small control"], ["md", "10", "a button, a field"], ["lg", "14", "a card"], ["xl", "20", "a dialog"], ["pill", "999", "a badge"]].map(([n, px, use]) => (
              <div key={n} className="gal-radius" style={{ borderRadius: `var(--k-r-${n})` }}><b>{n} · {px}</b><span>{use}</span></div>
            ))}
          </div>
          <div className="gal-grid">
            {[["1", "120 ms", "a hover, a press"], ["2", "180 ms", "a menu, a tooltip, a dialog"], ["3", "300 ms", "a panel, a bar's fill"]].map(([n, ms, use]) => (
              <div key={n} className="gal-motion" tabIndex={0}>
                <b>{ms}</b><span>{use}</span>
                <i style={{ transitionDuration: `var(--k-dur-${n})` }} />
              </div>
            ))}
          </div>
        </Section>

        {/* -------------------------------------------------------------------------------- buttons */}
        <Section id="buttons" title="Buttons" lede="One primary per view. A small button is a row action. Every one has hover, pressed, focus, disabled and loading states.">
          <div className="gal-matrix" role="table" aria-label="Button states">
            <div className="gal-matrix-head" role="row"><span role="columnheader"><span className="sr-only">Variant</span></span>{BUTTON_STATES.map(([n]) => <span key={n} role="columnheader">{n}</span>)}</div>
            {([
              ["Primary", "primary", false, "play"],
              ["Secondary", "soft", false, "message"],
              ["Small", "small", false, "copy"],
              ["Ghost", "ghost", false, "refresh"],
              ["Secondary, danger", "soft", true, "trash"],
              ["Primary, danger", "primary", true, "trash"],
              ["Banner action", "banner-act", false, "refresh"],
            ] as const).map(([name, variant, danger, icon]) => (
              <div className="gal-matrix-row" role="row" key={name}>
                <span className="gal-rowname" role="rowheader">{name}</span>
                {BUTTON_STATES.map(([state, s]) => (
                  <span role="cell" key={state}>
                    {variant === "primary"
                      ? <Button variant="primary" icon={icon} danger={danger} extra={s.cls} disabled={s.disabled} loading={s.loading}>{danger ? "Reset" : "Start mission"}</Button>
                      : variant === "soft"
                        ? <Button variant="soft" icon={icon} danger={danger} extra={s.cls} disabled={s.disabled} loading={s.loading}>{danger ? "Remove" : "Message"}</Button>
                        : variant === "small"
                          ? <Button variant="small" icon={icon} extra={s.cls} disabled={s.disabled} loading={s.loading}>Copy id</Button>
                          : variant === "ghost"
                            ? <Button variant="ghost" icon={icon} extra={s.cls} disabled={s.disabled} loading={s.loading}>Refresh</Button>
                            : <Button variant="banner-act" icon={icon} extra={s.cls} disabled={s.disabled} loading={s.loading}>Retry now</Button>}
                  </span>
                ))}
              </div>
            ))}
          </div>
          <div className="gal-grid two">
            <Spec name="Sizes" note="28, 36 and 44; phones get 44 for all">
              <div className="gal-row"><Button variant="small">Small</Button><Button variant="primary">Default</Button><Button variant="primary" size="lg">Large</Button></div>
            </Spec>
            <Spec name="A link that does something">
              <p style={{ margin: 0 }}>Nothing is waiting for you. <Button variant="linklike">Open the events</Button> to see what the team did.</p>
            </Spec>
            <Spec name="Icon buttons" note="a tooltip names each; point at one">
              <div className="gal-row">
                <IconButton icon="sun" label="Switch to the light theme" keys="t" onClick={() => undefined} />
                <IconButton icon="help" label="Keyboard shortcuts and help" keys="?" onClick={() => undefined} />
                <IconButton icon="sign-out" label="Sign out" onClick={() => undefined} />
                <IconButton icon="bell" label="Notifications on" pressed onClick={() => undefined} />
                <IconButton icon="x" label="Close" size="sm" onClick={() => undefined} />
                <IconButton icon="trash" label="Delete (not allowed here)" disabled onClick={() => undefined} />
                <IconButton icon="refresh" label="Refresh" extra="is-hover" onClick={() => undefined} />
                <IconButton icon="refresh" label="Refresh, pressed" extra="is-active" onClick={() => undefined} />
              </div>
            </Spec>
            <Spec name="Copy and ids" note="says what happened">
              <div className="gal-row"><CopyButton text="goal-M4AMP2070" what="goal id" /><CopyButton text="goal-M4AMP2070" what="goal id" compact /><IdChip value="turn-0192a7c2-5f3e-7d10-9c4b-111111111111" label="turn id" /></div>
            </Spec>
          </div>
        </Section>

        {/* -------------------------------------------------------------------------------- fields */}
        <Section id="fields" title="Fields and choices" lede="The edge of a field is the one that clears 3:1. Focus turns it to the accent with a ring; a field that is wrong says what to do about it under it, and says so to a screen reader.">
          <div className="gal-grid two">
            <Spec name="Text, textarea, select" wide>
              <States items={[
                ["Default", <Input key="a" placeholder="Agent or word…" aria-label="Default" />],
                ["Hover", <Input key="b" extra="is-hover" defaultValue="Hovered" aria-label="Hover" />],
                ["Focus", <Input key="c" extra="is-focus" defaultValue="Focused" aria-label="Focus" />],
                ["Disabled", <Input key="d" disabled defaultValue="Not editable" aria-label="Disabled" />],
                ["Invalid", <Field key="e" label="Project name" error="Use letters, digits and dashes only."><Input defaultValue="my project!" /></Field>],
                ["With a hint", <Field key="f" label="Budget" hint="Tokens for the whole mission. 0 means no limit."><Input mono defaultValue="2000000" /></Field>],
                ["Select", <Select key="g" aria-label="Type" defaultValue="all"><option value="all">All types</option><option>ArchitectureDocument</option></Select>],
                ["Select, focus", <Select key="h" extra="is-focus" aria-label="Type, focus" defaultValue="all"><option value="all">All types</option></Select>],
                ["Textarea", <TextArea key="i" rows={3} placeholder="Say it in plain words" aria-label="Message" />],
              ]} />
            </Spec>
            <Spec name="Checkbox, radio, switch" wide>
              <States items={[
                ["Checkbox", <Checkbox key="a" label="Run them right after sending" checked={checked} onChange={(e) => setChecked(e.target.checked)} />],
                ["Unchecked", <Checkbox key="b" label="Send a raw JSON payload instead" defaultChecked={false} />],
                ["With a hint", <Checkbox key="c" label="Must pass" hint="The mission is not delivered until this check is evidenced." defaultChecked />],
                ["Hover", <label key="d" className="chk"><input type="checkbox" className="is-hover" /> Hover</label>],
                ["Focus", <label key="e" className="chk"><input type="checkbox" className="is-focus" defaultChecked /> Focus</label>],
                ["Disabled", <Checkbox key="f" label="Disabled, checked" defaultChecked disabled />],
                ["Radio", <div key="g" className="gal-col"><Radio name="gal-r" label="Own key" defaultChecked /><Radio name="gal-r" label="The host's key" /><Radio name="gal-r" label="Disabled" disabled /></div>],
                ["Switch", <div key="h" className="gal-col"><Switch label="Notify me when a decision waits" defaultChecked /><Switch label="Off" /><Switch label="Disabled" disabled /></div>],
              ]} />
            </Spec>
          </div>
        </Section>

        {/* -------------------------------------------------------------------------------- badges */}
        <Section id="badges" title="Badges and tags" lede="A word with a state: the status colour as text on a 14% tint of itself, and a dot that says it in shape too.">
          <div className="gal-grid two">
            <Spec name="Pill" note="neutral, accent and the four statuses">
              <div className="gal-row">{PILL_TONES.map((t) => <Pill key={t} tone={t}>{t}</Pill>)}<Pill tone="ok" pulse>live</Pill><Pill tone="neutral" dot={false}>no dot</Pill></div>
            </Spec>
            <Spec name="Status, lifecycle, outcome" note="derived from domain state">
              <div className="gal-row">
                <StatusPill status="running" /><StatusPill status="waiting" /><StatusPill status="blocked" /><StatusPill status="ok" />
                <LifecyclePill lifecycle="IDLE" /><LifecyclePill lifecycle="WORKING" pulse />
                <OutcomePill step={SAMPLE_STEP} />
              </div>
            </Spec>
            <Spec name="Chip" note="a tag: a word, or an id in mono">
              <div className="gal-row"><Chip>in progress</Chip><Chip hot>can decide</Chip><Chip warn>stale</Chip><Chip mono>read_artifacts</Chip><Chip onClick={() => undefined}>pressable</Chip></div>
            </Spec>
            <Spec name="Toggle chips" note="a filter that stays visible">
              <div className="chips" role="group" aria-label="Recipients">
                <button type="button" className="chip-toggle on" aria-pressed="true"><Icon name="check" size={12} />developer</button>
                <button type="button" className="chip-toggle" aria-pressed="false"><Icon name="plus" size={12} />qa</button>
                <button type="button" className="chip-toggle is-hover" aria-pressed="false"><Icon name="plus" size={12} />hover</button>
                <button type="button" className="fchip on o-ship"><span className="fchip-dot" />Produced <span className="fchip-n">16</span></button>
                <button type="button" className="fchip"><span className="fchip-dot" />Blocked <span className="fchip-n">0</span></button>
              </div>
            </Spec>
            <Spec name="Keys">
              <div className="gal-row"><Kbd keys="mod+k" /><Kbd keys="shift+/" /><Kbd>Esc</Kbd><Kbd keys="up" /><Kbd keys="down" /><Kbd keys="enter" /></div>
            </Spec>
            <Spec name="Avatars" note="the seat's letter on its role colour">
              <div className="gal-row">
                {(["pm", "architect", "developer", "qa", "security", "tech-lead", "explorer"] as const).map((r) => <AgentAvatar key={r} id={r} color={agentColor(r)} />)}
                <AgentAvatar id="human" /><AgentAvatar id="developer" size="sm" color={agentColor("developer")} /><AgentAvatar id="qa" size="lg" color={agentColor("qa")} />
              </div>
            </Spec>
            <Spec name="Zone note" note="said once above a run of times"><span className="caps">Just happened<ZoneNote /></span></Spec>
            <Spec name="Rows" note="what the Overview lists">
              <div className="gal-col wide"><EventRow e={SAMPLE_EVENT} onOpen={() => undefined} /><StepMini s={SAMPLE_STEP} onOpen={() => undefined} /></div>
            </Spec>
          </div>
        </Section>

        {/* -------------------------------------------------------------------------------- surfaces */}
        <Section id="surfaces" title="Cards and tables" lede="A card sits on the page. A card that can be pressed rises a pixel and takes the next shadow. Figures are tabular and right-aligned.">
          <div className="gal-grid three">
            <Card title="Mission budget" meta="2% used" actions={<Button variant="small">What it cost</Button>}>
              <div className="kpi"><b>49.3k</b><small>of 2.0M tokens</small></div>
              <Progress value={49300} max={2000000} label="Mission token budget" valueText="49.3k of 2.0M tokens" size="lg" />
            </Card>
            <Card title="Pressable" interactive meta="hover it"><p style={{ margin: 0 }}>Rung 2 on hover, a pixel up, pressed back down.</p></Card>
            <Card title="Pressable, hovered" interactive variant="is-hover"><p style={{ margin: 0 }}>The hover state, held for the picture.</p></Card>
          </div>
          <div className="gal-grid two">
            <Spec name="Table" wide note="head in small capitals, first column names the row, clickable rows hover, one is selected">
              <table className="tbl">
                <thead><tr><th>Agent</th><th>Turns</th><th className="num">Tokens</th><th className="num">Share</th></tr></thead>
                <tbody>
                  <tr className="clickable"><td>tech-lead</td><td>8</td><td className="num">14.4k</td><td className="num">29%</td></tr>
                  <tr className="clickable on"><td>architect</td><td>5</td><td className="num">9.0k</td><td className="num">18%</td></tr>
                  <tr className="clickable is-hover"><td>qa</td><td>5</td><td className="num">9.0k</td><td className="num">18%</td></tr>
                  <tr><td>pm</td><td>4</td><td className="num">7.2k</td><td className="num">15%</td></tr>
                </tbody>
              </table>
            </Spec>
            <Spec name="Dense table" wide>
              <table className="tbl dense">
                <tbody>
                  <tr><td>listens for</td><td><Chip mono>message.sent</Chip> <Chip mono>task.claimed</Chip></td></tr>
                  <tr><td>can decide</td><td><Chip hot>release</Chip></td></tr>
                  <tr><td>model</td><td className="mono">stub-model</td></tr>
                </tbody>
              </table>
            </Spec>
          </div>
          <div className="gal-grid two">
            <Spec name="Stat" note="a figure with its label; a row of them is .stats" wide>
              <div className="stats">
                <Stat label="Tokens" value="49.3k" unit="of 2.0M" sub="2% of the budget"><Progress value={49300} max={2000000} label="Mission token budget" /></Stat>
                <Stat label="Turns" value="28" sub="16 produced, 12 with no output" />
                <Stat label="Failed" value="3" tone="bad" sub="2 of them were retried" />
                <Stat label="Evidenced" value="7 of 7" tone="ok" sub="every mandatory check" />
              </div>
            </Spec>
            <Spec name="Stat, large and small" note="30 for the one that matters on a page, 16 beside prose">
              <div className="gal-row">
                <Stat size="lg" label="Delivered in" value="4m 12s" />
                <Stat size="sm" label="Per turn" value="1.8k" unit="tokens" />
              </div>
            </Spec>
            <Spec name="Facts" note="dl.kv: the name, then the value">
              <dl className="kv">
                <dt>Role</dt><dd>developer</dd>
                <dt>Model</dt><dd className="mono">stub-model</dd>
                <dt>Listens for</dt><dd><Chip mono>message.sent</Chip> <Chip mono>task.claimed</Chip></dd>
                <dt>Goal</dt><dd><IdChip value="goal-M4AMP2070" label="goal id" /></dd>
              </dl>
            </Spec>
            <Spec name="Rows" note=".rows: a list that is not a table; one is chosen, one is under the pointer" wide>
              <ul className="rows">
                <li className="clickable on"><AgentAvatar id="developer" size="sm" color={agentColor("developer")} /><span>developer</span><span className="muted" style={{ marginLeft: "auto" }}>working</span></li>
                <li className="clickable is-hover"><AgentAvatar id="qa" size="sm" color={agentColor("qa")} /><span>qa</span><span className="muted" style={{ marginLeft: "auto" }}>idle</span></li>
                <li className="clickable"><AgentAvatar id="pm" size="sm" color={agentColor("pm")} /><span>pm</span><span className="muted" style={{ marginLeft: "auto" }}>idle</span></li>
              </ul>
            </Spec>
            <Spec name="Disclosure" note="details.disc: the chevron turns">
              <div className="gal-col wide">
                <details className="disc"><summary>Show the raw payload</summary><pre className="code" style={{ marginTop: "var(--s2)" }}>{"{ \"agent\": { \"id\": \"explorer\" } }"}</pre></details>
                <details className="disc" open><summary>What was checked</summary><p className="muted" style={{ margin: "var(--s2) 0 0" }}>Seven checks, each with the artifact that evidences it.</p></details>
              </div>
            </Spec>
          </div>
        </Section>

        {/* -------------------------------------------------------------------------------- feedback */}
        <Section id="feedback" title="Banners and states" lede="Empty, loading and error are designed. A banner says what is true and offers the move that answers it.">
          <div className="gal-grid one">
            <Banner tone="info" title="The project is parked." actions={<Button variant="banner-act" icon="play">Start mission</Button>}>Nothing runs on its own until it is started.</Banner>
            <Banner tone="ok" title="Delivered.">Every mandatory check is evidenced.</Banner>
            <Banner tone="warn" title="More projects are open than the plan allows." actions={<Button variant="banner-act">See plan</Button>}>2 are open; the Community plan allows 1. Nothing is refused.</Banner>
            <Banner tone="bad" title="Server not responding." actions={<Button variant="banner-act" icon="refresh">Retry now</Button>}>Showing the last known state, which may be stale. Is the mesh process still running?</Banner>
          </div>
          <div className="gal-grid three">
            <Card><EmptyState icon="inbox" title="Nothing is waiting for you" action={<><Button variant="primary" icon="steps">Open the steps</Button><Button variant="linklike">What counts as a decision</Button></>}>Decisions the team cannot make for itself appear here, with what each one holds up.</EmptyState></Card>
            <Card><ErrorState what="the files" detail="The mesh server did not answer. It may be restarting." onRetry={() => undefined} /></Card>
            <Card>
              <div className="gal-col wide" role="status" aria-label="Loading sample">
                <div className="gal-row"><Skeleton w={30} h={30} round /><div style={{ flex: 1 }}><SkeletonText lines={2} /></div></div>
                <Skeleton h={72} />
                <SkeletonText lines={3} />
              </div>
            </Card>
          </div>
        </Section>

        {/* -------------------------------------------------------------------------------- charts */}
        <Section id="charts" title="Meters and charts" lede="Always beside the figure they draw. The fill is the accent, or the status colour when the figure says so, and it animates in 300 ms. The data here is sample data.">
          <div className="gal-grid two">
            <Spec name="Progress" wide>
              <div className="gal-col wide">
                {([[0.2, undefined], [0.62, undefined], [0.86, "warn"], [0.97, "bad"], [1, "ok"]] as const).map(([r, t]) => (
                  <div className="gal-prog" key={r}><Progress value={r * 100} label={`${Math.round(r * 100)} percent`} tone={t ?? (budgetTone(r) === "ok" ? undefined : budgetTone(r))} /><b>{Math.round(r * 100)}%</b></div>
                ))}
                <Progress value={46} label="The one that matters on a page" size="lg" />
              </div>
            </Spec>
            <Spec name="Sparkline" note="activity over a short window">
              <div className="gal-row">
                <Sparkline values={[2, 3, 2, 5, 4, 6, 9, 7, 11, 10, 14, 12]} label="Tokens per minute, last 12 minutes (sample)" width={120} height={32} />
                <Sparkline values={[8, 8, 7, 9, 12, 14, 13, 15, 18, 22]} tone="warn" label="A rising spend (sample)" width={120} height={32} />
                <Sparkline values={[5, 5, 5, 5]} tone="muted" label="Flat (sample)" width={120} height={32} />
                <Sparkline values={[4]} label="One point (sample)" width={60} height={32} />
                <Sparkline values={[]} label="No data" width={60} height={32} />
              </div>
            </Spec>
            <Spec name="Ring" note="a part of a whole, or what a whole is made of">
              <div className="gal-row">
                <Ring value={7} max={7} tone="ok" size={72} label="7 of 7 checks evidenced"><b>7</b><small>of 7</small></Ring>
                <Ring value={2} max={7} size={72} label="2 of 7 checks evidenced"><b>2</b><small>of 7</small></Ring>
                <Ring value={92} max={100} tone="bad" size={72} round label="92 percent of the budget spent"><b>92%</b><small>spent</small></Ring>
                <Ring size={72} label="28 turns: 16 produced, 12 with no output, 0 refused" segments={[{ value: 16, tone: "ok" }, { value: 12, tone: "muted" }]}><b>28</b><small>turns</small></Ring>
              </div>
            </Spec>
          </div>
        </Section>

        {/* -------------------------------------------------------------------------------- navigation */}
        <Section id="navigation" title="Tabs, menus and tips" lede="A line slides under the tab that is selected. A menu is a panel that belongs to its trigger.">
          <div className="gal-grid two">
            <Spec name="Tabs" wide note="arrow keys move; counts are measured">
              <Tabs idPrefix="gal" label="Agent panel" tabs={TAB_SET} value={tab} onChange={setTab} />
              <TabPanel idPrefix="gal" id={tab}><p className="muted" style={{ margin: 0 }}>The “{tab}” panel.</p></TabPanel>
            </Spec>
            <Spec name="Segmented" note="the same, as a trough">
              <div className="gal-col">
                <Tabs idPrefix="galseg" label="Range" variant="segmented" tabs={[{ id: "5m", label: "5m" }, { id: "30m", label: "30m" }, { id: "2h", label: "2h" }, { id: "all", label: "All" }]} value={seg} onChange={setSeg} />
                <TabPanel idPrefix="galseg" id={seg}><p className="muted" style={{ margin: 0 }}>Showing “{seg}”.</p></TabPanel>
                <Segmented label="Show" value={seg} onChange={setSeg} options={[{ id: "5m", label: "5m" }, { id: "30m", label: "30m" }, { id: "2h", label: "2h" }, { id: "all", label: "All" }]} />
              </div>
            </Spec>
            <Spec name="Menu" note="open; rows are 36 high">
              <div className="gal-menu-stage">
                <Menu defaultOpen align="left" label={<Icon name="more" size={18} />} title="More actions" items={MENU_SAMPLE} />
              </div>
            </Spec>
            <Spec name="Tooltip" note="point at them; they wait 400 ms">
              <div className="gal-row">
                <Tooltip content="Search views, agents and actions" keys="mod+k"><Button variant="soft" icon="search">Search</Button></Tooltip>
                <Tooltip content="Something longer: what a control does when its name is not enough, in a sentence." side="bottom"><Button variant="ghost" icon="info">More</Button></Tooltip>
              </div>
            </Spec>
          </div>
        </Section>

        {/* -------------------------------------------------------------------------------- overlays */}
        <Section id="overlays" title="Dialogs, panels and notices" lede="Rung 3 and 4 float over the page on a blurred scrim. They arrive in 180 ms (a panel in 240) and are still under reduced motion.">
          <div className="gal-grid two">
            <Spec name="Dialog" wide note="the panel, drawn alone">
              <div className="gal-stage short">
                <div className="confirm-scrim" />
                <DialogPanel title="Start the mission?" role="dialog" labelId="gal-dlg" actions={<><Button variant="soft">Cancel</Button><Button variant="primary" icon="play">Start the mission</Button></>}>
                  <p style={{ margin: 0, color: "var(--text-dim)" }}>This is a scripted team. It makes no model calls and spends nothing, and it runs until it finishes or you park the mission.</p>
                </DialogPanel>
              </div>
            </Spec>
            <Spec name="Dialog, destructive" wide note="a name to type arms the red button">
              <div className="gal-stage short">
                <div className="confirm-scrim" />
                <DialogPanel title="Reset the mission to zero?" role="alertdialog" labelId="gal-dlg2" actions={<><Button variant="soft">Cancel</Button><Button variant="primary" danger disabled>Reset the mission</Button></>}>
                  <p style={{ margin: 0, color: "var(--text-dim)" }}>Every event, message, file and decision of this mission is deleted. This cannot be undone.</p>
                  <label className="confirm-field"><span>Type the project’s name to arm the button</span><Input placeholder="demo" /></label>
                </DialogPanel>
              </div>
            </Spec>
            <Spec name="Open the real ones" short note="focus moves in, Tab stays, Escape closes">
              <div className="gal-row">
                <Button variant="soft" onClick={() => setOpen("plain")}>Confirm</Button>
                <Button variant="soft" danger onClick={() => setOpen("danger")}>Destructive confirm</Button>
                <Button variant="soft" onClick={() => setOpen("dialog")}>Dialog</Button>
              </div>
            </Spec>
            <Spec name="Toasts" note="tone icon, title, detail, one action">
              <div className="gal-toasts">
                <ToastCard kind="ok" title="Mission paused" msg="Agents finish the turn they are in, then stop." action={{ label: "Undo", run: () => undefined }} />
                <ToastCard kind="warn" title="The run did not start" msg="The host runs one script at a time, and one is already going." />
                <ToastCard kind="bad" title="Could not send the response" msg="The server did not answer." count={3} />
                <ToastCard title="Agents are running" msg="pm is starting." />
              </div>
            </Spec>
            <Spec name="Command palette" wide note="grouped until something is typed">
              <div className="gal-stage tall">
                <div className="confirm-scrim" />
                <CommandPalette onClose={() => undefined} look={lookOf} groups={PALETTE_GROUPS} autoFocus={false} />
              </div>
            </Spec>
            <Spec name="Panel on the right" wide note="a title row that stays put, a hairline, the body">
              <div className="gal-stage tall">
                <div className="confirm-scrim" />
                <div className="drawer">
                  <DrawerHead onClose={() => undefined}>Message an agent</DrawerHead>
                  <p className="muted" style={{ marginTop: 0 }}>You write as the human, the one seat every agent listens to.</p>
                  <form className="stack" onSubmit={(e) => e.preventDefault()}>
                    <Field label="To" hint="Pick the agents, or type their names separated by commas."><Input placeholder="Choose an agent" /></Field>
                    <Field label="Message"><TextArea rows={3} placeholder="Say it in plain words" /></Field>
                    <Checkbox label="Run them right after sending" defaultChecked />
                    <div className="row"><Button variant="primary" type="submit">Send</Button></div>
                  </form>
                </div>
              </div>
            </Spec>
          </div>
        </Section>

        {/* -------------------------------------------------------------------------------- shell */}
        <Section id="shell" title="The shell" lede="The sidebar row, the mission chip, the readouts in the top bar and the project strip, as the console draws them.">
          <div className="gal-grid two">
            <Spec name="Sidebar rows" tall note="default, hover, current, with a count">
              <div className="gal-side">
                <button type="button" className="side-search"><Icon name="search" size={18} /><span>Search</span><Kbd keys="mod+k" /></button>
                <button type="button" className="tab"><Icon name="overview" size={18} /><span className="tab-label">Overview</span></button>
                <button type="button" className="tab is-hover"><Icon name="inbox" size={18} /><span className="tab-label">Needs you</span><em className="nav-badge">2</em></button>
                <button type="button" className="tab active"><Icon name="agents" size={18} /><span className="tab-label">Agents</span></button>
              </div>
            </Spec>
            <Spec name="Mission chip" note="tone says whether to look">
              <div className="gal-row">
                {(["ok", "warn", "bad", "neutral"] as const).map((t, i) => <span key={t} className={`mission-chip ${t}`}><i className={`dot${i === 0 ? " pulse" : ""}`} />{["Running", "Needs you", "Failed", "Parked"][i]}</span>)}
              </div>
            </Spec>
            <Spec name="Readouts" note="a well: read, do not press">
              <div className="bar-strip">
                <div className="bar-strip-stat"><span className="k">Working</span><b>3</b></div>
                <div className="bar-strip-stat"><span className="k">Tokens</span><b>1.4M<span className="of"> / 2.0M</span></b><span className="meter warn" style={{ "--p": 0.7 } as React.CSSProperties} /></div>
              </div>
            </Spec>
            <Spec name="Project tabs" note="the project in front is raised; shape, then word" wide>
              <div className="gal-strip">
                <ul className="ptabs" role="list">
                  {([["ok", "dot", "Payments", "running · 142 MB", true], ["warn", "pause", "Billing", "parked", false], ["bad", "alert", "Search index", "crashed", false], ["neutral", "ring", "Archive", "closed", false]] as const).map(([tone, icon, name, meta, on]) => (
                    <li key={name} className={`ptab${on ? " on" : ""}`} data-tone={tone}>
                      <button type="button" className="ptab-main"><span className="ptab-ico"><Icon name={icon} size={14} /></span><span className="ptab-text"><span className="ptab-name">{name}</span><span className="ptab-meta"><span className="ptab-state">{meta}</span></span></span></button>
                      <button type="button" className="ptab-x" aria-label={`Close ${name}`}><Icon name="x" size={14} /></button>
                    </li>
                  ))}
                </ul>
              </div>
            </Spec>
          </div>
        </Section>

        {/* -------------------------------------------------------------------------------- icons */}
        <Section id="icons" title="Icons" lede="One 20-unit grid, one 1.5px line at every size, the colour of the text they sit in. The set is the size of the interface.">
          <ul className="gal-icons">{ICON_NAMES.map((n) => <li key={n}><Icon name={n} size={20} /><span>{n}</span></li>)}</ul>
        </Section>
      </main>

      {open === "plain" ? <ConfirmDialog req={CONFIRM_PLAIN} onResolve={() => setOpen(null)} /> : null}
      {open === "danger" ? <ConfirmDialog req={CONFIRM_DANGER} onResolve={() => setOpen(null)} /> : null}
      {open === "dialog" ? (
        <Dialog title="A dialog" onClose={() => setOpen(null)} actions={<><Button variant="soft" onClick={() => setOpen(null)}>Close</Button></>}>
          <p style={{ margin: 0, color: "var(--text-dim)" }}>The generic one: a title, a body, and the actions at the end.</p>
        </Dialog>
      ) : null}
    </>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <React.StrictMode>
    <Gallery />
  </React.StrictMode>,
);
