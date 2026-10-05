import type { PublicKeySet } from "./token";

/**
 * The public keys this build accepts licences from, by key id.
 *
 * Public halves only. The matching private key belongs to whoever sells the product and
 * must never be committed or shipped. To start issuing:
 *
 *     node tools/license/mesh-license.mjs keygen --kid k1 --out ~/secrets/mesh-license-k1.pem
 *
 * keep the PEM somewhere only the vendor can read, and add the public key it prints:
 *
 *     export const LICENSE_PUBLIC_KEYS: PublicKeySet = { k1: "MCow…" };
 *
 * To rotate, add `k2` beside `k1`, sign new licences with `k2`, and drop `k1` in a
 * later release once its licences have expired. Until a key is added here, every
 * licence reads as "unknown-key" and an install runs on the Community plan.
 *
 * `prod1` is the key the operator of Curule Cloud signs workspace licences with (generated
 * 2026-10-05; its private half is kept by the operator, outside the repository). A build
 * from this tree trusts it, which is what lets a hosted workspace run on the limits of the
 * plan that was paid for. The id is not `k1` because the tests make keys of their own under
 * that name and assert that a build trusts none.
 */
export const LICENSE_PUBLIC_KEYS: PublicKeySet = { prod1: "MCowBQYDK2VwAyEAcr86Bflok3QBxixtKejgjK7d2UhXGjB8ADo0XgyYTkU" };
