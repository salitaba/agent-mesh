/** A refusal the control plane can explain to the person who asked: a status, a code to match on, and words. */
export class ServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "ServiceError";
  }
}
