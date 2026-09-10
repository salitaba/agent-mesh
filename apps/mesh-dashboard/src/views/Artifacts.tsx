import { useEffect, useMemo, useState } from "react";
import { ago, plainArtifact, artifactCls } from "../format";
import { useMesh } from "../store";
import { Button, Card, Chip, ErrorState, Input, rowKey } from "../components";
import { ArtifactDrawer } from "../drawers";

/* Files an agent produced. The table used to be an unfiltered dump: on a real
 * mesh it grows past a screen within minutes and there was no way to answer
 * "which docs exist" or "what is waiting on me". Search + facets fix that,
 * and grouping by name collapses the version chain into one row so v1..v9 of
 * the same file stop drowning out everything else. */

interface Art {
  id: string;
  name: string;
  type: string;
  status: string;
  owner: string;
  version: number;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

const REVIEW_STATES = ["READY_FOR_REVIEW", "UNDER_REVIEW"];

export default function Artifacts(): React.JSX.Element {
  const { openDrawer, client } = useMesh();
  const [arts, setArts] = useState<Art[]>([]);
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const [group, setGroup] = useState(true);
  const [onlyReview, setOnlyReview] = useState(false);
  // "No files yet." was printed before the fetch landed and again when it
  // failed, so a dead server and an empty mesh looked identical.
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let dead = false;
    setErr(null);
    client.api("GET", "/artifacts").then(({ json, timeout }) => {
      if (dead) return;
      if (timeout) {
        setErr("the request timed out — the server may be busy.");
        return;
      }
      if (json && json.error) {
        setErr(String(json.error));
        return;
      }
      if (Array.isArray(json)) {
        setArts(json.slice().reverse() as Art[]);
        setLoaded(true);
      } else {
        setErr("the server sent something this view could not read.");
      }
    }).catch((e: unknown) => {
      if (!dead) setErr(e instanceof Error ? e.message : String(e));
    });
    return () => {
      dead = true;
    };
  }, [attempt, client]);

  const types = useMemo(() => [...new Set(arts.map((a) => a.type))].sort(), [arts]);
  const needsReview = arts.filter((a) => REVIEW_STATES.includes(a.status));

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let list = arts.filter((a) => {
      if (type && a.type !== type) return false;
      if (onlyReview && !REVIEW_STATES.includes(a.status)) return false;
      if (!needle) return true;
      return [a.name, a.type, a.owner, a.status, String(a.metadata?.path ?? "")]
        .some((f) => String(f).toLowerCase().includes(needle));
    });
    if (group) {
      // Keep only the newest record per logical file; the drawer still shows
      // the full version chain, so nothing is hidden — just not repeated.
      const best = new Map<string, Art>();
      for (const a of list) {
        const key = `${a.type}/${a.name}`;
        const prev = best.get(key);
        if (!prev || a.version > prev.version) best.set(key, a);
      }
      list = [...best.values()].sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)));
    }
    return list;
  }, [arts, q, type, group, onlyReview]);

  const open = (id: string): void => openDrawer(<ArtifactDrawer id={id} />);

  return (
    <>
      <div className="view-title"><h2>Files</h2><span className="muted" style={{ fontSize: 12 }}>{rows.length} of {arts.length}</span></div>
      <div className="view-sub">What agents produced. Click one to read it, compare versions, or download it. Versions are never overwritten.</div>
      {needsReview.length ? <div className="status-strip warn" style={{ marginBottom: 12 }}><div><b>{needsReview.length} waiting for review.</b> <span className="muted">Someone asked for feedback and is blocked until it lands.</span> <Button variant="banner-act" onClick={() => needsReview[0] && open(needsReview[0].id)}>Review now</Button></div></div> : null}
      <Card style={{ marginBottom: 10 }}>
        <div className="fv-filters">
          <Input search mono placeholder="search name, owner, type, path…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="chips">
            <Chip hot={!type} onClick={() => setType("")}>all types</Chip>
            {types.map((t) => <Chip key={t} hot={type === t} onClick={() => setType(type === t ? "" : t)}>{t}</Chip>)}
          </div>
          <div className="chips">
            <Chip hot={onlyReview} onClick={() => setOnlyReview(!onlyReview)}>needs review</Chip>
            <Chip hot={group} onClick={() => setGroup(!group)}>latest only</Chip>
          </div>
        </div>
      </Card>
      <Card style={{ padding: "6px 0" }}><table className="tbl"><thead><tr><th>file</th><th>what&apos;s next</th><th>by</th><th>when</th></tr></thead><tbody>
        {rows.length ? rows.map((a) => (
          <tr key={a.id} className="clickable" data-art={a.id} tabIndex={0} onClick={() => open(a.id)} onKeyDown={rowKey(() => open(a.id))}>
            <td>
              <b>{a.name}</b>
              <div className="muted" style={{ fontSize: 11 }}>
                v{a.version} · {a.type}
                {a.metadata?.path ? <> · <span className="mono">{String(a.metadata.path)}</span></> : null}
              </div>
            </td>
            <td><span className={`pill ${artifactCls(a.status)}`}>{plainArtifact(a.status)}</span></td>
            <td className="mono">{a.owner}</td><td className="muted">{ago(a.createdAt)}</td>
          </tr>
        )) : (
          <tr><td colSpan={4}>
            {err && !loaded ? <ErrorState what="the file list" detail={err} onRetry={() => setAttempt((n) => n + 1)} />
            : !loaded ? <div className="empty"><div className="big">…</div><div>loading files</div></div>
            : <div className="empty"><div className="big">▤</div><div>{arts.length ? "Nothing matches that filter." : "No files yet."}</div><div className="muted">{arts.length ? "Clear the search to see everything." : "They appear here when an agent publishes something."}</div></div>}
          </td></tr>
        )}
      </tbody></table></Card>
    </>
  );
}
