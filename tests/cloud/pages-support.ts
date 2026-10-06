/**
 * What it takes to run the account pages' script without a browser: the real page files parsed into a small DOM that has only
 * what the script uses, the script itself run unchanged in a sandbox, and a `fetch` that answers as the test says.
 *
 * The DOM is deliberately thin. It is not a browser, and what the script does in a real one (layout, focus rings, the address
 * bar) is looked at with one (`npm run qa:cloud`). What it can show is the part that is the script's own: which calls it makes
 * with what, what it writes into the page for each answer, and where it sends the person.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";

export const ROOT = path.resolve(__dirname, "..", "..", "..");
export const PAGES_DIR = path.join(ROOT, "apps", "cloud-server", "pages");
export const SCRIPT = path.join(PAGES_DIR, "assets", "app.js");

// ---- a small DOM ----

export interface FakeEvent {
  type: string;
  target: FakeNode | FakeDocument;
  currentTarget: FakeNode | FakeDocument;
  defaultPrevented: boolean;
  preventDefault(): void;
  [key: string]: unknown;
}
type Listener = (event: FakeEvent) => unknown;

const VOID = new Set(["meta", "link", "input", "br", "img", "hr"]);
const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };
const decode = (text: string): string => text.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (e) => ENTITIES[e] ?? e);
const camel = (name: string): string => name.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());

export class FakeNode {
  parent: FakeNode | null = null;
  children: FakeNode[] = [];
  readonly attrs = new Map<string, string>();
  readonly listeners = new Map<string, Listener[]>();
  checked = false;
  private text = "";
  private current: string | undefined;

  constructor(
    readonly tag: string,
    readonly doc: FakeDocument,
    text?: string,
  ) {
    if (text !== undefined) this.text = text;
    // A node knows its document and its place in it, and an assertion that fails on two nodes prints everything either one can reach, with
    // no regard for the nesting (node's own message is built with depth 1000 and custom inspection off). Two pages' worth of nodes once
    // took a test process past 6 GB to say that two forms were not the same form. The links are there to be followed, not to be shown.
    for (const link of ["parent", "children", "doc"] as const) Object.defineProperty(this, link, { enumerable: false });
  }

  get isText(): boolean {
    return this.tag === "#text";
  }
  get tagName(): string {
    return this.tag.toUpperCase();
  }
  get id(): string {
    return this.attrs.get("id") ?? "";
  }
  set id(v: string) {
    this.attrs.set("id", v);
  }
  get className(): string {
    return this.attrs.get("class") ?? "";
  }
  set className(v: string) {
    this.attrs.set("class", v);
  }
  get hidden(): boolean {
    return this.attrs.has("hidden");
  }
  set hidden(v: boolean) {
    if (v) {
      this.attrs.set("hidden", "");
      this.loseCursor(this);
    } else this.attrs.delete("hidden");
  }
  get disabled(): boolean {
    return this.attrs.has("disabled");
  }
  /** Held while a request is out: the page says so and ignores a press, and keeps the cursor on the control. */
  get held(): boolean {
    return this.attrs.get("aria-disabled") === "true";
  }
  set disabled(v: boolean) {
    if (v) {
      this.attrs.set("disabled", "");
      if (this.doc.activeElement === this) this.doc.activeElement = null;
    } else this.attrs.delete("disabled");
  }
  get href(): string {
    return this.attrs.get("href") ?? "";
  }
  set href(v: string) {
    this.attrs.set("href", v);
  }
  get value(): string {
    return this.current ?? this.attrs.get("value") ?? "";
  }
  set value(v: string) {
    this.current = v;
  }
  get dataset(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of this.attrs) if (k.startsWith("data-")) out[camel(k.slice(5))] = v;
    return out;
  }
  get textContent(): string {
    return this.isText ? this.text : this.children.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    for (const c of this.children) this.loseCursor(c);
    for (const c of this.children) c.parent = null;
    this.children = [];
    if (v !== "") this.append(v);
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, String(value));
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }

  /**
   * What a browser does with the cursor when the control that has it is taken out of the page, hidden or disabled: it is lost, and nothing
   * puts it back, so a page that draws a control again must say where the cursor goes.
   */
  private loseCursor(within: FakeNode): void {
    if (within.contains(this.doc.activeElement)) this.doc.activeElement = null;
  }

  append(...kids: Array<FakeNode | string>): void {
    for (const kid of kids) {
      const node = typeof kid === "string" ? new FakeNode("#text", this.doc, kid) : kid;
      if (node.parent) this.loseCursor(node);
      node.parent?.children.splice(node.parent.children.indexOf(node), 1);
      node.parent = this;
      this.children.push(node);
    }
  }
  replaceChildren(...kids: Array<FakeNode | string>): void {
    for (const c of this.children) this.loseCursor(c);
    for (const c of this.children) c.parent = null;
    this.children = [];
    this.append(...kids);
  }
  contains(node: FakeNode | null): boolean {
    for (let n = node; n; n = n.parent) if (n === this) return true;
    return false;
  }
  focus(): void {
    this.doc.activeElement = this;
  }

  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }

  /** Every element under this one, in document order. */
  descendants(): FakeNode[] {
    return this.children.flatMap((c) => (c.isText ? [] : [c, ...c.descendants()]));
  }
  querySelectorAll(selector: string): FakeNode[] {
    return this.descendants().filter((n) => matches(n, selector));
  }
  querySelector(selector: string): FakeNode | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

interface Step {
  tag?: string;
  classes: string[];
  attrs: Array<[string, string | undefined]>;
}

/** A selector as steps: tags, classes and attributes, with a space between a step and one inside it (`header nav`, `form.confirm`, `[data-action="signout"]`). */
function parseSelector(selector: string): Step[] {
  return selector
    .trim()
    .split(/\s+/)
    .map((part) => {
      const m = /^([a-zA-Z][\w-]*)?((?:\.[\w-]+|\[[\w-]+(?:="[^"]*")?\])*)$/.exec(part);
      if (!m) throw new Error(`the fake DOM does not understand the selector ${selector}`);
      const step: Step = { classes: [], attrs: [] };
      if (m[1]) step.tag = m[1].toLowerCase();
      for (const piece of (m[2] ?? "").matchAll(/\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g)) {
        if (piece[1] !== undefined) step.classes.push(piece[1]);
        else step.attrs.push([piece[2]!, piece[3]]);
      }
      return step;
    });
}

function stepMatches(node: FakeNode, step: Step): boolean {
  if (node.isText || node.tag === "#document") return false;
  if (step.tag && node.tag !== step.tag) return false;
  const classes = node.className.split(/\s+/);
  if (!step.classes.every((c) => classes.includes(c))) return false;
  return step.attrs.every(([name, value]) => node.attrs.has(name) && (value === undefined || node.attrs.get(name) === value));
}

function matches(node: FakeNode, selector: string): boolean {
  return selector.split(",").some((one) => matchesOne(node, one));
}

function matchesOne(node: FakeNode, selector: string): boolean {
  const steps = parseSelector(selector);
  if (!stepMatches(node, steps[steps.length - 1]!)) return false;
  let at = steps.length - 2;
  for (let up = node.parent; at >= 0 && up; up = up.parent) if (stepMatches(up, steps[at]!)) at--;
  return at < 0;
}

export class FakeDocument {
  readonly root: FakeNode;
  activeElement: FakeNode | null = null;
  /** The tab's title, which a page's script may set. */
  title = "";
  readyState = "complete";
  visibilityState = "visible";
  readonly listeners = new Map<string, Listener[]>();

  constructor() {
    this.root = new FakeNode("#document", this);
  }
  get body(): FakeNode {
    return this.root.descendants().find((n) => n.tag === "body")!;
  }
  createElement(tag: string): FakeNode {
    return new FakeNode(tag.toLowerCase(), this);
  }
  getElementById(id: string): FakeNode | null {
    return this.root.descendants().find((n) => n.id === id) ?? null;
  }
  querySelectorAll(selector: string): FakeNode[] {
    return this.root.querySelectorAll(selector);
  }
  querySelector(selector: string): FakeNode | null {
    return this.root.querySelector(selector);
  }
  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
}

/** Parse one of the page files. They are written by hand and well formed, so this reads them and not the web at large. */
export function parsePage(html: string): FakeDocument {
  const doc = new FakeDocument();
  const stack: FakeNode[] = [doc.root];
  const token = /<!--[\s\S]*?-->|<!doctype[^>]*>|<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/gi;
  for (const m of html.matchAll(token)) {
    const top = stack[stack.length - 1]!;
    if (m[5] !== undefined) {
      if (m[5].trim() !== "" && stack.length > 1) top.append(decode(m[5]));
      continue;
    }
    if (m[2] === undefined) continue;
    const tag = m[2].toLowerCase();
    if (m[1] === "/") {
      const at = stack.map((n) => n.tag).lastIndexOf(tag);
      if (at > 0) stack.length = at;
      continue;
    }
    const el = doc.createElement(tag);
    for (const a of (m[3] ?? "").matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) el.attrs.set(a[1]!.toLowerCase(), decode(a[2] ?? a[3] ?? a[4] ?? ""));
    top.append(el);
    // What a script-capable browser shows for <noscript> is nothing.
    if (!VOID.has(tag) && m[4] !== "/") stack.push(el);
  }
  for (const n of doc.root.descendants()) if (n.tag === "noscript") n.replaceChildren();
  return doc;
}

export function pageFile(name: string): string {
  return path.join(PAGES_DIR, name === "home" ? "index.html" : `${name}.html`);
}

// ---- a visit ----

export interface Call {
  method: string;
  path: string;
  body: unknown;
}
export interface Answer {
  status?: number;
  json?: unknown;
  /** A body that is not JSON. */
  raw?: string;
  /** The connection fails. */
  fail?: boolean;
}
export type Routes = (call: Call, seen: Call[]) => Answer | undefined;

export interface VisitOptions {
  /** What follows `?` in the address, with or without the question mark. */
  search?: string;
  routes?: Routes;
  /** What the tab's session storage held when the page opened. */
  storage?: Record<string, string>;
  /** Changes the script's source before it runs, to see what it does with a setting that is another value. */
  script?: (source: string) => string;
  /** What the person points with: a mouse (`fine`) or a finger (`coarse`). Left out, the browser has no `matchMedia` at all. */
  pointer?: "fine" | "coarse";
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export class Visit {
  readonly doc: FakeDocument;
  readonly calls: Call[] = [];
  /** Where the page sent the person, as `assign <address>`, `replace <address>` or `reload`. */
  readonly navigations: string[] = [];
  readonly consoleErrors: string[] = [];
  readonly storage = new Map<string, string>();
  readonly history: string[] = [];
  /** Calls the page should not make: to another address, without the session, or with a body it did not say is JSON. */
  readonly violations: string[] = [];
  readonly windowListeners = new Map<string, Listener[]>();
  private inflight = 0;
  location: { search: string; pathname: string; assign(url: string): void; replace(url: string): void; reload(): void };

  constructor(
    readonly page: string,
    private readonly options: VisitOptions = {},
  ) {
    this.doc = parsePage(fs.readFileSync(pageFile(page), "utf8"));
    this.doc.title = (/<title>([^<]*)<\/title>/.exec(fs.readFileSync(pageFile(page), "utf8")) ?? [])[1] ?? "";
    for (const [k, v] of Object.entries(options.storage ?? {})) this.storage.set(k, v);
    const search = options.search ? (options.search.startsWith("?") ? options.search : `?${options.search}`) : "";
    this.location = {
      search,
      pathname: page === "home" ? "/" : `/${page}`,
      assign: (url) => void this.navigations.push(`assign ${url}`),
      replace: (url) => void this.navigations.push(`replace ${url}`),
      reload: () => void this.navigations.push("reload"),
    };
  }

  /** Run the script on the page, as the browser does after the document is parsed. */
  async start(): Promise<this> {
    const self = this;
    const pointer = this.options.pointer;
    const win = {
      ...(pointer ? { matchMedia: (query: string) => ({ matches: pointer === "fine" && /hover: hover/.test(query) && /pointer: fine/.test(query) }) } : {}),
      sessionStorage: {
        getItem: (k: string) => self.storage.get(k) ?? null,
        setItem: (k: string, v: string) => void self.storage.set(k, String(v)),
        removeItem: (k: string) => void self.storage.delete(k),
      },
      addEventListener: (type: string, fn: Listener) => void self.windowListeners.set(type, [...(self.windowListeners.get(type) ?? []), fn]),
    };
    const sandbox = {
      document: this.doc,
      window: win,
      location: this.location,
      history: {
        replaceState: (_state: unknown, _title: string, url: string) => {
          self.history.push(url);
          const u = new URL(url, "http://localhost");
          self.location.pathname = u.pathname;
          self.location.search = u.search;
        },
      },
      fetch: (input: string, init: { method?: string; body?: string; credentials?: string; headers?: Record<string, string> } = {}) => this.fetch(input, init),
      console: { error: (...a: unknown[]) => void self.consoleErrors.push(a.map(String).join(" ")), log: () => undefined, warn: () => undefined },
      // The pages wait seconds between looks; a test waits for the same looks, a few milliseconds apart. A look that is still
      // pending when a test ends does not keep the process alive.
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms >= 1000 ? 8 : ms).unref(),
      clearTimeout,
      Intl,
      URL,
      URLSearchParams,
    };
    vm.runInNewContext(this.options.script?.(fs.readFileSync(SCRIPT, "utf8")) ?? fs.readFileSync(SCRIPT, "utf8"), sandbox, { filename: "app.js" });
    await this.idle();
    return this;
  }

  private async fetch(input: string, init: { method?: string; body?: string; credentials?: string; headers?: Record<string, string> }) {
    const method = init.method ?? "GET";
    if (!input.startsWith("/") || input.startsWith("//")) this.violations.push(`the page called ${input}, which is not an address of this service`);
    if (init.credentials !== "same-origin") this.violations.push(`a call to ${input} did not send credentials as same-origin`);
    if (init.body !== undefined && init.headers?.["content-type"] !== "application/json") this.violations.push(`a ${method} with a body to ${input} did not say it is JSON`);
    const call: Call = { method, path: input, body: init.body === undefined ? undefined : JSON.parse(init.body) };
    this.inflight++;
    try {
      await tick();
      this.calls.push(call);
      const answer = this.options.routes?.(call, this.calls) ?? { status: 404, json: { error: { code: "not_found", message: `There is nothing at ${input}.` } } };
      if (answer.fail) throw new TypeError("Failed to fetch");
      const status = answer.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => {
          if (answer.raw !== undefined) return JSON.parse(answer.raw);
          return JSON.parse(JSON.stringify(answer.json ?? {}));
        },
      };
    } finally {
      this.inflight--;
    }
  }

  /** Wait until nothing is on its way and what the page does between answers has been done. */
  async idle(): Promise<void> {
    for (let quiet = 0; quiet < 4; ) {
      await tick();
      quiet = this.inflight === 0 ? quiet + 1 : 0;
    }
    if (this.violations.length > 0) throw new Error(this.violations.join("; "));
  }

  /** Wait for something to become true: a page that polls gets there on its own. */
  async until(what: string, condition: () => boolean, ms = 2_000): Promise<void> {
    const end = Date.now() + ms;
    while (!condition()) {
      if (Date.now() > end) throw new Error(`still waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }

  // ---- looking ----

  $(id: string): FakeNode {
    const n = this.doc.getElementById(id);
    if (!n) throw new Error(`there is no #${id} on the ${this.page} page`);
    return n;
  }
  /** The text of an element, as a person would read it: each piece of text apart, whitespace squeezed, and nothing from what is hidden. */
  text(target: string | FakeNode): string {
    const node = typeof target === "string" ? this.$(target) : target;
    if (!this.shows(node)) return "";
    const pieces = (n: FakeNode): string[] => (n.isText ? [n.textContent] : n.hidden ? [] : n.children.flatMap(pieces));
    return pieces(node).join(" ").replace(/\s+/g, " ").replace(/ ([.,;:])/g, "$1").trim();
  }
  /** Whether the element, and every element around it, is shown. */
  shows(node: FakeNode): boolean {
    for (let n: FakeNode | null = node; n && n.tag !== "#document"; n = n.parent) if (n.hidden) return false;
    return true;
  }
  buttons(within: string | FakeNode): FakeNode[] {
    const node = typeof within === "string" ? this.$(within) : within;
    return node.querySelectorAll("button").filter((b) => this.shows(b));
  }
  button(within: string | FakeNode, label: string): FakeNode {
    const found = this.buttons(within).filter((b) => b.textContent.trim() === label);
    if (found.length !== 1) throw new Error(`expected one button "${label}", found ${found.length}; there are: ${this.buttons(within).map((b) => b.textContent.trim()).join(" | ")}`);
    return found[0]!;
  }
  labels(within: string | FakeNode): string[] {
    return this.buttons(within).map((b) => b.textContent.trim());
  }
  link(within: string | FakeNode, label: string): FakeNode {
    const node = typeof within === "string" ? this.$(within) : within;
    const found = node.querySelectorAll("a").filter((a) => this.shows(a) && a.textContent.trim() === label);
    if (found.length !== 1) throw new Error(`expected one link "${label}", found ${found.length}`);
    return found[0]!;
  }

  // ---- acting ----

  private fire(target: FakeNode, type: string, extra: Record<string, unknown> = {}): FakeEvent {
    const event: FakeEvent = { type, target, currentTarget: target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
    // The event goes to the element, then outward through what holds it, and last to the document, as a browser's does.
    const route: Array<FakeNode | FakeDocument> = [];
    for (let n: FakeNode | null = target; n && n.tag !== "#document"; n = n.parent) route.push(n);
    route.push(this.doc);
    for (const n of route) {
      event.currentTarget = n;
      for (const fn of (n.listeners.get(type) ?? []).slice()) fn(event);
    }
    return event;
  }
  /** A click. A button that is not a plain one then submits its form, unless the click was handled. */
  click(node: FakeNode): void {
    if (node.disabled || !this.shows(node)) throw new Error("a person cannot click what is disabled or not shown");
    // A click on a control gives it the cursor, as it does in most browsers.
    if (["button", "a", "input", "select", "textarea"].includes(node.tag)) node.focus();
    const event = this.fire(node, "click");
    const type = node.attrs.get("type") ?? "submit";
    if (!event.defaultPrevented && node.tag === "button" && type === "submit") {
      for (let n = node.parent; n; n = n.parent) {
        if (n.tag === "form") {
          this.submit(n);
          break;
        }
      }
    }
  }
  submit(form: FakeNode): void {
    this.fire(form, "submit");
  }
  /** Submit, and wait for what the page does about it: a person's next action comes after the page has finished with this one. */
  async send(form: FakeNode): Promise<void> {
    this.submit(form);
    await this.idle();
  }
  /** Type into a field: its value is replaced, and the page is told. */
  type(node: FakeNode | string, value: string): void {
    const n = typeof node === "string" ? this.$(node) : node;
    n.focus();
    n.value = value;
    this.fire(n, "input");
  }
  check(node: FakeNode | string, on = true): void {
    const n = typeof node === "string" ? this.$(node) : node;
    n.checked = on;
    this.fire(n, "change");
  }
  /** The tab goes behind another, or comes back to the front: the page is told, as a browser tells it. */
  setVisibility(state: "visible" | "hidden"): void {
    this.doc.visibilityState = state;
    const event = { type: "visibilitychange", target: this.doc, currentTarget: this.doc, defaultPrevented: false, preventDefault() {} } as FakeEvent;
    for (const fn of this.doc.listeners.get("visibilitychange") ?? []) fn(event);
  }
  /** The browser's own pageshow, as when the back button returns to the page. */
  pageshow(persisted: boolean): void {
    for (const fn of this.windowListeners.get("pageshow") ?? []) fn({ type: "pageshow", persisted } as unknown as FakeEvent);
  }
  /** The calls of one kind, in order. */
  to(method: string, pathName: string): Call[] {
    return this.calls.filter((c) => c.method === method && c.path === pathName);
  }
}

export async function visit(page: string, options: VisitOptions = {}): Promise<Visit> {
  return new Visit(page, options).start();
}

/** A value that came out of the sandbox, as one of this realm's: arrays and objects made there have another realm's prototypes. */
const own = <T>(value: T): T => (value !== null && typeof value === "object" ? (JSON.parse(JSON.stringify(value)) as T) : value);

/** The script's pure parts, as it exports them when it is not on a page. */
export function helpers(): Record<string, (...args: any[]) => any> & { NEEDS: Record<string, string[]>; STATES: Record<string, [string, string]>; POLICY_UNITS: Record<string, string> } {
  const module = { exports: {} as Record<string, unknown> };
  vm.runInNewContext(fs.readFileSync(SCRIPT, "utf8"), { module, Intl, URL, URLSearchParams, console }, { filename: "app.js" });
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(module.exports)) out[name] = typeof value === "function" ? (...args: unknown[]) => own((value as (...a: unknown[]) => unknown)(...args)) : own(value);
  return out as ReturnType<typeof helpers>;
}
