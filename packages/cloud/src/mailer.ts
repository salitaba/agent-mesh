/**
 * Mail the control plane sends: a verification link, a notice that a payment failed, a notice that a workspace was stopped.
 *
 * The control plane speaks to a `Mailer` and does not know how mail is delivered. Which mail service the operator uses is the
 * operator's choice, so the one that ships does not send anything: `OutboxMailer` writes each message to a file, one JSON
 * object per line, for whoever runs the service to deliver or to read while trying it. An adapter for a real mail service is
 * a few lines behind this interface and is an owner action; until it exists, links in mail are read from the outbox.
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
