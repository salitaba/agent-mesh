import test from "node:test";
import assert from "node:assert/strict";

import type { Command } from "../../apps/mesh-dashboard/src/commands";
import { paletteMatches, pointerMoved } from "../../apps/mesh-dashboard/src/palette";

/**
 * The command palette's list. It was a substring test in registration order: "age" put "Go to Projects" (keywords: "manage")
 * above "Go to Agents", and the Projects page, registered by both the shell and the tab strip, was listed twice under one id.
 * These pin the ranking a person reads the top row by, and that a row under a resting mouse does not take the selection.
 */

const cmd = (id: string, label: string, keywords = "", scope = "global"): Command => ({ id, label, keywords, scope, run: () => undefined });

// The registry as a host with the demo open fills it: the tab strip's two first, then the shell's views, help and agents.
const REGISTRY: Command[] = [
  cmd("go.projects", "Go to Projects", "projects folders host manage open close remove", "host"),
  cmd("projects.new", "New project", "add create demo folder mesh start", "host"),
  cmd("go.overview", "Go to Overview", "view navigate overview 1"),
  cmd("go.escalations", "Go to Needs you", "view navigate escalations 2"),
  cmd("go.agents", "Go to Agents", "view navigate agents 3"),
  cmd("go.cost", "Go to Cost", "view navigate cost 8"),
  cmd("go.gates", "Go to Tool gates", "view navigate gates 11"),
  cmd("go.projects", "Go to Projects", "view navigate projects 12"),
  cmd("help.open", "Open help", "keyboard shortcuts keys ?"),
  cmd("agent.pm", "Jump to agent: pm", "search agent open pm product-manager IDLE"),
  cmd("agent.tech-lead", "Jump to agent: tech-lead", "search agent open tech-lead tech-lead IDLE"),
];
const labels = (q: string): string[] => paletteMatches(REGISTRY, q).map((c) => c.label);

test("a label that starts with the query comes first, then one with a word that does, then one that holds it, then keywords", () => {
  assert.deepEqual(labels("age"), ["Go to Agents", "Jump to agent: pm", "Jump to agent: tech-lead", "Go to Projects"],
    "Agents first: a keyword match ('manage') ranks below every label match");
  assert.deepEqual(labels("cost"), ["Go to Cost"], "a word of the label, and nothing that does not hold the query at all");
  assert.deepEqual(labels("go to a"), ["Go to Agents"], "the start of the label, across spaces");
  assert.deepEqual(labels("lead"), ["Jump to agent: tech-lead"], "a word starts after a hyphen too");
  assert.deepEqual(labels("roj"), ["Go to Projects", "New project"], "inside a word of the label: below a word start, above keywords");
  assert.deepEqual(labels("shortcuts"), ["Open help"], "keywords still find a command whose label does not say it");
});

test("within a rank the registration order is kept, so rows do not reshuffle as the query grows", () => {
  assert.deepEqual(labels("jump"), ["Jump to agent: pm", "Jump to agent: tech-lead"]);
  assert.deepEqual(labels("go to"), ["Go to Projects", "Go to Overview", "Go to Needs you", "Go to Agents", "Go to Cost", "Go to Tool gates"]);
});

test("each command is listed once, the first registration winning, with or without a query", () => {
  const all = paletteMatches(REGISTRY, "");
  assert.equal(all.filter((c) => c.id === "go.projects").length, 1, "one row per id, so one DOM id per row");
  assert.equal(all.find((c) => c.id === "go.projects")!.scope, "host");
  assert.equal(all.length, REGISTRY.length - 1);
  assert.deepEqual(all.map((c) => c.id), [...new Set(REGISTRY.map((c) => c.id))], "an empty query keeps registration order");
  assert.equal(paletteMatches(REGISTRY, "projects").filter((c) => c.id === "go.projects").length, 1);
});

test("the query is read the way it is meant: case, surrounding and repeated spaces do not matter", () => {
  assert.deepEqual(labels("  AGENTS "), ["Go to Agents"]);
  assert.deepEqual(labels("go   to   agents"), ["Go to Agents"]);
  assert.deepEqual(labels("   "), paletteMatches(REGISTRY, "").map((c) => c.label), "blank is the whole list");
  assert.deepEqual(labels("zzz"), []);
});

test("only a pointer that has moved picks a row: the first event says where it rests, the same spot again is the list moving", () => {
  assert.equal(pointerMoved(null, { x: 700, y: 400 }), false, "the palette opened under a resting mouse");
  assert.equal(pointerMoved({ x: 700, y: 400 }, { x: 700, y: 400 }), false, "a row slid under it as the list changed or scrolled");
  assert.equal(pointerMoved({ x: 700, y: 400 }, { x: 702, y: 400 }), true);
  assert.equal(pointerMoved({ x: 700, y: 400 }, { x: 700, y: 431 }), true);
});
