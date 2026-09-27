import { mulberry32 } from "../policy/_rng";

/**
 * Seeds for a randomized test: the fixed seeds it has always run (so a
 * regression on a known trail stays caught), plus one more — `MESH_SEED` when
 * set, else a fresh random seed. A suite that only ever replays the same four
 * trails explores four trails; the fresh seed is how it explores more, and the
 * seed in every failure message is how a red run is reproduced:
 *
 *   MESH_SEED=<seed> node --test dist/tests/policy/properties.test.js
 */
export function propertySeeds(fixed: number[], env: NodeJS.ProcessEnv = process.env): number[] {
  const raw = env.MESH_SEED;
  const extra = raw !== undefined && raw !== "" ? Number(raw) >>> 0 : Math.floor(Math.random() * 2 ** 32) >>> 0;
  return fixed.includes(extra) ? [...fixed] : [...fixed, extra];
}

/** Prefix any failure with the seed that produced it and how to replay it. */
function tagged(err: unknown, seed: number): unknown {
  if (err instanceof Error) {
    err.message = `[seed ${seed}; rerun with MESH_SEED=${seed}] ${err.message}`;
  }
  return err;
}

/** Run `body` once per seed with a seeded rng, tagging failures with the seed. */
export async function forEachSeed(fixed: number[], body: (rng: () => number, seed: number) => void | Promise<void>): Promise<void> {
  for (const seed of propertySeeds(fixed)) {
    try {
      await body(mulberry32(seed), seed);
    } catch (err) {
      throw tagged(err, seed);
    }
  }
}
