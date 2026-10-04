import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import "./cost.css";
import { api } from "../api";
import { fmt, localTime } from "../format";
import { useMesh } from "../store";
import { useMission } from "../useMission";
import { useMissionActions } from "../useMissionActions";
import { useProjectsOptional } from "../projects";
import { Banner, Button, EmptyState, ErrorState, PageHeader, useNow } from "../components";
import { Icon } from "../icons";
import {
  GROUP_LABEL,
  LIST_PRICES_AS_OF,
  agentList,
  budgetRules,
  budgetTone,
  defaultPriceNote,
  fmtUsd,
  idleCopy,
  longDate,
  overSentence,
  pctLabel,
  readingAge,
  summarizeCost,
  type BudgetTone,
  type BudgetsPayload,
  type DetailRow,
  type ModelRow,
} from "../cost";

/* What this mission has spent against what it may spend. Total against budget first, then who spent it and on which model,
 * with the unit said once (tokens) and a dollar figure only where the host has one, labelled as the estimate it is.
 *
 * It reads again every few seconds while the page is open (it used to read once and freeze while a mission ran), and says so:
 * "Updated 3s ago", and, when a read fails after a good one, that it is showing the last numbers it had and when. */

const bar = (v: number): CSSProperties => ({ "--w": Math.min(1, Math.max(0, v)) } as CSSProperties);

const FLAG: Record<BudgetTone, string> = { ok: "", warn: "Running low", bad: "Almost gone" };

/** Which price the host's estimate uses for a model, said under its row. Nothing is said when the host's settings could not be read. */
const BASIS: Record<ModelRow["basis"], string> = { yours: "your price", list: "list price", default: "default rate", unknown: "" };

function Updated({ at }: { at: number }): React.JSX.Element {
  // Not a live region: it changes every second, and a screen reader should not read the clock out.
  const now = useNow(1000);
  return <span className="count-note">Updated {readingAge(now - at)}</span>;
}

function Meter({ ratio, tone, label }: { ratio: number | null; tone: BudgetTone; label: string }): React.JSX.Element {
  return (
    <div className={`cost-meter ${tone}`} role="img" aria-label={label}>
      <i style={bar(ratio ?? 0)} />
    </div>
  );
}

function OwnBudget({ own }: { own: NonNullable<ReturnType<typeof summarizeCost>["agents"][number]["own"]> }): React.JSX.Element {
  return (
    <span className={`cost-own-b ${own.tone}`}>
      <span className="cost-mini" aria-hidden="true"><i style={bar(own.ratio)} /></span>
      <span>{fmt(own.used)} of {fmt(own.limit)}{own.exceeded ? " (over)" : own.tone === "warn" || own.tone === "bad" ? " (nearly used)" : ""}</span>
    </span>
  );
}

function DetailTable({ rows }: { rows: DetailRow[] }): React.JSX.Element {
  const groups = rows.reduce<Array<{ g: DetailRow["group"]; items: DetailRow[] }>>((acc, r) => {
    const last = acc[acc.length - 1];
    if (last && last.g === r.group) last.items.push(r);
    else acc.push({ g: r.group, items: [r] });
    return acc;
  }, []);
  return (
    <div className="cost-table-wrap">
      <table className="cost-table">
        <thead><tr><th scope="col">Budget</th><th scope="col" className="r">Used</th><th scope="col" className="r">Limit</th><th scope="col">State</th></tr></thead>
        {groups.map(({ g, items }) => (
          <tbody key={g}>
            <tr><th scope="rowgroup" colSpan={4} className="cost-grp">{GROUP_LABEL[g]}</th></tr>
            {items.map((r) => (
              <tr key={r.key}>
                <th scope="row" className="mono" title={r.label}><span className="cost-trunc">{r.label}</span></th>
                <td className="r mono">{r.used}</td>
                <td className="r mono">{r.limit}</td>
                <td>{r.state === "over" ? <span className="cost-state bad"><Icon name="alert" size={12} />over</span> : r.state === "near" ? <span className="cost-state warn"><Icon name="alert" size={12} />nearly used</span> : <span className="muted">ok</span>}</td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}

/** The host's price settings, as far as this page needs them: the default rate, and which models the operator priced. */
interface PriceSettings { rate: number | null; yours: string[] }

export default function Cost(): React.JSX.Element {
  const { refreshStatus, setView, client, projectId } = useMesh();
  const { facts, state } = useMission();
  const actions = useMissionActions();
  const projects = useProjectsOptional();
  const [payload, setPayload] = useState<BudgetsPayload | null>(null);
  const [readAt, setReadAt] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // A read that failed after a good one: the figures stay, and the page says they are the last it had.
  const [stale, setStale] = useState<{ at: number; why: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [prices, setPrices] = useState<PriceSettings | null>(null);
  const loaded = useRef(false);

  // Faster while agents are working, slower when nothing moves; not at all while the tab is hidden.
  const live = ["running", "quiet", "stalled", "needs-you"].includes(state.phase);
  const every = live ? 4000 : 15000;
  useEffect(() => {
    let dead = false;
    const fail = (why: string): void => {
      if (loaded.current) setStale({ at: Date.now(), why });
      else setErr(why);
    };
    const read = async (): Promise<void> => {
      if (loaded.current && document.visibilityState === "hidden") return;
      try {
        const { json, timeout } = await client.api("GET", "/budgets");
        if (dead) return;
        if (timeout || !json || json.error) {
          fail(timeout ? "The request timed out. The server may be busy." : String(json?.error ?? "The mesh server did not answer."));
          return;
        }
        const first = !loaded.current;
        loaded.current = true;
        setPayload(json as BudgetsPayload);
        setReadAt(Date.now());
        setErr(null);
        setStale(null);
        // The top bar reads /status, not /budgets: keep the two in step the first time, so neither is the older number.
        if (first) void refreshStatus();
      } catch (e: unknown) {
        if (!dead) fail(e instanceof Error ? e.message : String(e));
      }
    };
    void read();
    const iv = setInterval(() => void read(), every);
    return () => {
      dead = true;
      clearInterval(iv);
    };
  }, [client, attempt, every, refreshStatus]);

  // The host's price settings say which price each model is billed at in the estimate. They are only context, so a failure is silent
  // and the page then claims nothing about prices.
  useEffect(() => {
    let dead = false;
    api("GET", "/api/host/config").then((res) => {
      const c = res.json?.config;
      if (dead || res.status !== 200 || !c) return;
      setPrices({
        rate: typeof c.defaultUsdPerMtok === "number" ? c.defaultUsdPerMtok : null,
        yours: c.modelPrices && typeof c.modelPrices === "object" ? Object.keys(c.modelPrices) : [],
      });
    }).catch(() => undefined);
    return () => { dead = true; };
  }, []);

  const s = useMemo(() => summarizeCost(payload, prices ? prices.yours : null), [payload, prices]);
  const hostSpend = projects?.hostSpend ?? null;
  const mine = projects?.projects.find((p) => p.id === projectId)?.spend;
  const spentNothing = s.spent === 0 && s.mission.used === 0;
  const idle = idleCopy(state.phase, facts.hasHistory);
  const startable = idle.start && state.primary && (state.primary.action === "start" || state.primary.action === "resume");
  const m = s.mission;
  const ceilingRatio = hostSpend && hostSpend.ceilingUsd ? hostSpend.usd / hostSpend.ceilingUsd : null;
  const ceilingTone = hostSpend ? budgetTone(ceilingRatio, hostSpend.ceilingTripped) : "ok";
  const priceNote = defaultPriceNote(s.defaulted, prices ? prices.rate : null);

  return (
    <>
      <PageHeader
        title="Cost"
        status={readAt ? <Updated at={readAt} /> : null}
        lede="What this mission has spent against what it may spend. Figures are tokens (fresh input plus output) unless marked with a dollar sign."
      />

      {err && !payload ? (
        <ErrorState what="spend and budgets" detail={err} onRetry={() => { setErr(null); setAttempt((n) => n + 1); }} />
      ) : !payload ? (
        <div className="cost-skel" role="status"><span className="sr-only">Loading spend</span><i /><i /><i /></div>
      ) : (
        <div className="cost-stack">
          {stale ? (
            <Banner tone="warn" title="These figures may be out of date." actions={<Button variant="banner-act" icon="refresh" onClick={() => setAttempt((n) => n + 1)}>Read again</Button>}>
              Reading them again failed at {localTime(new Date(stale.at).toISOString())}. {stale.why.endsWith(".") ? stale.why : `${stale.why}.`} These figures are from {readAt ? localTime(new Date(readAt).toISOString()) : "the first read"}.
            </Banner>
          ) : null}

          {s.over.length ? (
            <Banner
              tone="bad"
              title="Over budget."
              actions={<Button variant="banner-act" onClick={() => setView("escalations")}>Open Needs you</Button>}
            >
              {overSentence(s.over)} Nothing more runs on a spent budget until you raise it, and Needs you has that decision.
            </Banner>
          ) : m.tone !== "ok" ? (
            <Banner tone="warn" title={m.tone === "bad" ? "The mission budget is almost gone." : "The mission budget is running low."}>
              {fmt(m.used)} of {fmt(m.limit)} tokens ({pctLabel(m.ratio)}). The mission stops when more is spent than this, and Needs you then asks whether to raise it.
            </Banner>
          ) : null}

          <div className={`cost-top${hostSpend ? " two" : ""}`}>
            <section className="card cost-card" aria-labelledby="cm-h">
              <h3 id="cm-h" className="cost-h">Mission budget</h3>
              <div className="cost-big">
                <b>{fmt(m.used)}</b>
                <span>of {m.limit > 0 ? fmt(m.limit) : "no limit"} tokens</span>
                {m.ratio !== null ? <em className={m.tone}>{pctLabel(m.ratio)}</em> : null}
              </div>
              <Meter ratio={m.ratio} tone={m.tone} label={m.ratio === null ? "The mission has no token limit" : `${fmt(m.used)} of ${fmt(m.limit)} tokens used, ${pctLabel(m.ratio)}`} />
              <p className="cost-sub">
                {m.remaining !== null ? `${fmt(m.remaining)} left` : "No token limit"}
                {s.turns ? ` · ${s.turns} ${s.turns === 1 ? "turn" : "turns"}` : ""}
                {s.agents.length ? ` · ${s.agents.length} ${s.agents.length === 1 ? "agent" : "agents"}` : ""}
                {m.tone !== "ok" ? <span className={`cost-flag ${m.tone}`}><Icon name="alert" size={14} />{m.used >= m.limit ? "Spent" : FLAG[m.tone]}</span> : null}
              </p>
              {m.limit > 0 ? (
                <p className="cost-fine">The mission budget is never raised on its own. When more is spent than it allows, the mission stops and Needs you asks whether to raise it.</p>
              ) : null}
            </section>

            {hostSpend ? (
              <section className="card cost-card" aria-labelledby="ch-h">
                <h3 id="ch-h" className="cost-h">Host spend, estimated</h3>
                <div className="cost-big">
                  <b>{fmtUsd(hostSpend.usd)}</b>
                  <span>{hostSpend.ceilingUsd ? `of the $${hostSpend.ceilingUsd.toLocaleString("en-GB")} ceiling` : "and no ceiling is set"}</span>
                </div>
                {hostSpend.ceilingUsd ? <Meter ratio={ceilingRatio} tone={ceilingTone} label={`${fmtUsd(hostSpend.usd)} of the ${fmtUsd(hostSpend.ceilingUsd)} ceiling`} /> : null}
                <p className="cost-sub">
                  {mine && hostSpend.usd !== mine.usd ? `This project ${fmtUsd(mine.usd)} · ` : ""}Counts every open project on this host.
                  {hostSpend.ceilingTripped ? <span className="cost-flag bad"><Icon name="alert" size={14} />Ceiling reached</span> : null}
                </p>
                <p className="cost-fine">
                  An estimate, not an invoice: your provider&apos;s invoice is the bill.{" "}
                  <button type="button" className="reader-link" onClick={() => setView("hostsettings")}>Change the ceiling in Host settings</button>
                </p>
                {priceNote ? <p className="cost-fine cost-default"><Icon name="info" size={14} />{priceNote}</p> : null}
                <details className="cost-how">
                  <summary>How it is priced</summary>
                  <p>
                    Every kind of token (fresh input, output, cache writes and cache reads) is priced per model: at the price you set for it in model_prices, or else at Anthropic&apos;s list price
                    (as of {longDate(LIST_PRICES_AS_OF)}), or else at the default rate{prices && prices.rate !== null ? ` of $${prices.rate} per million tokens` : ""}. Discounts and batch rates are not modelled.
                  </p>
                </details>
              </section>
            ) : null}
          </div>

          {spentNothing ? (
            <EmptyState icon="cost" title="Nothing spent yet" action={startable && state.primary ? <Button variant="primary" onClick={() => actions.run(state.primary!.action)}>{state.primary.label}</Button> : null}>
              {idle.body}
            </EmptyState>
          ) : (
            <>
              <section className="card" aria-labelledby="ca-h">
                <div className="cost-sec-h">
                  <h3 id="ca-h" className="cost-h">By agent <span className="cost-n">{s.agents.length}</span></h3>
                  <span className="cost-cap">Bars are scaled to the biggest spender. Percentages are shares of everything spent.</span>
                </div>
                <div className="cost-cols" aria-hidden="true"><span>Agent</span><span /><span className="r">Tokens</span><span className="r">Share</span><span>Its own budget</span></div>
                <ul className="cost-rows">
                  {s.agents.map((a) => (
                    <li className="cost-row" key={a.agentId}>
                      <span className="cost-name" title={a.agentId}>
                        <span className="cost-trunc">{a.agentId}</span>
                        <span className="cost-meta">{a.activations === 0 ? "has not taken a turn" : `ran ${a.activations} ${a.activations === 1 ? "time" : "times"} · ${fmt(a.perTurn)} per turn`}</span>
                      </span>
                      <span className={`cost-bar${a.tokens > 0 ? "" : " zero"}`} aria-hidden="true"><i style={bar(a.bar)} /></span>
                      <span className="cost-num">{fmt(a.tokens)}<span className="sr-only"> tokens</span></span>
                      <span className="cost-share">{pctLabel(a.share)}<span className="sr-only"> of everything spent</span></span>
                      <span className="cost-own">{a.own ? <OwnBudget own={a.own} /> : <span className="muted">no budget of its own</span>}</span>
                    </li>
                  ))}
                </ul>
              </section>

              <section className="card" aria-labelledby="cmo-h">
                <div className="cost-sec-h">
                  <h3 id="cmo-h" className="cost-h">By model <span className="cost-n">{s.models.length}</span></h3>
                  <span className="cost-cap">Tokens billed as fresh input plus output.</span>
                </div>
                {s.models.length ? (
                  <>
                    <div className="cost-cols" aria-hidden="true"><span>Model</span><span /><span className="r">Tokens</span><span className="r">Share</span><span>In and out</span></div>
                    <ul className="cost-rows">
                      {s.models.map((mo) => (
                        <li className="cost-row" key={mo.model}>
                          <span className="cost-name" title={mo.model}>
                            <span className="cost-trunc mono">{mo.model}</span>
                            <span className="cost-meta">{mo.turns} {mo.turns === 1 ? "turn" : "turns"} · {fmt(mo.avgPerTurn)} per turn{mo.agents.length ? ` · ${agentList(mo.agents)}` : ""}</span>
                          </span>
                          <span className={`cost-bar${mo.tokens > 0 ? "" : " zero"}`} aria-hidden="true"><i style={bar(mo.bar)} /></span>
                          <span className="cost-num">{fmt(mo.tokens)}<span className="sr-only"> tokens</span></span>
                          <span className="cost-share">{pctLabel(mo.share)}<span className="sr-only"> of everything spent</span></span>
                          <span className="cost-own">
                            <span className="muted">{fmt(mo.input)} in, {fmt(mo.output)} out</span>
                            {BASIS[mo.basis] ? <span className={`cost-basis ${mo.basis}`}>{mo.basis === "default" ? <Icon name="info" size={12} /> : null}{BASIS[mo.basis]}</span> : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                    {s.cacheTotal ? (
                      <p className="cost-fine">
                        {fmt(s.cacheTotal)} cached transcript tokens were replayed on top of these. They are outside the token budget, and the provider still bills them, at a reduced rate.
                      </p>
                    ) : null}
                  </>
                ) : (
                  <p className="cost-fine">No model spend is recorded yet. This fills in as agents take turns.</p>
                )}
              </section>
            </>
          )}

          <details className="card cost-details">
            <summary>All budgets ({s.details.length})</summary>
            <dl className="cost-rules">
              {budgetRules().map((r) => (
                <div key={r.what}><dt>{r.what}</dt><dd>{r.rule}</dd></div>
              ))}
            </dl>
            {s.details.length ? <DetailTable rows={s.details} /> : <p className="cost-fine">This mesh keeps no budgets.</p>}
          </details>
        </div>
      )}
    </>
  );
}
