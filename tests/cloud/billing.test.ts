import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BillingUnsupportedError, BillingWebhookError, ManualBilling, MemoryMailer, OutboxMailer, ServiceError, header } from "../../packages/cloud/src/index";

test("manual billing sends a customer to the operator's own page with a reference to quote, the same one for the same request", async () => {
  const billing = new ManualBilling({ payUrl: (ref) => `https://app.example.com/pay?ref=${ref}` });
  assert.equal(billing.name, "manual");
  const input = { accountId: "acct_1", email: "a@example.com", purpose: "topup" as const, amountMinor: 2_500, currency: "USD", successUrl: "https://app/ok", cancelUrl: "https://app/no", idempotencyKey: "abc123" };
  assert.deepEqual(await billing.createCheckout(input), { url: "https://app.example.com/pay?ref=manual_abc123", ref: "manual_abc123" });
  assert.deepEqual(await billing.createCheckout(input), { url: "https://app.example.com/pay?ref=manual_abc123", ref: "manual_abc123" });
});

test("manual billing has no portal and receives no messages, and says so", async () => {
  const billing = new ManualBilling({ payUrl: () => "" });
  await assert.rejects(() => billing.openPortal(), (err: Error) => err instanceof BillingUnsupportedError && /There is no billing portal for payments made by invoice or transfer/.test(err.message));
  assert.throws(() => billing.parseWebhook(), (err: Error) => err instanceof BillingWebhookError && /Manual billing receives no messages/.test(err.message));
});

test("a header is read by its lower-case name, and the first value of one that was sent more than once", () => {
  assert.equal(header({ "stripe-signature": "a" }, "Stripe-Signature"), "a");
  assert.equal(header({ "stripe-signature": ["first", "second"] }, "stripe-signature"), "first");
  assert.equal(header({}, "stripe-signature"), undefined);
  assert.equal(header({ "stripe-signature": undefined }, "stripe-signature"), undefined);
});

test("a refusal carries its status, a code to match on, words for the person, and any headers", () => {
  const e = new ServiceError(429, "slow_down", "Wait a little.", { "retry-after": "5" });
  assert.equal(e.status, 429);
  assert.equal(e.code, "slow_down");
  assert.equal(e.message, "Wait a little.");
  assert.deepEqual(e.headers, { "retry-after": "5" });
  assert.equal(e.name, "ServiceError");
  assert.deepEqual(new ServiceError(400, "x", "y").headers, {});
});

test("the memory mailer keeps what it was asked to send, in order", async () => {
  const mailer = new MemoryMailer();
  await mailer.send({ to: "a@example.com", kind: "verify", subject: "One", text: "1" });
  await mailer.send({ to: "b@example.com", kind: "reset", subject: "Two", text: "2" });
  assert.deepEqual(
    mailer.sent.map((m) => [m.to, m.kind]),
    [
      ["a@example.com", "verify"],
      ["b@example.com", "reset"],
    ],
  );
});

test("the outbox mailer appends each message to a file as one JSON object with the time it was written, readable by its owner alone", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "outbox-"));
  try {
    const file = path.join(dir, "nested", "outbox.jsonl");
    const mailer = new OutboxMailer(file, () => new Date("2026-10-05T12:00:00.000Z"));
    await mailer.send({ to: "a@example.com", kind: "verify", subject: "Confirm", text: "Open https://app.example.com/verify?token=x" });
    await mailer.send({ to: "b@example.com", kind: "payment-failed", subject: "A payment did not go through", text: "line one\nline two" });
    const lines = fs.readFileSync(file, "utf8").split("\n");
    assert.equal(lines.at(-1), "", "every message ends with a newline");
    assert.deepEqual(JSON.parse(lines[0]!), { at: "2026-10-05T12:00:00.000Z", to: "a@example.com", kind: "verify", subject: "Confirm", text: "Open https://app.example.com/verify?token=x" });
    assert.equal(JSON.parse(lines[1]!).text, "line one\nline two", "a message with a line break is still one line of the file");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
