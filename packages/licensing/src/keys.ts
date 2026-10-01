import type { PublicKeySet } from "./token";

/**
 * The public keys this build accepts licences from, by key id.
 *
 * EMPTY IN THE SOURCE TREE, on purpose. The matching private key belongs to whoever
 * sells the product and must never be committed or shipped. To start issuing:
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
 */
export const LICENSE_PUBLIC_KEYS: PublicKeySet = {};
