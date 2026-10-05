/**
 * Mail the control plane sends: a verification link, a notice that a payment failed, a notice that a workspace was stopped.
 *
 * The control plane speaks to a `Mailer` and does not know how mail is delivered. Which mail service the operator uses is the
 * operator's choice. `OutboxMailer` sends nothing: it writes each message to a file, one JSON object per line, for whoever runs
 * the service to deliver or to read while trying it. `SmtpTransport` (smtp.ts) delivers to any provider that offers SMTP, and
 * `QueuedMailer` (mail-queue.ts) is what the control plane puts in front of it: the message is kept on disk first, so a
 * provider that is down, a restart or a crash does not lose a confirmation link.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  /** What the mail is for, so a delivery script can template it: `verify`, `reset`, `payment-failed`, ... */
  kind: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/**
 * What a mail transport throws when it could not deliver. It says what is worth doing next, so the queue in front of it does
 * not have to know which service is behind: a message the service will never take is set aside; trouble in reaching the
 * service holds back every message and not only this one; anything else is this message's to try again.
 */
export class DeliveryError extends Error {
  constructor(
    message: string,
    /** The service refused this message and would refuse it again: it is not tried a second time. */
    readonly permanent: boolean,
    /** The trouble is with reaching or using the service (it is down, the sign-in failed, the sender is refused), not with this message. */
    readonly transport: boolean,
  ) {
    super(message);
    this.name = "DeliveryError";
  }
}

export class MemoryMailer implements Mailer {
  readonly sent: Mail[] = [];
  async send(mail: Mail): Promise<void> {
    this.sent.push(mail);
  }
}

export class OutboxMailer implements Mailer {
  constructor(
    private readonly file: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async send(mail: Mail): Promise<void> {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    await fs.promises.appendFile(this.file, `${JSON.stringify({ at: this.now().toISOString(), ...mail })}\n`, { mode: 0o600 });
  }
}
