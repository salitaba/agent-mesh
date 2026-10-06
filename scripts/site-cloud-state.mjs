/**
 * Which half of the site's pages a visitor is shown, written into the markup.
 *
 * A page carries both halves of every sentence that depends on whether Curule Cloud is open: `data-selfhost-only` is what is
 * true while it is not (Curule is software you run), `data-cloud-only` what is true once it is, and `data-cloud="login|signup|
 * home|terms|privacy"` is a link into the account pages. The state is one setting, CLOUD_URL at the top of assets/site.js.
 *
 * It used to be applied only in the browser, after the first paint: the page loaded in one state and moved into the other,
 * which made the plans on the pricing page jump (a layout shift of 0.34 on a phone), and a visitor with no script, a search
 * engine and a link preview read the half that says Curule is not hosted while the service was open. So the state is written into
 * the pages instead: scripts/set-domain.mjs does it to every page when the address is set, and scripts/site-chrome.mjs writes the
 * shared header in the same state. assets/site.js applies the same rule when it runs, and for a page that is already right it
 * changes nothing.
 *
 * The rule, for an open service: a `data-cloud-only` element is shown, a `data-selfhost-only` one is hidden, and a `data-cloud`
 * link is shown with its address (the service's address and the path of its kind). For a closed one it is the reverse, and a
 * link is hidden with `#` for its address. `hidden` is always the last attribute, where the pages write it. A link of a kind that
 * assets/site.js does not know is left as it is, as the script leaves it. Everything else in the page is left as it is.
 */

/**
 * What a page is read as: a comment, a script or a style (their text is not markup, and is left alone), or a start tag with its
 * name and the text of its attributes, where a quoted value may hold a ">".
 */
const MARKUP = /<!--[\s\S]*?-->|<(script|style)\b[\s\S]*?<\/\1>|<([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
/** One attribute of a start tag: its name and, when it has one, its value as written. */
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;
const SWITCHED = /\sdata-(?:cloud-only|selfhost-only|cloud)\b/;

/**
 * The settings of a copy of assets/site.js: `url` is CLOUD_URL ("" while Curule Cloud is not open) and `paths` is CLOUD_PATH, the
 * page of the account pages each kind of link goes to. Throws when the service is open and the script has no paths to give it.
 */
export function cloudConfigOf(script) {
  const url = /^var CLOUD_URL = "([^"]*)";/m.exec(script)?.[1] ?? "";
  const body = /var CLOUD_PATH = \{([^}]*)\}/.exec(script)?.[1] ?? "";
  const paths = Object.fromEntries([...body.matchAll(/(\w+):\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]));
  if (url !== "" && Object.keys(paths).length === 0) throw new Error("assets/site.js has a CLOUD_URL and no CLOUD_PATH, so the links into Curule Cloud have no page to go to");
  return { url, paths };
}

/** The attributes of a start tag's text, each with where it sits in it (the whitespace before it is part of it). */
function attributesOf(text) {
  const out = [];
  for (const m of text.matchAll(ATTRIBUTE)) {
    const quoted = m[2] === undefined ? undefined : m[2].replace(/^["']|["']$/g, "");
    let from = m.index;
    while (from > 0 && /\s/.test(text[from - 1])) from--;
    out.push({ name: m[1].toLowerCase(), value: quoted, from, to: m.index + m[0].length });
  }
  return out;
}

/** `text` (the attributes of one tag) with `hidden` as the last attribute, or without it. */
function withHidden(text, hidden) {
  const found = attributesOf(text).find((a) => a.name === "hidden");
  if (hidden) return found ? text : `${text.trimEnd()} hidden`;
  return found ? text.slice(0, found.from) + text.slice(found.to) : text;
}

/** `text` with the `href` it has set to `address`, or one added. */
function withHref(text, address) {
  const found = attributesOf(text).find((a) => a.name === "href");
  if (!found) return `${text.trimEnd()} href="${address}"`;
  return `${text.slice(0, found.from)} href="${address}"${text.slice(found.to)}`;
}

/** The start tag as it is when Curule Cloud is in the state `config` says, or the same tag when the state is not its business. */
function switched(tag, name, text, config) {
  const attrs = attributesOf(text);
  const has = (n) => attrs.some((a) => a.name === n);
  const open = config.url !== "";
  let out = text;
  if (has("data-cloud")) {
    const path = config.paths[attrs.find((a) => a.name === "data-cloud").value];
    if (path === undefined) return tag;
    out = withHref(out, open ? `${config.url.replace(/\/+$/, "")}${path}` : "#");
    out = withHidden(out, !open);
  } else if (has("data-cloud-only")) out = withHidden(out, !open);
  else if (has("data-selfhost-only")) out = withHidden(out, open);
  else return tag; // the words were in an attribute's value, not its name
  return `<${name}${out}>`;
}

/** `html` with every element that depends on whether Curule Cloud is open in the state `config` (from `cloudConfigOf`) says. */
export function cloudState(html, config) {
  return html.replace(MARKUP, (found, _block, name, text) => (name !== undefined && SWITCHED.test(text) ? switched(found, name, text, config) : found));
}
