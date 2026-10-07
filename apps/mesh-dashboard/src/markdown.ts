/* Minimal markdown to an HTML string, for the text agents write: artifacts in
   the file view, and a turn's narration in the step view.

   Not a full parser on purpose — agent-written text is plain, and pulling a
   markdown dependency into the console for this is not worth the bytes. It
   covers what that text actually uses: headings, paragraphs, bold / italic /
   strike / code, links, bullet and numbered lists (nested by indent), quotes,
   rules, fenced code and GFM tables.

   Escape-first, which is the one property that matters here: every run of
   source text is HTML-escaped before any markup is put around it, and the only
   markup is fixed tags written in this file, so nothing a model wrote can
   become an element or an attribute. A link's href is the one place source
   text lands inside an attribute; it is escaped like everything else and
   limited to http(s), mailto, in-page and site-relative targets.

   DOM-free and JSX-free, like ledger.ts, so the escaping can be pinned with
   node:test. */

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Link targets let through; anything else (javascript:, data:, …) becomes "#". */
const SAFE_HREF = /^(https?:|mailto:|#|\/)/i;

/** Placeholder delimiter for code spans while the other inline rules run.
 *  Stripped from the source first, so the source cannot forge one. */
const PH = "\u0001";
/** A blank line inside a list item, in the item's buffered lines. Stripped
 *  from the source too, for the same reason. */
const ITEM_BREAK = "\u0000";

/** One run of text: escaped, then marked up. Code spans are set aside first
 *  so `**` inside backticks stays literal. */
function inline(src: string): string {
  const codes: string[] = [];
  const s = esc(src)
    .replace(/`([^`]+)`/g, (_m, c: string) => {
      codes.push(`<code>${c}</code>`);
      return `${PH}${codes.length - 1}${PH}`;
    })
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    // Flanking, as in CommonMark: `a * b * c` is arithmetic, not emphasis.
    .replace(/(^|[^*\w])\*(\S(?:[^*]*\S)?)\*(?![*\w])/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, href: string) =>
      `<a href="${SAFE_HREF.test(href) ? href : "#"}" target="_blank" rel="noreferrer noopener">${label}</a>`);
  return s.replace(new RegExp(`${PH}(\\d+)${PH}`, "g"), (_m, i: string) => codes[Number(i)] ?? "");
}

/** Leading whitespace as columns, a tab counting four. */
const indentOf = (line: string): number => {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n++;
    else if (ch === "\t") n += 4;
    else break;
  }
  return n;
};

const FENCE = /^\s*(`{3,}|~{3,})\s*([^\s`]*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NUMBERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;

/** A table row's cells: outer pipes dropped, `\|` kept as a literal pipe. */
function cells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") { cur += "|"; i++; continue; }
    if (s[i] === "|") { out.push(cur.trim()); cur = ""; continue; }
    cur += s[i];
  }
  out.push(cur.trim());
  return out;
}

/** The alignment row under a table's header, or null when `line` is not one. */
function delimiterRow(line: string | undefined): ("l" | "c" | "r" | "")[] | null {
  if (!line || !line.includes("-") || !/^[\s|:-]+$/.test(line)) return null;
  const cs = cells(line);
  if (!cs.every((c) => /^:?-+:?$/.test(c))) return null;
  return cs.map((c) => (c.startsWith(":") && c.endsWith(":") ? "c" : c.endsWith(":") ? "r" : c.startsWith(":") ? "l" : ""));
}

export function renderMarkdown(src: string): string {
  const lines = src.replace(/[\u0000\u0001]/g, "").replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];

  // A paragraph is every consecutive plain line, joined: a model wraps its
  // prose at whatever width it likes, and one <p> per source line set each
  // wrap as a paragraph break.
  let para: string[] = [];
  const flushPara = (): void => {
    if (!para.length) return;
    // Two trailing spaces or a trailing backslash is a hard break.
    const html = para
      .map((l, i) => {
        const hard = i < para.length - 1 && /( {2,}|\\)$/.test(l);
        return inline(l.replace(/( {2,}|\\)$/, "").trim()) + (hard ? "<br />" : "");
      })
      .join(" ")
      .replace(/<br \/> /g, "<br />");
    out.push(`<p>${html}</p>`);
    para = [];
  };

  // Open lists, innermost last. Each open list has an open <li> whose text is
  // buffered in `item` until the item ends or a nested list starts under it.
  const lists: { tag: "ul" | "ol"; indent: number }[] = [];
  let item: string[] = [];
  let gap = false;
  const flushItem = (): void => {
    if (!item.length) return;
    // A blank line inside an item keeps its paragraphs apart.
    const parts: string[][] = [[]];
    for (const l of item) {
      if (l === ITEM_BREAK) parts.push([]);
      else parts[parts.length - 1]!.push(l);
    }
    out.push(parts.filter((p) => p.length).map((p) => inline(p.join(" "))).join("<br />"));
    item = [];
  };
  const closeList = (): void => {
    flushItem();
    const l = lists.pop();
    if (l) out.push(`</li></${l.tag}>`);
  };
  const closeLists = (): void => {
    while (lists.length) closeList();
    gap = false;
  };
  const listItem = (indent: number, tag: "ul" | "ol", start: string, text: string): void => {
    flushPara();
    while (lists.length && lists[lists.length - 1]!.indent > indent + 1) closeList();
    const top = lists[lists.length - 1];
    if (top && indent < top.indent + 2 && top.tag !== tag) closeList();
    const cur = lists[lists.length - 1];
    if (cur && indent < cur.indent + 2) {
      flushItem();
      out.push("</li><li>");
    } else {
      // A new list, nested inside the open item when there is one.
      flushItem();
      lists.push({ tag, indent });
      out.push(tag === "ol" && start !== "1" ? `<ol start="${Number(start)}"><li>` : `<${tag}><li>`);
    }
    // Task-list boxes, as glyphs rather than inputs nobody can tick.
    item = [text.replace(/^\[ \]\s+/, "☐ ").replace(/^\[[xX]\]\s+/, "☑ ")];
    gap = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const fence = FENCE.exec(line);
    if (fence) {
      flushPara();
      closeLists();
      const mark = fence[1]!;
      const body: string[] = [];
      // An unclosed fence runs to the end, as in CommonMark — which is also
      // what a clipped narration cut inside one needs.
      for (i++; i < lines.length; i++) {
        const t = lines[i]!.trim();
        if (t.length >= mark.length && t === mark[0]!.repeat(t.length)) break;
        body.push(lines[i]!);
      }
      out.push(`<pre class="md-code" data-lang="${esc(fence[2] ?? "")}">${esc(body.join("\n"))}</pre>`);
      continue;
    }

    if (line.trim() === "") {
      flushPara();
      if (lists.length) gap = true;
      continue;
    }

    const bullet = RULE.test(line) ? null : BULLET.exec(line);
    // Only a list starting at 1 may interrupt a paragraph, as in CommonMark:
    // "2026. The year the…" wrapped onto a new line is still prose.
    const numbered = NUMBERED.exec(line);
    if (bullet) { listItem(indentOf(bullet[1]!), "ul", "1", bullet[2]!); continue; }
    if (numbered && (!para.length || lists.length || Number(numbered[2]) === 1)) {
      listItem(indentOf(numbered[1]!), "ol", numbered[2]!, numbered[3]!);
      continue;
    }

    const align = line.includes("|") ? delimiterRow(lines[i + 1]) : null;
    const head = align ? cells(line) : null;
    const table = Boolean(align && head && head.length === align.length);

    // Inside a list, a plain line continues the open item: indented, or
    // directly under it (CommonMark's lazy continuation). After a blank line
    // only an indented one does; anything else ends the list.
    if (lists.length) {
      const top = lists[lists.length - 1]!;
      const indented = indentOf(line) >= top.indent + 2;
      if (indented || (!gap && !table && !HEADING.test(line) && !QUOTE.test(line) && !RULE.test(line))) {
        if (gap && item.length) item.push(ITEM_BREAK);
        item.push(line.trim());
        gap = false;
        continue;
      }
      closeLists();
    }

    if (align && head && table) {
      flushPara();
      const cls = (k: number): string => (align[k] === "c" ? ' class="al-c"' : align[k] === "r" ? ' class="al-r"' : "");
      const row = (cs: string[], tag: "th" | "td"): string =>
        `<tr>${head.map((_h, k) => `<${tag}${cls(k)}>${inline(cs[k] ?? "")}</${tag}>`).join("")}</tr>`;
      const body: string[] = [];
      for (i += 2; i < lines.length && lines[i]!.trim() !== "" && lines[i]!.includes("|"); i++) body.push(row(cells(lines[i]!), "td"));
      i--;
      // The wrapper scrolls when a table is wider than its column, so the keyboard has to be able to reach it: a tab stop that is named.
      out.push(`<div class="md-table" tabindex="0" role="region" aria-label="Table"><table><thead>${row(head, "th")}</thead>${body.length ? `<tbody>${body.join("")}</tbody>` : ""}</table></div>`);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushPara();
      const level = heading[1]!.length;
      out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
      continue;
    }
    if (RULE.test(line)) {
      flushPara();
      out.push("<hr />");
      continue;
    }
    if (QUOTE.test(line)) {
      flushPara();
      const inner: string[] = [];
      for (; i < lines.length && QUOTE.test(lines[i]!); i++) inner.push(QUOTE.exec(lines[i]!)![1]!);
      i--;
      out.push(`<blockquote>${renderMarkdown(inner.join("\n"))}</blockquote>`);
      continue;
    }
    para.push(line);
  }
  flushPara();
  closeLists();
  return out.join("\n");
}
