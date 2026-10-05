/**
 * The processes of the hosted service, behind one command.
 *
 *   curule-cloud gateway --config gateway.yaml [--check]
 *   curule-cloud control --config control.yaml [--check]
 *
 * `gateway` runs the model gateway: the one process that holds provider credentials and the ledger of what workspaces spend.
 * `control` runs the control plane: accounts, plans, payments and workspaces, the public site's API and the proxy that puts a
 * workspace behind its own address, and the operator's API. With `--check` either reads and validates its configuration,
 * prints what it would run, and exits without listening, so a change can be proved before it is deployed.
 */
import { formatMoney, loadGatewayConfig, startGateway, type GatewayConfig } from "../../../packages/ai-gateway/src/index";
import { describeControl, loadControlConfig, startControl } from "../../../packages/cloud/src/index";

export const USAGE = `Usage: curule-cloud <command>

Commands:
  gateway --config <gateway.yaml> [--check]   run the model gateway (--check validates the file and exits)
  control --config <control.yaml> [--check]   run the control plane: accounts, payments, workspaces, the public API and the owner API
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

/** `--config <file>` and `--check`, the same for every command. Undefined when what was given cannot be run, after saying why. */
function parseOptions(command: string, args: string[], io: Io): { file: string; check: boolean } | undefined {
  let file: string | undefined;
  let check = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--config") file = args[++i];
    else if (a.startsWith("--config=")) file = a.slice("--config=".length);
    else if (a === "--check") check = true;
    else {
      io.err(`curule-cloud ${command}: unknown option '${a}'\n${USAGE}`);
      return undefined;
    }
  }
  if (!file) {
    io.err(`curule-cloud ${command}: --config is required\n${USAGE}`);
    return undefined;
  }
  return { file, check };
}

/** Wait for a stop signal, then stop. Resolves with the exit code. */
function untilSignalled(command: string, io: Io, stop: () => Promise<void>, note: string): Promise<number> {
  return new Promise<number>((resolve) => {
    // The first signal takes both listeners away, so a second one finds none and does what the process does by default: ends it.
    const stopNow = (signal: string): void => {
      io.signals.off("SIGINT", onInt);
      io.signals.off("SIGTERM", onTerm);
      io.out(`${signal}: ${note}`);
      stop().then(
        () => resolve(0),
        (err: Error) => {
          io.err(`curule-cloud ${command}: stopping failed: ${err.message}`);
          resolve(1);
        },
      );
    };
    const onInt = (): void => stopNow("SIGINT");
    const onTerm = (): void => stopNow("SIGTERM");
    io.signals.once("SIGINT", onInt);
    io.signals.once("SIGTERM", onTerm);
  });
}

async function runGateway(args: string[], env: NodeJS.ProcessEnv, io: Io, start: typeof startGateway): Promise<number> {
  const options = parseOptions("gateway", args, io);
  if (!options) return 1;
  let config: GatewayConfig;
  try {
    config = loadGatewayConfig(options.file, env);
  } catch (err) {
    io.err((err as Error).message);
    return 1;
  }
  if (options.check) {
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
  return untilSignalled("gateway", io, () => running.stop(), "no longer taking calls; finishing the ones in flight");
}

async function runControl(args: string[], env: NodeJS.ProcessEnv, io: Io, start: typeof startControl): Promise<number> {
  const options = parseOptions("control", args, io);
  if (!options) return 1;
  let config: ReturnType<typeof loadControlConfig>;
  try {
    config = loadControlConfig(options.file, env);
  } catch (err) {
    io.err((err as Error).message);
    return 1;
  }
  if (options.check) {
    for (const line of describeControl(config)) io.out(line);
    io.out("the configuration is valid");
    return 0;
  }
  for (const warning of config.warnings) io.err(`WARNING: ${warning}`);
  let running;
  try {
    running = await start(config);
  } catch (err) {
    io.err(`curule-cloud control: ${(err as Error).message}`);
    return 1;
  }
  return untilSignalled("control", io, () => running.stop(), "no longer taking requests; finishing the ones in flight");
}

/** `start` and `startControlPlane` are what bring each process up; a test supplies its own to prove what happens when stopping fails. */
export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  io: Io = processIo,
  start: typeof startGateway = startGateway,
  startControlPlane: typeof startControl = startControl,
): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "gateway":
      return runGateway(rest, env, io, start);
    case "control":
      return runControl(rest, env, io, startControlPlane);
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
