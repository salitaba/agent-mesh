/**
 * Loaded (`node --require`, from `NODE_OPTIONS`) into the hosts of a hosting-only trial, so that the one provider address the trial
 * gives out is answered on this machine.
 *
 * A customer's model key is for a provider at a public https address: the control plane refuses any other when the key is set, and the
 * host refuses it again when it is started with one. So a stand-in model on `http://127.0.0.1` cannot be named in the key form. The trial
 * names an address that no one can own instead (`stand-in.example`: `.example` is reserved and never resolves), and this file sends the
 * calls made to it to the stand-in's real address. Nothing else is touched: a call to any other address goes where it was going, so a real
 * provider's address and key work in a trial as they do anywhere.
 *
 * It is the trial's, it is only ever put in the environment of a trial's hosts, and it does nothing unless it is told both addresses.
 */

type Input = Parameters<typeof fetch>[0];

/** `real`, except that a call to an address that starts with `from` goes to the same path after `to`. */
export function rerouteFetch(real: typeof fetch, from: string, to: string): typeof fetch {
  const there = (url: string): string => (url.startsWith(from) ? `${to}${url.slice(from.length)}` : url);
  return (input: Input, init?: RequestInit) => {
    if (typeof input === "string") return real(there(input), init);
    if (input instanceof URL) return real(there(input.href), init);
    const moved = there(input.url);
    return moved === input.url ? real(input, init) : real(new Request(moved, input), init);
  };
}

const from = process.env.CURULE_TRIAL_REROUTE_FROM;
const to = process.env.CURULE_TRIAL_REROUTE_TO;
if (from && to && typeof globalThis.fetch === "function") globalThis.fetch = rerouteFetch(globalThis.fetch.bind(globalThis), from, to);
