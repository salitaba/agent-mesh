import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyBusStyle, resolveConfig } from "../../packages/config/src/index";

/**
 * `bus.style` — a whole coherent bus written as one word.
 *
 * The claim the key makes is narrow and it is the only thing worth testing:
 * a style is an EXPANSION into raw keys and nothing more. Not a mode, not a
 * flag anything downstream branches on, and above all not a second path into
 * the absent-vs-zero-vs-present decisions the resolvers make — those are the
 * distinctions that decide whether a mesh has deadlines at all, whether it
 * prices attention, and whether it advertises a different manifest, and every
 * one of them is a presence test on a raw key.
 *
 * So the load-bearing test here is not "low-contact sets these five values".
 * It is that a styled mesh and the hand-written mesh it expands to resolve to
 * the SAME OBJECT. If that holds, a style cannot reach a state an operator
 * could not have typed, and nothing downstream needs to know styles exist.
 */

function resolveRaw(text: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-busstyle-test-"));
  fs.writeFileSync(path.join(dir, "mesh.yaml"), text, "utf8");
  try {
    return resolveConfig(path.join(dir, "mesh.yaml"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const mesh = (busBlock: string): string => `version: 1
mesh:
  id: busstyletest
  goal: |
    Test.
  workspace: { path: ./workspace }
  runtime: { default: stub }
agents:
  dev:
    role: developer
    capabilities:
      - repository.write
    authority: []
${busBlock}startup:
  activate: [dev]
`;

const busOf = (busBlock: string) => resolveRaw(mesh(busBlock)).bus;

test("no style and no bus block are the same mesh, and `high-contact` is the name for it", () => {
  const unstyled = busOf("");
  const styled = busOf("bus:\n  style: high-contact\n");

  // `style` itself is the one difference, and it is a record of a CHOICE
  // rather than a behaviour: the operator looked at this and kept what every
  // mesh already had. Everything the runtime reads must be identical.
  const { style, ...styledBehaviour } = styled;
  assert.equal(style, "high-contact");
  assert.equal(unstyled.style, undefined, "an unstyled mesh names no style");
  assert.deepEqual(styledBehaviour, unstyled, "high-contact must be a name, not a change");

  // And the three absences that every other test in the repo depends on.
  assert.equal(unstyled.commitmentTtl, undefined);
  assert.equal(unstyled.deliveryClasses, undefined);
  assert.equal(unstyled.vocabulary, undefined);
});

test("`balanced` gives deadlines and delivery classes, and leaves the manifest alone", () => {
  const bus = busOf("bus:\n  style: balanced\n");
  assert.deepEqual(bus.commitmentTtl, { defaultMs: 1_800_000, byRole: {} }, "an ask that hangs forever is the thing balanced fixes first");
  assert.equal(bus.deliveryClasses?.coalesceMs, 60_000, "the shipped default, not a style-specific number");
  assert.equal(bus.deliveryClasses?.interruptCostTokens, 2000);
  assert.equal(bus.deliveryClasses?.attentionTokens, undefined, "balanced routes wakes; it does not start billing a budget line nobody set");
  assert.equal(bus.vocabulary, undefined, "and it does not change the tools a seat is shown");
  assert.equal(bus.contractsByType, false);
});

test("`low-contact` prices attention, collapses the manifest, and tightens the box", () => {
  const bus = busOf("bus:\n  style: low-contact\n");
  assert.deepEqual(bus.commitmentTtl, { defaultMs: 900_000, byRole: {} });
  assert.deepEqual(bus.deliveryClasses, {
    coalesceMs: 300_000,
    interruptCostTokens: 2000,
    attentionTokens: 200_000,
    congestionEvery: 4,
  });
  assert.equal(bus.vocabulary, "contracts");
  assert.equal(bus.contractsByType, true, "nobody is chasing these asks, so how one ended has to be countable");
  assert.deepEqual(bus.collab, { boxMs: 600_000, maxExchanges: 10 });
});

test("low-contact's deadline is SHORTER than balanced's, because nothing else ends these asks", () => {
  // Looks backwards until you notice what is not on: with no nudge ladder
  // reaching a defaulted ask and no chase behind an ordinary one, the
  // deadline is the only thing that closes it. A longer one is not patience,
  // it is a debt the ledger carries silently.
  assert.ok(
    busOf("bus:\n  style: low-contact\n").commitmentTtl!.defaultMs < busOf("bus:\n  style: balanced\n").commitmentTtl!.defaultMs,
  );
});

test("a styled mesh is indistinguishable from the mesh it expands to", () => {
  const styled = busOf("bus:\n  style: low-contact\n");
  const byHand = busOf(
    [
      "bus:",
      "  commitments: { ttl_ms: 900000, by_type: true }",
      "  vocabulary: contracts",
      "  collab: { box_ms: 600000, max_exchanges: 10 }",
      "  delivery: { classes: true, coalesce_ms: 300000, attention_tokens: 200000, congestion_every: 4 }",
      "",
    ].join("\n"),
  );
  const { style, ...styledBehaviour } = styled;
  assert.equal(style, "low-contact");
  assert.deepEqual(styledBehaviour, byHand, "a style must not be able to reach a bus an operator could not have typed");
});

test("a key written beside a style wins, per KEY and not per block", () => {
  const bus = busOf("bus:\n  style: low-contact\n  delivery: { coalesce_ms: 30000 }\n");
  assert.equal(bus.deliveryClasses?.coalesceMs, 30_000, "the operator's number");
  // The failure this pins: a whole-block override would silently drop the
  // attention price and the congestion curve, leaving a mesh that says
  // low-contact and bills nothing.
  assert.equal(bus.deliveryClasses?.attentionTokens, 200_000, "and everything they did not mention");
  assert.equal(bus.deliveryClasses?.congestionEvery, 4);
});

test("an override can switch OFF what the style switched on", () => {
  // `ttl_ms: 0` is how deadlines are spelled off, and a style that could not
  // be contradicted would be a mode rather than a starting point.
  const bus = busOf("bus:\n  style: low-contact\n  commitments: { ttl_ms: 0 }\n");
  assert.equal(bus.commitmentTtl, undefined, "a low-contact mesh with deadlines off is a legal mesh, not a conflict");
  assert.equal(bus.vocabulary, "contracts", "and the rest of the style still stands");

  const off = busOf("bus:\n  style: low-contact\n  delivery: { classes: false }\n");
  assert.equal(off.deliveryClasses, undefined, "`classes: false` is silence, and silence beats the preset that wrote it");
});

test("the expansion is raw, so a style can never produce a shape a hand-written file cannot", () => {
  // Asserted on the expander directly rather than through a resolved config,
  // because what is being pinned is the INPUT to the resolvers: everything
  // this function returns has to be spellable in mesh.yaml.
  const expanded = applyBusStyle({ style: "low-contact" })!;
  assert.equal(expanded.style, "low-contact");
  assert.equal(expanded.commitments?.ttl_ms, 900_000);
  assert.equal(expanded.delivery?.classes, true);
  assert.equal(expanded.vocabulary, "contracts");

  assert.equal(applyBusStyle(undefined), undefined, "no bus block stays no bus block");
  assert.deepEqual(applyBusStyle({ transport: "typed-only" }), { transport: "typed-only" }, "and an unstyled one is passed through untouched");
  assert.deepEqual(applyBusStyle({ style: "high-contact" }), { style: "high-contact" }, "high-contact adds nothing, because it IS nothing");
});

test("an unknown style is a config ERROR, not a silently ignored word", () => {
  assert.throws(() => busOf("bus:\n  style: quiet\n"), /style/);
});
