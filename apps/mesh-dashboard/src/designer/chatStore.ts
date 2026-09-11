/* Global designer-assistant transcript: module singleton + localStorage mirror,
 * so the conversation survives view switches and a page refresh. The server is
 * stateless and gets the transcript resent each turn. Turns stream: `thinking`
 * and `text` deltas accumulate into `live` while the model runs, and the final
 * frame becomes the persisted assistant entry. */

import { useSyncExternalStore } from "react";
import type { ProjectClient } from "../api";

export interface ChatEntry {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  proposed?: any;
  problems?: string[];
}

export interface ChatState {
  entries: ChatEntry[];
  busy: boolean;
  failed: string | null;
  review: number | null;
  applied: number | null;
  /** In-flight model output: reasoning and answer text as they stream. */
  live: { thinking: string; text: string } | null;
  /** Operator preference: render reasoning blocks. Persisted separately. */
  showThinking: boolean;
  /** Entries the open panel has shown; anything newer is "unread" on the FAB. */
  seen: number;
}

const CHAT_KEY = "mesh-designer-chat-v1";
const THINKING_KEY = "mesh-designer-chat-thinking";
const MAX_ENTRIES = 60;
/** Reasoning can be long; keep the persisted transcript out of localStorage bloat. */
const MAX_THINKING = 20000;

let idSeq = 0;
function nextId(): string {
  idSeq++;
  return `${Date.now().toString(36)}-${idSeq.toString(36)}`;
}

function load(): ChatEntry[] {
  try {
    const raw = JSON.parse(String(localStorage.getItem(CHAT_KEY) || "null"));
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((e: any) => e && (e.role === "user" || e.role === "assistant") && typeof e.content === "string")
      .slice(-MAX_ENTRIES)
      .map((e: any) => ({ ...e, id: typeof e.id === "string" ? e.id : nextId() }));
  } catch {
    return [];
  }
}

function loadThinking(): boolean {
  try {
    return localStorage.getItem(THINKING_KEY) === "1";
  } catch {
    return false;
  }
}

const loaded = load();
let state: ChatState = {
  entries: loaded, busy: false, failed: null, review: null, applied: null,
  live: null, showThinking: loadThinking(), seen: loaded.length,
};
const listeners = new Set<() => void>();

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function getSnapshot(): ChatState {
  return state;
}

/** Subscribe to one field. The unselected snapshot re-renders on every
 *  streamed token; selectors keep the closed FAB and other bystanders still. */
export function useChatSelector<T>(select: (s: ChatState) => T): T {
  return useSyncExternalStore(subscribe, () => select(state));
}

function set(patch: Partial<ChatState>): void {
  let next: ChatState = { ...state, ...patch };
  // Trim in memory on append, not only on persist; shift the index-based
  // review/applied/seen bookkeeping so it keeps pointing at the same entries.
  if (patch.entries && next.entries.length > MAX_ENTRIES) {
    const drop = next.entries.length - MAX_ENTRIES;
    next = {
      ...next,
      entries: next.entries.slice(drop),
      seen: Math.max(0, next.seen - drop),
      review: next.review == null ? null : next.review >= drop ? next.review - drop : null,
      applied: next.applied == null ? null : next.applied >= drop ? next.applied - drop : null,
    };
  }
  state = next;
  if (patch.entries) {
    try {
      const trimmed = state.entries.map((e) =>
        e.thinking && e.thinking.length > MAX_THINKING ? { ...e, thinking: e.thinking.slice(-MAX_THINKING) } : e,
      );
      localStorage.setItem(CHAT_KEY, JSON.stringify(trimmed));
    } catch {
      /* storage may be unavailable */
    }
  }
  for (const l of listeners) l();
}

export function markSeen(): void {
  if (state.seen !== state.entries.length) set({ seen: state.entries.length });
}

export function setShowThinking(on: boolean): void {
  try {
    localStorage.setItem(THINKING_KEY, on ? "1" : "0");
  } catch {
    /* noop */
  }
  set({ showThinking: on });
}

export function setReview(i: number | null): void {
  set({ review: i });
}

export function markApplied(i: number): void {
  set({ applied: i, review: null });
}

export function clearChat(): void {
  state = { entries: [], busy: false, failed: null, review: null, applied: null, live: null, showThinking: state.showThinking, seen: 0 };
  try {
    localStorage.removeItem(CHAT_KEY);
  } catch {
    /* noop */
  }
  for (const l of listeners) l();
}

export async function sendMessage(client: ProjectClient, text: string, currentConfig: any): Promise<void> {
  const body = text.trim();
  if (!body || state.busy) return;
  const next: ChatEntry[] = [...state.entries, { id: nextId(), role: "user", content: body }];
  set({ entries: next, busy: true, failed: null, review: null, live: { thinking: "", text: "" } });

  const finish = (patch: Partial<ChatState>): void => set({ busy: false, live: null, ...patch });

  // Echo the latest proposal's validation problems so the next turn can fix
  // them; older ones are dropped once a newer proposal supersedes them.
  const lastAssistant = next.reduce((acc, e, i) => (e.role === "assistant" ? i : acc), -1);
  const wireMessages = next.map((e, i) => {
    const problems = i === lastAssistant && Array.isArray(e.problems) ? e.problems : [];
    return problems.length > 0 ? { role: e.role, content: e.content, problems } : { role: e.role, content: e.content };
  });
  const result = await client.postStream(
    "/designer/chat/stream",
    { messages: wireMessages, currentConfig },
    (evt) => {
      if (!evt || typeof evt !== "object") return;
      if (evt.type === "thinking" && typeof evt.delta === "string") {
        const live = state.live ?? { thinking: "", text: "" };
        set({ live: { ...live, thinking: live.thinking + evt.delta } });
      } else if (evt.type === "text" && typeof evt.delta === "string") {
        const live = state.live ?? { thinking: "", text: "" };
        set({ live: { ...live, text: live.text + evt.delta } });
      } else if (evt.type === "final") {
        if (!state.busy) return;
        const live = state.live ?? { thinking: "", text: "" };
        finish({
          entries: [...next, {
            id: nextId(),
            role: "assistant",
            content: typeof evt.reply === "string" ? evt.reply : live.text,
            // The tap can miss reasoning when the backend has no /event; the
            // final message's reasoning parts are the authoritative fallback.
            thinking: typeof evt.thinking === "string" && evt.thinking ? evt.thinking : (live.thinking || undefined),
            proposed: evt.proposedConfig,
            problems: Array.isArray(evt.problems) ? evt.problems : [],
          }],
        });
      } else if (evt.type === "error") {
        finish({ failed: String(evt.error ?? "designer chat failed") });
      }
    },
  );

  // The stream ended without a final frame (server died or transport dropped).
  if (state.busy) finish({ failed: result.error || `designer chat failed (${result.status})` });
}
