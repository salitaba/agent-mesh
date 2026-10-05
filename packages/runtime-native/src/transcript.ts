import * as fs from "fs";
import * as path from "path";
import type { ChatMessage } from "../../llm/src/index";

/**
 * A seat's conversation, on disk, so a restarted mesh resumes it instead of starting the seat cold.
 *
 * One append-only JSON-lines file per transcript: a header, then one line per message as it joins the conversation, then a
 * line of bookkeeping at the end of each turn. Appending costs what was added, however long the conversation has grown, and a
 * file that was cut mid-write loses only its last line. A transcript is written at the end of every round of a turn, not
 * at the end of the turn, so a mesh killed in the middle of a long turn resumes with what that turn had already done.
 *
 * Loading repairs what a kill can leave behind: a torn last line is dropped, and an assistant message that asked for tools
 * whose results never arrived is answered with an error result for each, because no provider accepts a conversation in
 * which a call has no answer.
 */

export interface TranscriptHeader {
  v: 1;
  agentId: string;
  transcriptId: string;
  /** The model the transcript was started on, for the operator reading it. */
  model: string;
  createdAt: string;
}

export interface TranscriptMeta {
  /** The prompt size of the last model call: what the conversation weighs. */
  contextTokens: number;
  turns: number;
  rotations: number;
  /** When the last turn ended, as epoch ms. */
  lastTurnEndedAt?: number;
}

export interface LoadedTranscript {
  header: TranscriptHeader;
  messages: ChatMessage[];
  meta: TranscriptMeta | undefined;
  /** Results added to answer calls a kill left open. */
  repaired: number;
}

/** How many transcripts a seat keeps once it has rotated: the live one and the one before it. */
const KEEP_TRANSCRIPTS = 2;

const safe = (id: string): string => id.replace(/[^A-Za-z0-9._-]/g, "_");

export const INTERRUPTED_RESULT = "This call did not run: the session was interrupted before it could, and has been resumed.";

export class TranscriptStore {
  constructor(private readonly root: string | undefined) {}

  get persistent(): boolean {
    return this.root !== undefined;
  }

  private file(agentId: string, transcriptId: string): string | undefined {
    return this.root === undefined ? undefined : path.join(this.root, "native", safe(agentId), `${safe(transcriptId)}.jsonl`);
  }

  create(header: TranscriptHeader): void {
    const file = this.file(header.agentId, header.transcriptId);
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ type: "header", ...header })}\n`, "utf8");
  }

  append(agentId: string, transcriptId: string, messages: ChatMessage[]): void {
    const file = this.file(agentId, transcriptId);
    if (!file || messages.length === 0) return;
    fs.appendFileSync(file, messages.map((m) => `${JSON.stringify({ type: "message", ...m })}\n`).join(""), "utf8");
  }

  meta(agentId: string, transcriptId: string, meta: TranscriptMeta): void {
    const file = this.file(agentId, transcriptId);
    if (!file) return;
    fs.appendFileSync(file, `${JSON.stringify({ type: "meta", ...meta })}\n`, "utf8");
  }

  load(agentId: string, transcriptId: string): LoadedTranscript | undefined {
    const file = this.file(agentId, transcriptId);
    if (!file) return undefined;
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
    let header: TranscriptHeader | undefined;
    let meta: TranscriptMeta | undefined;
    const messages: ChatMessage[] = [];
    const good: string[] = [];
    let damaged = !text.endsWith("\n");
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // The torn last line of a write that was cut short, or damage in the middle. Nothing after it can be trusted: a line
        // that depends on one that is gone is worse than a conversation that is shorter.
        damaged = true;
        break;
      }
      good.push(line);
      const { type, ...rest } = row;
      if (type === "header") header = rest as unknown as TranscriptHeader;
      else if (type === "meta") meta = rest as unknown as TranscriptMeta;
      else if (type === "message") messages.push(rest as unknown as ChatMessage);
    }
    if (!header) return undefined;
    // Cut the damage off the file itself, so the next append starts on a line of its own instead of joining the fragment.
    if (damaged) {
      try {
        fs.writeFileSync(file, `${good.join("\n")}\n`, "utf8");
      } catch {
        // Read-only state: the conversation is still usable in memory.
      }
    }
    return { header, messages, meta, repaired: repair(messages) };
  }

  /** Delete the seat's transcripts older than the two most recent. */
  prune(agentId: string): void {
    if (this.root === undefined) return;
    const dir = path.join(this.root, "native", safe(agentId));
    let entries: Array<{ file: string; mtime: number }>;
    try {
      entries = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => ({ file: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }));
    } catch {
      return;
    }
    entries.sort((a, b) => b.mtime - a.mtime);
    for (const old of entries.slice(KEEP_TRANSCRIPTS)) fs.rmSync(old.file, { force: true });
  }
}

/** Answer every call that has no result, in place. Returns how many it added. */
export function repair(messages: ChatMessage[]): number {
  let added = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== "assistant" || !m.toolCalls || m.toolCalls.length === 0) continue;
    const answered = new Set<string>();
    let j = i + 1;
    while (j < messages.length && messages[j]!.role === "tool") {
      answered.add((messages[j] as { toolCallId: string }).toolCallId);
      j++;
    }
    const missing = m.toolCalls.filter((c) => !answered.has(c.id));
    if (missing.length === 0) continue;
    messages.splice(
      j,
      0,
      ...missing.map((c): ChatMessage => ({ role: "tool", toolCallId: c.id, name: c.name, content: INTERRUPTED_RESULT, isError: true })),
    );
    added += missing.length;
    i = j + missing.length - 1;
  }
  return added;
}
