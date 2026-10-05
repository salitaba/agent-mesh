/**
 * A refusal the control plane can explain to the person who asked: a status, a code to match on, and words. When the reason is
 * on our side (a provider that did not answer) the words are the customer's and the `cause` is the operator's: it goes in the
 * log and nowhere else.
 */
export class ServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ServiceError";
  }
}

/** What went wrong, as one line for a log. */
export function describeError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
