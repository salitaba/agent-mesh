import test from "node:test";
import assert from "node:assert/strict";

import {
  HOSTED,
  KEY_MISSING,
  failureText,
  folderVerdict,
  hostedAfter,
  keyIsMissing,
  landingView,
  looksAbsolute,
  modelTag,
  parseTemplates,
  pickDefault,
  pickDemo,
  readBrowse,
  safeHref,
  whatItCosts,
  whatItIs,
  whatHappensNext,
  whatItNeeds,
  whatItTakes,
  writesWhat,
  type TemplateOffer,
} from "../../apps/mesh-dashboard/src/firstrun";
import { GOAL_EXAMPLES } from "../../apps/mesh-dashboard/src/goal";

const offer = (over: Partial<TemplateOffer> = {}): TemplateOffer => ({
  id: "demo-stub", kind: "example", title: "Demo", goal: "Build and ship a small idempotent payment endpoint.", seats: 7, runtime: "stub",
  needsApiKey: false, rolePrompts: 7, missionTokens: 2_000_000, projectId: null, suggestedRoot: "/home/me/curule-projects/demo-stub", ...over,
});
const claude = (over: Partial<TemplateOffer> = {}): TemplateOffer => offer({ id: "default", kind: "default", title: "Default team", goal: null, seats: 1, runtime: "claude", needsApiKey: true, rolePrompts: 1, suggestedRoot: "/home/me/curule-projects/my-mesh", ...over });

const answer = {
  templates: [claude(), offer(), offer({ id: "payment-api", needsApiKey: true, runtime: "claude", seats: 7 })],
  defaultParent: "/home/me/curule-projects",
  confined: false,
  modelAccess: ["ANTHROPIC_API_KEY"],
  managed: false,
};

test("the host's answer is read into offers, and what is not complete is dropped, not half shown", () => {
  const parsed = parseTemplates(answer)!;
  assert.deepEqual(parsed.templates.map((t) => t.id), ["default", "demo-stub", "payment-api"]);
  assert.equal(parsed.defaultParent, "/home/me/curule-projects");
  assert.deepEqual(parsed.modelAccess, ["ANTHROPIC_API_KEY"]);
  const messy = parseTemplates({ templates: [{ id: "a", kind: "example" }, "nope", null, { id: "b", kind: "example", suggestedRoot: "/x", needsApiKey: false, seats: "7" }, { id: "c", kind: "odd", suggestedRoot: "/x" }], modelAccess: [1, "X"] })!;
  assert.deepEqual(messy.templates.map((t) => t.id), ["b"]);
  assert.equal(messy.templates[0]!.needsApiKey, false);
  assert.equal(messy.templates[0]!.seats, 0, "a seat count that is not a number is not invented");
  assert.deepEqual(messy.modelAccess, ["X"]);
  for (const bad of [null, undefined, 3, "x", [], {}, { templates: [] }, { templates: "x" }, { templates: [{ id: "a" }] }]) assert.equal(parseTemplates(bad), null, JSON.stringify(bad));
});

test("a host that says its models are supplied is read as managed, and one that says nothing, or something else, is not", () => {
  const one = [{ id: "x", kind: "example", suggestedRoot: "/x" }];
  assert.equal(parseTemplates({ templates: one, managed: true })!.managed, true);
  for (const not of [undefined, false, "true", 1, null, {}]) assert.equal(parseTemplates({ templates: one, managed: not })!.managed, false, JSON.stringify(not));
  assert.equal(parseTemplates(answer)!.managed, false);
});

test("a field the host left out is read as the cautious thing: a team needs a key unless it says it does not", () => {
  const o = parseTemplates({ templates: [{ id: "x", kind: "example", suggestedRoot: "/x" }] })!.templates[0]!;
  assert.equal(o.needsApiKey, true);
});

test("the demo is the shipped team that needs no model, whatever it is called; the new mesh is the default team", () => {
  const parsed = parseTemplates(answer)!;
  assert.equal(pickDemo(parsed)!.id, "demo-stub");
  assert.equal(pickDefault(parsed)!.id, "default");
  const renamed = parseTemplates({ templates: [claude(), offer({ id: "tour" })] })!;
  assert.equal(pickDemo(renamed)!.id, "tour");
  const noDemo = parseTemplates({ templates: [claude(), offer({ id: "payment-api", needsApiKey: true })] })!;
  assert.equal(pickDemo(noDemo), null, "an install without the demo does not offer one");
  assert.equal(pickDemo(parseTemplates({ templates: [claude({ needsApiKey: false })] })!), null, "the default team is not the demo even if it needed no key");
});

test("what a starting point is, says its seats and its goal from the facts, and the default team is a blank", () => {
  assert.equal(whatItIs(offer()), "A scripted team of 7 seats works on this goal: Build and ship a small idempotent payment endpoint.");
  assert.equal(whatItIs(offer({ seats: 1, goal: null })), "A scripted team of 1 seat.");
  assert.match(whatItIs(claude()), /^The default team: one architect seat and a goal for you to write/);
});

test("what it writes is said with the counts it was given", () => {
  assert.equal(writesWhat(offer()), "mesh.yaml and 7 role prompts");
  assert.equal(writesWhat(claude()), "mesh.yaml and 1 role prompt");
  assert.equal(writesWhat(offer({ rolePrompts: 0 })), "mesh.yaml");
});

test("a run's length is said only for a scripted team, which makes no model calls; a real team gets no figure", () => {
  assert.equal(whatItTakes(offer()), "A few seconds after you press Start.");
  assert.equal(whatItTakes(claude()), null, "a team on a model takes as long as the work does");
  assert.equal(whatItTakes(offer({ runtime: "mixed", needsApiKey: true })), null);
});

test("a team that needs no key says it needs nothing; one that does says what this host has, by name, and what it lacks", () => {
  assert.deepEqual(whatItNeeds(offer(), []), { text: "Nothing. It runs on the stub runtime, so it makes no model calls.", tone: "ok" });
  assert.deepEqual(whatItNeeds(offer(), ["ANTHROPIC_API_KEY"]).tone, "ok", "a key it does not need changes nothing");
  const has = whatItNeeds(claude(), ["ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_VERTEX"]);
  assert.equal(has.tone, "ok");
  assert.match(has.text, /which this host has \(ANTHROPIC_API_KEY, CLAUDE_CODE_USE_VERTEX\)/);
  const lacks = whatItNeeds(claude(), []);
  assert.equal(lacks.tone, "warn");
  assert.match(lacks.text, /which this host lacks/);
  assert.match(lacks.text, /ANTHROPIC_API_KEY.*Bedrock.*Vertex AI.*Foundry/);
});

test("where the service supplies the models a team needs nothing from the person, said before the host's own settings are looked at", () => {
  const team = claude({ runtime: "native" });
  assert.deepEqual(whatItNeeds(team, [], true), { text: "Models, which this workspace's service supplies. You bring no key.", tone: "ok" });
  assert.deepEqual(whatItNeeds(team, ["ANTHROPIC_API_KEY"], true).tone, "ok");
  assert.equal(whatItNeeds(team, [], false).tone, "warn", "the same team on a host with no models and no managed flag still lacks them");
  assert.deepEqual(whatItNeeds(offer(), [], true), { text: "Nothing. It runs on the stub runtime, so it makes no model calls.", tone: "ok" }, "the demo needs no models, managed or not");
});

test("where the service supplies the models, a team draws on the account's balance and does not spend on a provider account of the person's own", () => {
  assert.equal(
    whatItCosts(claude({ missionTokens: 2_000_000, runtime: "native" }), 50, true),
    "Draws on your account's balance: each call is charged what it cost, and the usage is in your account. The mission is capped at 2,000,000 tokens. The host parks every open project once their estimated spend reaches $50.00.",
  );
  assert.equal(whatItCosts(claude({ missionTokens: null }), null, true), "Draws on your account's balance: each call is charged what it cost, and the usage is in your account.");
  assert.equal(whatItCosts(offer(), 50, true), "Nothing, and there is no bill. The token counts it shows are the script's own.", "the demo costs nothing on any host");
  assert.match(whatItCosts(claude(), null, false), /^Spends tokens on your own provider account/);
});

test("what it costs: nothing for the demo; tokens on the person's own account for the Claude team, with the caps that exist", () => {
  assert.equal(whatItCosts(offer(), 50), "Nothing, and there is no bill. The token counts it shows are the script's own.");
  assert.equal(
    whatItCosts(claude({ missionTokens: 2_000_000 }), 50),
    "Spends tokens on your own provider account. The mission is capped at 2,000,000 tokens. The host parks every open project once their estimated spend reaches $50.00.",
  );
  const bare = whatItCosts(claude({ missionTokens: null }), null);
  assert.equal(bare, "Spends tokens on your own provider account.", "no cap, no ceiling: no figure is invented");
  assert.doesNotMatch(whatItCosts(claude(), 0), /parks every open project/, "a ceiling of zero is not a ceiling to quote");
  assert.doesNotMatch(whatItCosts(claude(), null), /parks every open project/, "nor one the host did not report");
});

test("a new mesh lands in the Designer; the demo and an existing folder land on the Overview", () => {
  assert.equal(landingView("new"), "designer");
  assert.equal(landingView("demo"), "overview");
  assert.equal(landingView("existing"), "overview");
});

test("the line under each button names the page the console goes to, and the demo says what to do there", () => {
  assert.equal(whatHappensNext("demo"), "Then opens the Overview, where you press Start.");
  assert.equal(whatHappensNext("new"), "Then opens the Designer.");
  assert.equal(whatHappensNext("existing"), "Then opens the Overview.");
  for (const intent of ["demo", "new", "existing"] as const) {
    const page = landingView(intent) === "designer" ? /Designer/ : /Overview/;
    assert.match(whatHappensNext(intent), page, `${intent}: the sentence follows the move`);
    assert.doesNotMatch(whatHappensNext(intent), landingView(intent) === "designer" ? /Overview/ : /Designer/);
  }
});

test("what the host said about a typed folder becomes a fact the card can use", () => {
  assert.deepEqual(readBrowse(200, { path: "/x", hasMesh: true, entries: [] }), { kind: "folder", hasMesh: true });
  assert.deepEqual(readBrowse(200, { path: "/x", hasMesh: false, entries: [] }), { kind: "folder", hasMesh: false });
  assert.deepEqual(readBrowse(200, { path: "/x", hasMesh: false, entries: [], error: "ENOENT: no such file or directory, scandir '/x'" }), { kind: "missing" });
  assert.deepEqual(readBrowse(200, { path: "/x", error: "ENOTDIR: not a directory, scandir '/x'" }), { kind: "file" });
  assert.deepEqual(readBrowse(200, { path: "/x", error: "EACCES: permission denied, scandir '/x'" }), { kind: "denied" });
  assert.deepEqual(readBrowse(200, { path: "/x", error: "EMFILE: too many open files" }), { kind: "unreadable", detail: "EMFILE: too many open files" });
  assert.deepEqual(readBrowse(403, { error: "that folder is outside ...", code: "outside_projects_root", reason: "This host only works under /data/projects." }), { kind: "outside", reason: "This host only works under /data/projects." });
  assert.equal(readBrowse(500, { error: "boom" }), null, "a host that failed has told nothing");
  assert.equal(readBrowse(200, "html"), null);
  assert.equal(readBrowse(401, { error: "invalid token" }), null);
});

test("a path is full or it is not: the field says so before it asks the host anything", () => {
  for (const full of ["/", "/data/projects/x", "~", "~/work", "~\\work", "C:\\Users\\me", "c:/work", "\\\\server\\share", "  /padded  "]) assert.equal(looksAbsolute(full), true, full);
  for (const relative of ["work/demo", "./x", "../x", "demo", "~other/x", ".", "C:", ""]) assert.equal(looksAbsolute(relative), false, JSON.stringify(relative));
  for (const intent of ["create", "add"] as const) {
    const relative = folderVerdict(intent, "work/demo", { kind: "folder", hasMesh: true });
    assert.equal(relative.canProceed, false, "a relative path is not sent, whatever the host once said about a folder of that name");
    assert.equal(relative.message, "Give the folder's full path, starting with / or ~/.");
    const empty = folderVerdict(intent, "  ", null);
    assert.equal(empty.canProceed, false, "nothing typed, nothing to do");
    assert.match(empty.message, /full path, or choose one with Browse/, "and a disabled button is never left without a reason");
  }
});

test("creating needs no mesh.yaml to be there and refuses to replace one; a missing folder is fine, because it will be made", () => {
  const create = (facts: Parameters<typeof folderVerdict>[2]) => folderVerdict("create", "/x", facts);
  assert.equal(create({ kind: "missing" }).canProceed, true);
  assert.match(create({ kind: "missing" }).message, /will be created/);
  assert.equal(create({ kind: "folder", hasMesh: false }).canProceed, true);
  const taken = create({ kind: "folder", hasMesh: true });
  assert.equal(taken.canProceed, false);
  assert.equal(taken.tone, "bad");
  assert.match(taken.message, /already holds a mesh\.yaml/);
  assert.match(taken.message, /Add an existing folder/);
  assert.equal(create({ kind: "file" }).canProceed, false);
  assert.equal(create({ kind: "outside", reason: "Only under /data/projects." }).message, "Only under /data/projects.");
  assert.equal(create({ kind: "outside", reason: "x" }).canProceed, false);
  // Not knowing is not a no: the host decides, and says why if it refuses.
  assert.equal(create(null).canProceed, true);
  assert.equal(create({ kind: "denied" }).canProceed, true);
  assert.equal(create({ kind: "denied" }).tone, "warn");
  assert.equal(create({ kind: "unreadable", detail: "EMFILE" }).canProceed, true);
});

test("adding needs a mesh.yaml to be there; a folder without one is said so and offers to make one, never makes one", () => {
  const add = (facts: Parameters<typeof folderVerdict>[2]) => folderVerdict("add", "/x", facts);
  const found = add({ kind: "folder", hasMesh: true });
  assert.equal(found.canProceed, true);
  assert.equal(found.tone, "ok");
  assert.equal(found.message, "mesh.yaml found.");
  assert.equal(found.offerCreate, false);
  const bare = add({ kind: "folder", hasMesh: false });
  assert.equal(bare.canProceed, false, "pressing Add on a folder with no mesh.yaml does nothing");
  assert.equal(bare.message, "There is no mesh.yaml in this folder.");
  assert.equal(bare.offerCreate, true, "and the separate choice to create one is offered");
  assert.equal(add({ kind: "missing" }).canProceed, false);
  assert.equal(add({ kind: "missing" }).offerCreate, false, "a folder that is not there is not one to create in by accident");
  assert.equal(add({ kind: "file" }).canProceed, false);
  assert.equal(add(null).canProceed, true);
  assert.equal(add({ kind: "denied" }).canProceed, true);
});

test("a failed create or add says what the host said, as a sentence, and what to do when it said nothing", () => {
  assert.equal(failureText({ status: 409, reason: "A project named \"x\" is already on this host." }), "A project named \"x\" is already on this host.");
  assert.equal(failureText({ status: 400, error: "no such path: /x" }), "no such path: /x.");
  assert.equal(failureText({ status: 400, reason: "  ", error: "bad" }), "bad.");
  assert.equal(failureText({ status: 502 }), "The host answered 502. Try again.");
  assert.equal(failureText({ status: 0 }), "The host did not answer. Check that it is still running, then try again.");
  assert.equal(failureText(null), "The host did not answer. Check that it is still running, then try again.");
});

const ONE = [{ id: "x", kind: "example", suggestedRoot: "/x" }];
const HOSTED_ANSWER = { templates: ONE, hosted: { accountUrl: "https://app.curule.example/account" } };

test("a host that says it is a hosted workspace is read with where its account page is; one that says nothing, or an address a link must not carry, is not", () => {
  assert.deepEqual(parseTemplates(HOSTED_ANSWER)!.hosted, { accountUrl: "https://app.curule.example/account" });
  assert.equal(parseTemplates({ templates: ONE, hosted: { accountUrl: "  http://localhost:7870/account " } })!.hosted?.accountUrl, "http://localhost:7870/account");
  for (const bad of [undefined, null, {}, "yes", true, [], { accountUrl: "" }, { accountUrl: 3 }, { accountUrl: "javascript:alert(1)" }, { accountUrl: "data:text/html,x" }, { accountUrl: "ftp://x/y" }, { accountUrl: "/account" }, { accountUrl: "not a url" }]) {
    assert.equal(parseTemplates({ templates: ONE, hosted: bad })!.hosted, null, JSON.stringify(bad));
  }
  assert.equal(parseTemplates(answer)!.hosted, null, "a laptop's host says nothing of the kind");
  assert.equal(safeHref("https://a.example/x"), "https://a.example/x");
  assert.equal(safeHref("JAVASCRIPT:alert(1)"), null);
});

test("a key is missing only on a hosted workspace that supplies no models and found none; on a laptop's host that lack is the owner's, in their own words", () => {
  const read = (extra: object) => parseTemplates({ ...HOSTED_ANSWER, ...extra })!;
  assert.equal(keyIsMissing(read({})), true, "a hosting-only workspace before its key");
  assert.equal(keyIsMissing(read({ managed: true, modelSource: "own" })), false, "the customer's key is in");
  assert.equal(keyIsMissing(read({ managed: true })), false, "the service supplies the models");
  assert.equal(keyIsMissing(read({ modelAccess: ["ANTHROPIC_API_KEY"] })), false, "an operator gave every workspace a key");
  assert.equal(keyIsMissing(parseTemplates({ templates: ONE })!), false, "a laptop with no key is not sent to an account page it does not have");
  assert.equal(KEY_MISSING, "Your team needs a model key to think. Add it on your account page.");
});

test("what a team needs on a hosted workspace with no key is the sentence that sends the person to their account; the laptop's keeps naming the settings", () => {
  const team = claude();
  assert.deepEqual(whatItNeeds(team, [], false, false, true), { text: KEY_MISSING, tone: "warn" });
  assert.equal(whatItNeeds(team, ["ANTHROPIC_API_KEY"], false, false, true).tone, "ok", "a key an operator gave is found first");
  assert.deepEqual(whatItNeeds(team, [], true, true, true).tone, "ok");
  assert.match(whatItNeeds(team, [], false, false, false).text, /Set ANTHROPIC_API_KEY/, "unchanged for a host that is not a workspace");
  assert.deepEqual(whatItNeeds(offer(), [], false, false, true), { text: "Nothing. It runs on the stub runtime, so it makes no model calls.", tone: "ok" }, "the demo needs nothing, key or no key");
});

test("the tag on the default team says where its models come from or what is missing, and on a workspace the missing key is the person's own to add", () => {
  const read = (extra: object) => parseTemplates({ templates: [claude()], ...extra })!;
  const team = claude();
  assert.deepEqual(modelTag(read({ managed: true }), team), { text: "Models supplied", tone: "ok" });
  assert.deepEqual(modelTag(read({ managed: true, modelSource: "own" }), team), { text: "Your model key", tone: "ok" });
  assert.deepEqual(modelTag(read({ modelAccess: ["ANTHROPIC_API_KEY"] }), team), { text: "Model access found", tone: "ok" });
  assert.deepEqual(modelTag(read({}), team), { text: "Needs model access", tone: "warn" });
  assert.deepEqual(modelTag(read({ hosted: { accountUrl: "https://app.curule.example/account" } }), team), { text: "Needs your model key", tone: "warn" });
  assert.equal(modelTag(read({}), offer()), null, "a team that needs no model has no tag about models");
});

test("the hosted welcome's main path has no folder, path, host, Browse or mesh.yaml in it: a customer has none of those to set", () => {
  const words = [...Object.entries(HOSTED).filter(([k]) => k !== "details").map(([, v]) => v), hostedAfter(), KEY_MISSING, ...GOAL_EXAMPLES.flatMap((e) => [e.label, e.text])];
  for (const w of words) assert.doesNotMatch(w, /\b(folders?|paths?|hosts?|browse|mesh\.yaml|director(y|ies)|environment|ANTHROPIC_API_KEY)\b/i, w);
  assert.equal(HOSTED.title, "Welcome to your workspace");
  assert.equal(HOSTED.create, "Create the team");
  assert.match(HOSTED.demo, /^Try the demo first \(no model, no cost\)$/);
});

test("the line under Create the team follows the move, and says the team can be changed before anything runs", () => {
  assert.equal(hostedAfter(), "Then opens the Designer. You can change the team there before you start.");
  assert.equal(hostedAfter().startsWith(whatHappensNext("new")), true, "said from the same place as the card's, so the sentence and the move cannot part");
  assert.match(HOSTED.lede, /Nothing runs until you press Start\./);
});
