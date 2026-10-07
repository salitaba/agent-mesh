import test from "node:test";
import assert from "node:assert/strict";

import type { Command } from "../../apps/mesh-dashboard/src/commands";
import { groupCommands, paletteOrder } from "../../apps/mesh-dashboard/src/palette-groups";

/**
 * The palette lists its rows in groups until something is typed. The keyboard walks the rows in the order they are drawn, so the order
 * of the groups and the flat order the arrow keys use are one answer.
 */

const cmd = (id: string, label = id): Command => ({ id, label, scope: "global", run: () => undefined });
const groupOf = (c: Command): string => (c.id.startsWith("go.") ? "Go to" : c.id.startsWith("agent.") ? "Agents" : c.id.startsWith("x.") ? "Elsewhere" : "Actions");
const ORDER = ["Go to", "Agents", "Actions"];

// The registry as a host fills it: the strip's host commands first, then the shell's views, help and the agents.
const REGISTRY = [cmd("projects.new"), cmd("go.overview"), cmd("go.agents"), cmd("help.open"), cmd("agent.pm"), cmd("agent.qa"), cmd("chat.ask")];

test("the groups come in the order given, each row in the order it was registered", () => {
  const groups = groupCommands(REGISTRY, groupOf, ORDER);
  assert.deepEqual(groups.map((g) => g.label), ["Go to", "Agents", "Actions"]);
  assert.deepEqual(groups.map((g) => g.items.map((c) => c.id)), [["go.overview", "go.agents"], ["agent.pm", "agent.qa"], ["projects.new", "help.open", "chat.ask"]]);
});

test("a group nobody listed follows the ones that were, in the order it appears", () => {
  const groups = groupCommands([cmd("x.one"), cmd("go.overview"), cmd("y.two", "y")], (c) => (c.id.startsWith("x.") ? "Elsewhere" : c.id.startsWith("go.") ? "Go to" : "Misc"), ORDER);
  assert.deepEqual(groups.map((g) => g.label), ["Go to", "Elsewhere", "Misc"]);
});

test("a group with nothing in it is not drawn", () => {
  assert.deepEqual(groupCommands([cmd("go.overview")], groupOf, ORDER).map((g) => g.label), ["Go to"]);
  assert.deepEqual(groupCommands([], groupOf, ORDER), []);
});

test("the keyboard's order is the drawn order", () => {
  const flat = paletteOrder(REGISTRY, groupOf, ORDER).map((c) => c.id);
  assert.deepEqual(flat, groupCommands(REGISTRY, groupOf, ORDER).flatMap((g) => g.items.map((c) => c.id)));
  assert.deepEqual(flat, ["go.overview", "go.agents", "agent.pm", "agent.qa", "projects.new", "help.open", "chat.ask"]);
});
