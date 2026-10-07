import test from "node:test";
import assert from "node:assert/strict";

import { renderMarkdown } from "../../apps/mesh-dashboard/src/markdown";

/**
 * The renderer the step view's narration and the file view share. The bug it
 * fixed: a turn's narration was set as plain text, so a model's `**bold**`
 * and its tables arrived as asterisks and raw pipes. The property that must
 * never regress is the one that makes rendering model text safe at all —
 * everything is escaped before anything is marked up.
 */

test("source text never becomes markup: tags, attributes and entities are escaped", () => {
  const html = renderMarkdown('<script>alert(1)</script> <img src=x onerror="alert(1)"> & \'q\'');
  assert.doesNotMatch(html, /<script|<img/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /onerror=&quot;alert\(1\)&quot;/);
  assert.match(html, /&amp; &#39;q&#39;/);
  // Inside every construct, not just paragraphs.
  for (const src of ["# <b>h</b>", "- <b>li</b>", "1. <b>li</b>", "> <b>q</b>", "| <b>a</b> |\n|---|\n| <i>b</i> |", "```\n<b>code</b>\n```", "`<b>`"]) {
    assert.doesNotMatch(renderMarkdown(src), /<b>|<i>/, src);
  }
  // A fence's info string lands in an attribute.
  assert.doesNotMatch(renderMarkdown('```"onmouseover=alert(1)\nx\n```'), /data-lang="[^"]*"[^>]*onmouseover/);
});

test("the placeholder characters cannot be forged from the source", () => {
  // The renderer parks code spans behind \u0001…\u0001 while the other
  // inline rules run; a source carrying one must not splice markup in.
  const html = renderMarkdown("before \u00010\u0001 after `code`");
  assert.equal(html, "<p>before 0 after <code>code</code></p>");
});

test("links keep only safe targets", () => {
  const href = (src: string): string | undefined => /href="([^"]*)"/.exec(renderMarkdown(src))?.[1];
  assert.equal(href("[a](https://example.com/x?y=1&z=2)"), "https://example.com/x?y=1&amp;z=2");
  assert.equal(href("[a](mailto:ops@example.com)"), "mailto:ops@example.com");
  assert.equal(href("[a](#sec)"), "#sec");
  assert.equal(href("[a](/p/x)"), "/p/x");
  assert.equal(href("[a](javascript:alert(1))"), "#");
  assert.equal(href("[a](JavaScript:alert)"), "#");
  assert.equal(href("[a](data:text/html,x)"), "#");
  assert.equal(href("[a](vbscript:x)"), "#");
  assert.match(renderMarkdown("[a](https://x.io)"), /target="_blank" rel="noreferrer noopener"/);
});

test("inline marks: bold, italic, strike and code, with code left literal", () => {
  assert.equal(renderMarkdown("**Orientation.** it is *2 of 21* ~~gone~~"), "<p><strong>Orientation.</strong> it is <em>2 of 21</em> <del>gone</del></p>");
  assert.equal(renderMarkdown("`**not bold**`"), "<p><code>**not bold**</code></p>");
  assert.equal(renderMarkdown("2 * 3 * 4"), "<p>2 * 3 * 4</p>", "arithmetic is not emphasis");
  assert.equal(renderMarkdown("snake_case_name"), "<p>snake_case_name</p>");
});

test("consecutive text lines are one paragraph; a blank line or a hard break separates", () => {
  assert.equal(renderMarkdown("one\ntwo\n\nthree"), "<p>one two</p>\n<p>three</p>");
  assert.equal(renderMarkdown("one  \ntwo"), "<p>one<br />two</p>");
  assert.equal(renderMarkdown("one\\\ntwo"), "<p>one<br />two</p>");
  assert.equal(renderMarkdown("line\r\nnext"), "<p>line next</p>");
});

test("GFM tables: header, body, alignment, escaped pipes and ragged rows", () => {
  const html = renderMarkdown([
    "**Published four artifacts**:",
    "",
    "| Artifact | Size | Note |",
    "|:---|---:|:-:|",
    "| `ArchitectureDocument` | 12 | a \\| b |",
    "| ADR | 3 |",
    "| x | 1 | 2 | extra |",
    "",
    "after",
  ].join("\n"));
  assert.match(html, /<div class="md-table" tabindex="0" role="region" aria-label="Table"><table><thead><tr><th>Artifact<\/th><th class="al-r">Size<\/th><th class="al-c">Note<\/th><\/tr><\/thead>/);
  assert.match(html, /<td><code>ArchitectureDocument<\/code><\/td><td class="al-r">12<\/td><td class="al-c">a \| b<\/td>/);
  assert.match(html, /<tr><td>ADR<\/td><td class="al-r">3<\/td><td class="al-c"><\/td><\/tr>/, "a short row is padded");
  assert.doesNotMatch(html, /extra/, "cells past the header are dropped, as GFM does");
  assert.match(html, /<\/table><\/div>\n<p>after<\/p>$/);
  // A pipe in prose is not a table without the delimiter row under it.
  assert.equal(renderMarkdown("a | b\nc | d"), "<p>a | b c | d</p>");
  // A header whose width disagrees with the delimiter row is not a table.
  assert.doesNotMatch(renderMarkdown("| a | b |\n|---|\n| 1 | 2 |"), /<table/);
});

test("ordered and nested lists", () => {
  assert.equal(
    renderMarkdown("1. **first** point\n   continued\n2. second\n   - nested\n   - nested two\n3. third"),
    "<ol><li>\n<strong>first</strong> point continued\n</li><li>\nsecond\n<ul><li>\nnested\n</li><li>\nnested two\n</li></ul>\n</li><li>\nthird\n</li></ol>",
  );
  assert.match(renderMarkdown("3. three\n4. four"), /^<ol start="3"><li>/);
  assert.equal(renderMarkdown("- a\n- b"), "<ul><li>\na\n</li><li>\nb\n</li></ul>");
  // A list ends at a blank line followed by prose.
  assert.equal(renderMarkdown("- a\n\nafter"), "<ul><li>\na\n</li></ul>\n<p>after</p>");
  // Only a list starting at 1 may interrupt a paragraph.
  assert.equal(renderMarkdown("It shipped in\n2026. The year after"), "<p>It shipped in 2026. The year after</p>");
  assert.match(renderMarkdown("- [ ] todo\n- [x] done"), /☐ todo[\s\S]*☑ done/);
});

test("fences, headings, quotes and rules", () => {
  assert.equal(renderMarkdown("```ts\nconst a = 1 < 2;\n```"), '<pre class="md-code" data-lang="ts">const a = 1 &lt; 2;</pre>');
  // An unclosed fence runs to the end — what a narration clipped inside one needs.
  assert.equal(renderMarkdown("text\n```\nopen **x**"), '<p>text</p>\n<pre class="md-code" data-lang="">open **x**</pre>');
  assert.equal(renderMarkdown("## Title ##"), "<h2>Title</h2>");
  assert.equal(renderMarkdown("> one\n> **two**"), "<blockquote><p>one <strong>two</strong></p></blockquote>");
  assert.equal(renderMarkdown("---"), "<hr />");
  assert.equal(renderMarkdown("* * *"), "<hr />");
});
