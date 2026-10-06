import { useEffect, useMemo, useRef } from "react";
import { useMesh } from "./store";
import { useMission } from "./useMission";
import { orderDecisions } from "./inbox-model";
import { bySeq } from "./overview-model";
import { decisionTitles, stoppedBecause } from "./toasttext";
import { attentionOf, faviconFor, type Attention } from "./attention";
import { faviconHref, type FaviconKind } from "./favicon";

/**
 * The part of telling a person about their mission that touches the page. It reads the mission the way the rest of the console
 * does (useMission), asks attention.ts which moment it is, and puts the answer on the tab. The decisions are attention.ts's and
 * favicon.ts's, which node:test covers; this only wires them to `document`. It draws nothing.
 */

/** Puts the icon on the page. The link is replaced and not edited: Safari does not redraw a tab icon whose href was changed. */
function applyFavicon(kind: FaviconKind): void {
  const href = faviconHref(kind);
  const current = document.head.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]');
  if (current.length === 1 && current[0]!.getAttribute("href") === href) return;
  current.forEach((l) => l.remove());
  const link = document.createElement("link");
  link.rel = "icon";
  link.type = "image/svg+xml";
  link.href = href;
  document.head.appendChild(link);
}

/** The mission as attention.ts reads it, from what the console already holds. */
function useAttention(projectId: string | null, projectName: string | null): Attention | null {
  const { status, events } = useMesh();
  const { facts, state } = useMission();
  return useMemo(() => {
    // The cards that hold the mission or a seat, in the order the Needs you page lists them.
    const holding = orderDecisions<any>(status?.openEscalations ?? []).blocking;
    return attentionOf({
      phase: state.phase,
      tone: state.tone,
      label: state.label,
      headline: state.headline,
      decisionIds: holding.map((e) => String(e.id)),
      decisionTitles: decisionTitles(holding, { status, parked: facts.parked }),
      reason: state.phase === "failed" ? stoppedBecause(bySeq(events), String(status?.goal?.status ?? "")) : null,
      goalId: status?.goal?.id ?? null,
      deliveredAt: status?.goal?.completedAt ?? null,
      projectId,
      projectName,
    });
  }, [status, events, state, facts.parked, projectId, projectName]);
}

export function AttentionEffects({ projectId, projectName }: { projectId: string | null; projectName: string | null }): null {
  const attention = useAttention(projectId, projectName);
  // A mission that cannot be read for a moment (the server did not answer) keeps the icon it had: a badge that blinked off and on
  // with every dropped poll would say less than one that stayed, and "last known" is what the page itself says in that state.
  const icon = attention ? faviconFor(attention) : null;
  const shown = useRef<FaviconKind>("plain");
  useEffect(() => {
    if (icon !== null) shown.current = icon;
    applyFavicon(shown.current);
  }, [icon]);
  // Leaving the project (its Shell unmounts) leaves the plain icon for whatever opens next.
  useEffect(() => () => applyFavicon("plain"), []);
  return null;
}
