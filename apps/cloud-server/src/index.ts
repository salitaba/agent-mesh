/**
 * The processes of the hosted service, behind one command.
 *
 *   curule-cloud gateway --config gateway.yaml [--check]
 *
 * `gateway` runs the model gateway: the one process that holds provider credentials and the ledger of what workspaces spend.
 * With `--check` it reads and validates the configuration, prints what it would run, and exits without listening, so a change
 * can be proved before it is deployed.
 */
import { formatMoney, loadGatewayConfig, startGateway, type GatewayConfig } from "../../../packages/ai-gateway/src/index";

export const USAGE = `Usage: curule-cloud <command>

Commands:
  gateway --config <gateway.yaml> [--check]   run the model gateway (--check validates the file and exits)
  help                                         show this text`;

export interface Io {
  out(line: string): void;
  err(line: string): void;
  /** Where stop signals come from: the process, or a test's own emitter. */
  signals: {
    once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
    off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  };
}

const processIo: Io = { out: (l) => console.log(l), err: (l) => console.error(l), signals: process };

/** What the gateway would run, for a person to check against what they meant. Nothing secret: no key, no token. */
export function describeGateway(config: GatewayConfig): string[] {
  const money = (micros: number): string => formatMoney(micros, config.prices.currency);
  const lines = [
    `currency ${config.prices.currency}, prices ${config.prices.version}`,
    `ledger ${config.ledgerPath}`,
    `workspaces connect on ${config.tenant.host}:${config.tenant.port}; the admin API is on ${config.admin.host}:${config.admin.port}`,
    `limits: ${config.limits.defaultRpm} calls a minute and ${config.limits.defaultConcurrent} open at once per key by default; one call holds back at most ${money(config.limits.reserveCapMicros)}; ${config.limits.deadlineMs / 1000}s deadline`,
    `the model that answered is ${config.exposeUpstreamModel ? "shown to callers" : "hidden from callers"}`,
    "providers:",
  ];
  for (const [name, spec] of config.providers) {
    let host = spec.baseUrl ?? "(the provider's default address)";
    try {
      if (spec.baseUrl) host = new URL(spec.baseUrl).host;
    } catch {
      // The loader has already refused a base_url that is not a URL.
    }
    lines.push(`  ${name}: ${spec.kind} at ${host}, ${spec.apiKeyEnv ? `key from ${spec.apiKeyEnv}` : "no key"}`);
  }
  lines.push("tiers:");
  for (const tier of config.tiers) {
    lines.push(`  ${tier.name}:`);
    for (const [i, c] of tier.candidates.entries()) {
      const p = config.prices.get(c.id)!;
      const per = (rate: number): string => formatMoney(rate, config.prices.currency);
      lines.push(`    ${i === 0 ? "first" : "then "} ${c.id}: ${per(p.rates.input)} in, ${per(p.rates.output)} out per million tokens at cost, charged at ${p.markupBps / 10_000}x; answers up to ${c.maxOutputTokens} tokens`);
    }
  }
  return lines;
}

async function runGateway(args: string[], env: NodeJS.ProcessEnv, io: Io, start: typeof startGateway): Promise<number> {
  let file: string | undefined;
  let check = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--config") file = args[++i];
    else if (a.startsWith("--config=")) file = a.slice("--config=".length);
    else if (a === "--check") check = true;
    else {
      io.err(`curule-cloud gateway: unknown option '${a}'\n${USAGE}`);
      return 1;
    }
  }
  if (!file) {
    io.err(`curule-cloud gateway: --config is required\n${USAGE}`);
    return 1;
  }
  let config: GatewayConfig;
  try {
    config = loadGatewayConfig(file, env);
  } catch (err) {
    io.err((err as Error).message);
    return 1;
  }
  if (check) {
    for (const line of describeGateway(config)) io.out(line);
    io.out("the configuration is valid");
    return 0;
  }
  let running;
  try {
    running = await start(config);
  } catch (err) {
    io.err(`curule-cloud gateway: ${(err as Error).message}`);
    return 1;
  }
  return new Promise<number>((resolve) => {
    // The first signal takes both listeners away, so a second one finds none and does what the process does by default: ends it.
    const stop = (signal: string): void => {
      io.signals.off("SIGINT", onInt);
      io.signals.off("SIGTERM", onTerm);
      io.out(`${signal}: no longer taking calls; finishing the ones in flight`);
      running.stop().then(
        () => resolve(0),
        (err: Error) => {
          io.err(`curule-cloud gateway: stopping failed: ${err.message}`);
          resolve(1);
        },
      );
    };
    const onInt = (): void => stop("SIGINT");
    const onTerm = (): void => stop("SIGTERM");
    io.signals.once("SIGINT", onInt);
    io.signals.once("SIGTERM", onTerm);
  });
}

/** `start` is what brings the gateway up; a test supplies its own to prove what happens when stopping fails. */
export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env, io: Io = processIo, start: typeof startGateway = startGateway): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "gateway":
      return runGateway(rest, env, io, start);
    case "help":
    case "--help":
    case "-h":
      io.out(USAGE);
      return 0;
    case undefined:
      io.err(USAGE);
      return 1;
    default:
      io.err(`curule-cloud: unknown command '${command}'\n${USAGE}`);
      return 1;
  }
}
