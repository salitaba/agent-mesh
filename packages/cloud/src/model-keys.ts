/**
 * The model-provider key a customer brings for their workspace, and where it is kept.
 *
 * The service sells hosting, not model usage: on a `byok` plan the customer pays their own provider, and the workspace's host is
 * started with their key. This file is what keeps that key a secret of the workspace and of nothing else.
 *
 *   - It is write-only. The only reader is {@link ModelKeyStore.read}, which the workspaces use to start a host. No API, page, log
 *     line or event carries it, and the control log holds only which provider it is for, which model and where (`workspace.model_key_set`).
 *   - At rest it is encrypted (AES-256-GCM) in a file of its own that only the control plane's user can read (0600), with a key derived
 *     from the service's secret and bound to the workspace's id, so one workspace's entry cannot be moved onto another's. The file is
 *     replaced whole through a temporary file, never edited in place.
 *   - Its shape is checked before it is kept: a key is one line of printable characters, and an address a host will call is https, and
 *     not a name or an address on this machine or its network.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { isPublicAddress } from "../../runtime-native/src/tools/web";
import { ServiceError } from "./errors";
import type { ModelProviderKind } from "./store";

export const MODEL_PROVIDERS: readonly ModelProviderKind[] = ["anthropic", "openai-compatible"];

export interface ModelKeyInput {
  provider: ModelProviderKind;
  /** The model the workspace's teams run on, as the provider names it. Not a secret. */
  model: string;
  /** Where an openai-compatible provider is called, up to and including its version segment. Required for that kind. */
  baseUrl?: string;
  key: string;
}

/** What a workspace's host is given. The only place the key is next to the rest. */
export interface ModelKey extends ModelKeyInput {}

const KEY_MIN = 8;
const KEY_MAX = 512;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
/** A host name that is on this machine or its own network whatever it resolves to, or has no dot and so cannot be public. */
const LOCAL_NAME = /(^|\.)(localhost|local|internal|lan|home|corp|intranet|localdomain)$/i;

/** The address an openai-compatible provider is called at, or what is wrong with it. https only, and nothing on this machine or its network. */
export function checkBaseUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") throw new ServiceError(400, "invalid_base_url", "Give the provider's address, like https://openrouter.ai/api/v1.");
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ServiceError(400, "invalid_base_url", "That is not an address. Give it in full, like https://openrouter.ai/api/v1.");
  }
  if (url.protocol !== "https:") throw new ServiceError(400, "invalid_base_url", "The provider's address must start with https://, so your key is not sent in the clear.");
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") throw new ServiceError(400, "invalid_base_url", "The provider's address must have no sign-in, query or fragment in it.");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const literal = net.isIP(host) !== 0;
  if (literal ? !isPublicAddress(host) : !host.includes(".") || LOCAL_NAME.test(host) || /^\d+$/.test(host.split(".").pop() ?? "")) {
    throw new ServiceError(400, "invalid_base_url", "That address is on this machine or a private network. Give your provider's public https address.");
  }
  if (url.pathname.length > 200) throw new ServiceError(400, "invalid_base_url", "That address is too long.");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** A customer's input, checked and cleaned. Says what is wrong in words they can act on, and never repeats the key. */
export function checkModelKeyInput(body: Record<string, unknown>): ModelKeyInput {
  const provider = body.provider;
  if (provider !== "anthropic" && provider !== "openai-compatible") throw new ServiceError(400, "invalid_provider", "Choose a provider: anthropic, or openai-compatible (OpenRouter, OpenAI, DeepSeek, Gemini's compatible endpoint and others).");
  const key = typeof body.key === "string" ? body.key.trim() : "";
  if (key.length < KEY_MIN || key.length > KEY_MAX || /[^\x21-\x7e]/.test(key)) throw new ServiceError(400, "invalid_key", `A model key is ${KEY_MIN} to ${KEY_MAX} printable characters on one line, with no spaces.`);
  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (!MODEL.test(model)) throw new ServiceError(400, "invalid_model", "Name the model your teams should run on, as your provider names it, like claude-sonnet-4-5 or openai/gpt-4o.");
  if (provider === "anthropic") {
    // Anthropic is called at its own address. Another one here would be a way to send the key somewhere else.
    if (body.baseUrl !== undefined && body.baseUrl !== null && body.baseUrl !== "") throw new ServiceError(400, "invalid_base_url", "Anthropic is called at its own address: leave the address out.");
    return { provider, model, key };
  }
  return { provider, model, baseUrl: checkBaseUrl(body.baseUrl), key };
}

interface Sealed {
  provider: ModelProviderKind;
  model: string;
  baseUrl?: string;
  iv: string;
  tag: string;
  ct: string;
  setAt: string;
}

interface FileShape {
  v: 1;
  keys: Record<string, Sealed>;
}

export interface ModelKeyStoreOptions {
  file: string;
  /** The service's secret. The key that seals entries is derived from it, so a copy of the file alone opens nothing. */
  secret: string;
  clock?: () => Date;
}

export class ModelKeyStore {
  private readonly clock: () => Date;
  private readonly sealKey: Buffer;
  private data: FileShape;
  /** Changes are made one at a time: two that read the same file would lose one of them. */
  private writing: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: ModelKeyStoreOptions) {
    if (o.secret.length < 32) throw new Error("the service secret must be at least 32 characters");
    this.clock = o.clock ?? (() => new Date());
    this.sealKey = Buffer.from(hkdfSync("sha256", o.secret, "curule-model-keys", "model key at rest v1", 32));
    this.data = this.load();
  }

  private load(): FileShape {
    let text: string;
    try {
      text = fs.readFileSync(this.o.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { v: 1, keys: {} };
      throw new Error(`cannot read the model keys file ${this.o.file}: ${(err as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`the model keys file ${this.o.file} is not valid JSON; it is not read, and it is not replaced`);
    }
    const shape = parsed as FileShape;
    if (shape === null || typeof shape !== "object" || shape.v !== 1 || shape.keys === null || typeof shape.keys !== "object") throw new Error(`the model keys file ${this.o.file} is not one this version wrote`);
    return shape;
  }

  private aad(workspaceId: string): Buffer {
    return Buffer.from(`workspace:${workspaceId}`);
  }

  /** Replace the file whole: written beside it with the owner's permission only, then renamed over it. */
  private persist(): Promise<void> {
    const turn = this.writing.then(() => {
      const dir = path.dirname(this.o.file);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.o.file}.${randomBytes(4).toString("hex")}.tmp`;
      try {
        fs.writeFileSync(tmp, `${JSON.stringify(this.data)}\n`, { mode: 0o600 });
        fs.renameSync(tmp, this.o.file);
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    });
    this.writing = turn.catch(() => undefined);
    return turn;
  }

  async set(workspaceId: string, input: ModelKeyInput): Promise<{ setAt: string }> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.sealKey, iv);
    cipher.setAAD(this.aad(workspaceId));
    const ct = Buffer.concat([cipher.update(input.key, "utf8"), cipher.final()]);
    const setAt = this.clock().toISOString();
    const before = this.data.keys[workspaceId];
    this.data.keys[workspaceId] = { provider: input.provider, model: input.model, ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ct: ct.toString("base64"), setAt };
    try {
      await this.persist();
    } catch (err) {
      if (before) this.data.keys[workspaceId] = before;
      else delete this.data.keys[workspaceId];
      throw err;
    }
    return { setAt };
  }

  /** The key, for starting the workspace's host. Nothing else calls this. */
  read(workspaceId: string): ModelKey | undefined {
    const e = this.data.keys[workspaceId];
    if (!e) return undefined;
    try {
      const d = createDecipheriv("aes-256-gcm", this.sealKey, Buffer.from(e.iv, "base64"));
      d.setAAD(this.aad(workspaceId));
      d.setAuthTag(Buffer.from(e.tag, "base64"));
      const key = Buffer.concat([d.update(Buffer.from(e.ct, "base64")), d.final()]).toString("utf8");
      return { provider: e.provider, model: e.model, ...(e.baseUrl ? { baseUrl: e.baseUrl } : {}), key };
    } catch {
      // Sealed with another secret, or altered. Said without the entry in it.
      throw new Error(`the model key kept for ${workspaceId} cannot be opened: it was sealed with a different service secret, or the file was changed`);
    }
  }

  has(workspaceId: string): boolean {
    return this.data.keys[workspaceId] !== undefined;
  }

  async remove(workspaceId: string): Promise<boolean> {
    const before = this.data.keys[workspaceId];
    if (!before) return false;
    delete this.data.keys[workspaceId];
    try {
      await this.persist();
    } catch (err) {
      this.data.keys[workspaceId] = before;
      throw err;
    }
    return true;
  }
}
