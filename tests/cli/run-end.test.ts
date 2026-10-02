import { test } from "node:test";
import assert from "node:assert/strict";
import { reportWhenSettled } from "../../apps/mesh-cli/src/index";

/**
 * The closing report is composed after the turns still running have settled.
 *
 * `ordane run` printed its report the moment the goal's status changed. The turn that changed it (the pm's last acceptance, as a
 * rule) was still running, and its spend was booked a few seconds later, so the SPEND line was short by that turn in every real
 * run: run 8 said 839k tokens and 48 turns where the ledger had 861k and 49, run 9 said 534k and 33 where it had 548k and 34,
 * then 817k and 49 against 836k and 50. A figure a customer reads against `ordane usage` and the provider's invoice, and was
 * never the same as either. The shutdown joins the completion and drains those turns; reading the state after it is reading
 * the whole run.
 */

test("the report reads the ledger after the shutdown has settled the last turn, not before", async () => {
  let billed = 534_000; // what the ledger held when the goal's status changed
  const order: string[] = [];
  await reportWhenSettled(
    async () => {
      order.push("settle");
      await new Promise((r) => setTimeout(r, 5)); // the turn that completed the goal ends a few seconds later
      billed += 14_316;
    },
    () => {
      order.push(`report:${billed}`);
    },
    () => order.push("say"),
    "completed",
  );
  assert.deepEqual(order, ["say", "settle", "report:548316"], "told first, then settled, then reported on the settled figure");
});

test("the operator is told at once what the wait is for", async () => {
  const said: string[] = [];
  await reportWhenSettled(async () => undefined, () => undefined, (line) => said.push(line), "completed");
  assert.equal(said.length, 1);
  assert.match(said[0]!, /goal completed — letting the turns still running finish, then the report/);
});

test("a shutdown that fails still gets its report, and the failure is not swallowed", async () => {
  const order: string[] = [];
  await assert.rejects(
    reportWhenSettled(
      async () => {
        order.push("settle");
        throw new Error("drain timed out");
      },
      () => order.push("report"),
      () => order.push("say"),
      "failed",
    ),
    /drain timed out/,
  );
  assert.deepEqual(order, ["say", "settle", "report"], "what the run produced is said whatever happens to the shutdown");
});
