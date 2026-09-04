import * as readline from "readline";

export async function runTui(busUrl: string, quit: () => Promise<void>): Promise<void> {
  const out = process.stdout;
  let stopped = false;
  let lastStatus: any = null;
  let lastEvents: any[] = [];
  let error: string | null = null;

  if (out.isTTY) {
    readline.emitKeypressEvents?.(process.stdin);
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on("keypress", (_s: string, key: { name?: string; ctrl?: boolean }) => {
      if (!key) return;
      if (key.name === "q" || (key.ctrl === true && key.name === "c")) {
        stopped = true;
      }
      if (key.name === "p") {
        const gid = lastStatus?.goal?.id;
        if (gid) void fetch(`${busUrl}/goals/${encodeURIComponent(gid)}/pause`, { method: "POST" }).catch(() => undefined);
      }
      if (key.name === "r") {
        const gid = lastStatus?.goal?.id;
        if (gid) void fetch(`${busUrl}/goals/${encodeURIComponent(gid)}/resume`, { method: "POST" }).catch(() => undefined);
      }
    });
  }

  const fetchJson = async (url: string): Promise<any> => {
    const res = await fetch(url);
    return res.json();
  };

  const render = (): void => {
    const lines: string[] = [];
    const goal = lastStatus?.goal;
    lines.push(`\x1b[1m Agent Mesh — ${goal?.id ?? "(connecting)"} \x1b[0m`);
    lines.push("─".repeat(60));
    if (lastStatus) {
      const ratio = lastStatus.progress?.ratio ?? 0;
      const bar = "█".repeat(Math.round(ratio * 30)).padEnd(30, "░");
      const mission = (lastStatus.budgets ?? []).find((b: any) => b.key.startsWith("mission:"));
      const active = (lastStatus.agents ?? []).filter((a: any) =>
        ["THINKING", "WORKING", "REQUESTING", "AWAKENED", "OBSERVING", "REVIEWING", "WAITING", "BLOCKED"].includes(a.lifecycle),
      ).length;
      lines.push(` Goal      ${bar} ${Math.round(ratio * 100)}%  [${goal?.status ?? "-"}]`);
      lines.push(` Active    ${active} / ${(lastStatus.agents ?? []).length}      Tokens    ${mission?.consumed ?? 0} / ${mission?.limit ?? "?"}      Events ${lastStatus.eventCount}`);
    }
    lines.push("─".repeat(60));
    lines.push("\x1b[1m AGENTS\x1b[0m");
    for (const a of lastStatus?.agents ?? []) {
      if (a.id === "human") continue;
      const dot = ["THINKING", "WORKING", "REQUESTING", "AWAKENED", "OBSERVING", "REVIEWING"].includes(a.lifecycle) ? "\x1b[32m●\x1b[0m" : a.lifecycle === "WAITING" || a.lifecycle === "BLOCKED" ? "\x1b[33m○\x1b[0m" : "\x1b[90m○\x1b[0m";
      lines.push(`  ${dot} ${String(a.id).padEnd(14)} ${String(a.lifecycle).padEnd(11)} mail ${String(a.mailbox).padStart(2)}   tokens ${a.tokens}`);
    }
    const escalations = lastStatus?.openEscalations ?? [];
    if (escalations.length) {
      lines.push("─".repeat(60));
      lines.push("\x1b[31m ESCALATIONS (mesh respond <id> <text>)\x1b[0m");
      for (const e of escalations) lines.push(`  ! ${e.id}  ${e.reason} (by ${e.raisedBy})`);
    }
    lines.push("─".repeat(60));
    lines.push("\x1b[1m EVENTS\x1b[0m");
    for (const e of lastEvents.slice(-12)) {
      lines.push(`  ${String(e.at).replace("T", " ").slice(5, 19)} ${String(e.type).padEnd(24)} ${e.actor ?? ""} ${String(e.summary ?? "").slice(0, 60)}`);
    }
    if (error) lines.push(`\x1b[31m ${error}\x1b[0m`);
    lines.push("─".repeat(60));
    lines.push(" [q] quit   [p] pause");

    const height = (out.rows ?? 40) - 1;
    const body = lines.slice(0, Math.max(1, height)).join("\n");
    out.write("\x1b[2J\x1b[H" + body + "\n");
  };

  while (!stopped) {
    try {
      lastStatus = await fetchJson(`${busUrl}/status`);
      lastEvents = await fetchJson(`${busUrl}/events?limit=60`);
      error = null;
    } catch (err) {
      error = (err as Error).message;
    }
    render();
    const status = lastStatus?.goal?.status;
    if (status === "COMPLETED" || status === "FAILED") {
      out.write(`\n mission ${status.toLowerCase()}\n`);
      stopped = true;
    }
    if (!stopped) await new Promise((r) => setTimeout(r, 1500));
  }

  if (out.isTTY) {
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
  }
  await quit();
}
