import { useEffect, useState } from "react";
import { api } from "../api";
import { ago, plainArtifact, artifactCls } from "../format";
import { useMesh } from "../store";
import { Button, Card, rowKey } from "../components";
import { ArtifactDrawer } from "../drawers";

export default function Artifacts(): React.JSX.Element {
  const { openDrawer } = useMesh();
  const [arts, setArts] = useState<any[]>([]);
  useEffect(() => {
    let dead = false;
    api("GET", "/artifacts").then(({ json }) => {
      if (!dead && Array.isArray(json)) setArts(json.slice().reverse());
    }).catch(() => undefined);
    return () => {
      dead = true;
    };
  }, []);

  const needsReview = arts.filter((a) => ["READY_FOR_REVIEW", "UNDER_REVIEW"].includes(a.status));
  return (
    <>
      <div className="view-title"><h2>Files</h2></div>
      <div className="view-sub">What agents produced. Click one to read it. Versions are never overwritten.</div>
      {needsReview.length ? <div className="status-strip warn" style={{ marginBottom: 12 }}><div><b>{needsReview.length} waiting for review.</b> <span className="muted">Someone asked for feedback and is blocked until it lands.</span> <Button variant="banner-act" onClick={() => needsReview[0] && openDrawer(<ArtifactDrawer id={needsReview[0].id} />)}>Review now</Button></div></div> : null}
      <Card style={{ padding: "6px 0" }}><table className="tbl"><thead><tr><th>file</th><th>what's next</th><th>by</th><th>when</th></tr></thead><tbody>
        {arts.map((a) => (
          <tr key={a.id} className="clickable" data-art={a.id} tabIndex={0} onClick={() => openDrawer(<ArtifactDrawer id={a.id} />)} onKeyDown={rowKey(() => openDrawer(<ArtifactDrawer id={a.id} />))}>
            <td><b>{(a.name)}</b><div className="muted" style={{ fontSize: 11 }}>v{a.version} · {(a.type)}</div></td>
            <td><span className={`pill ${artifactCls(a.status)}`}>{(plainArtifact(a.status))}</span></td>
            <td className="mono">{(a.owner)}</td><td className="muted">{(ago(a.createdAt))}</td>
          </tr>
        )) || <tr><td colSpan={4}><div className="empty"><div className="big">▤</div><div>No files yet.</div><div className="muted">They appear here when an agent publishes something.</div></div></td></tr>}
      </tbody></table></Card>
    </>
  );
}
