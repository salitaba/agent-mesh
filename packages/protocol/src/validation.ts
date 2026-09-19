import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { ValidateFunction } from "ajv";
import { ARTIFACT_TYPES } from "./catalog";
import { SCHEMAS, type SchemaName } from "./schemas";
import type { Contract } from "./contracts";

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

const validators = new Map<SchemaName, ValidateFunction>();
for (const name of Object.keys(SCHEMAS) as SchemaName[]) {
  validators.set(name, ajv.compile(SCHEMAS[name] as object));
}

export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

const ARTIFACT_TYPE_SET: ReadonlySet<string> = new Set(ARTIFACT_TYPES);

/** The fields that carry an artifact's own content (its name, or the prose it holds). */
const ARTIFACT_CONTENT_FIELDS: readonly string[] = ["name", "content", "contentRef"];

/** The publish input an agent sends, shape of MeshOpPublishArtifact. */
const ARTIFACT_PUBLISH_FIELDS: readonly string[] = ["name", "type", "content"];

function isBlank(value: unknown): boolean {
  return typeof value === "string" && value.trim().length === 0;
}

function fmt(err: { instancePath?: string; message?: string }): ValidationError {
  return { path: err.instancePath || "(root)", message: err.message || "invalid" };
}

export function validateSchema(name: SchemaName, value: unknown): ValidationResult {
  const v = validators.get(name);
  if (!v) throw new Error(`Unknown schema: ${name}`);
  const ok = v(value);
  return {
    valid: ok === true,
    errors: ok ? [] : (v.errors || []).map(fmt),
  };
}

export function validateMessage(message: unknown): ValidationResult {
  return validateSchema("message", message);
}

export function validateEvent(event: unknown): ValidationResult {
  return validateSchema("event", event);
}

/**
 * Validate an artifact at the protocol edge.
 *
 * Two shapes reach the kernel: the stored record (the `Artifact` type, and
 * `artifactSchema` with it) and the publish input an agent sends
 * (`MeshOpPublishArtifact`: name, type, content). Both are model-written, and
 * an artifact holding nothing is one no reviewer can review and no store can
 * version — an empty string passes a `type: "string"` check and only turns
 * into an empty card on the operator's screen, so blank values are rejected
 * here instead.
 */
export function validateArtifact(artifact: unknown): ValidationResult {
  if (artifact === null || typeof artifact !== "object" || Array.isArray(artifact)) {
    return { valid: false, errors: [{ path: "(root)", message: "artifact must be an object" }] };
  }
  const record = artifact as Record<string, unknown>;
  const isStoredRecord = "id" in record || "version" in record || "createdAt" in record;
  const errors: ValidationError[] = isStoredRecord
    ? [...validateSchema("artifact", artifact).errors]
    : ARTIFACT_PUBLISH_FIELDS.filter((field) => !(field in record)).map((field) => ({
        path: `/${field}`,
        message: "missing required field",
      }));
  const flagged = new Set(errors.map((e) => e.path));
  for (const field of ARTIFACT_CONTENT_FIELDS) {
    if (isBlank(record[field]) && !flagged.has(`/${field}`)) {
      errors.push({ path: `/${field}`, message: "must not be empty or whitespace-only" });
    }
  }
  if ("type" in record) {
    const typeError =
      typeof record.type !== "string"
        ? { path: "/type", message: "must be a string" }
        : ARTIFACT_TYPE_SET.has(record.type)
          ? undefined
          : {
              path: "/type",
              message: `unknown artifact type '${record.type}' (expected one of: ${ARTIFACT_TYPES.join(", ")})`,
            };
    if (typeError) {
      // Replace the schema's generic enum complaint with the same message the
      // supervisor's publish gate gives, so both name the offending type.
      const at = errors.findIndex((e) => e.path === "/type");
      if (at === -1) errors.push(typeError);
      else errors[at] = typeError;
    }
  }
  return { valid: errors.length === 0, errors };
}

export function validateMeshConfig(config: unknown): ValidationResult {
  return validateSchema("mesh", config);
}

/**
 * Validate a `mesh.call` request body against its contract's schema.
 *
 * Compiled lazily and cached per contract name+version: a contract's schema is
 * immutable, so the cache cannot go stale, and the alternative — compiling on
 * every call — would put an Ajv compile in the hot path of every ask.
 *
 * This is the edge the whole stage is built on. Without it a contract is just
 * a nicer-sounding type string, and the failure mode it exists to stop — an
 * ask that is well-formed on the wire and meaningless to the reader — survives
 * intact.
 */
const contractValidators = new Map<string, ValidateFunction>();

export function validateContractRequest(contract: Contract, request: unknown): ValidationResult {
  const key = `${contract.name}@${contract.version}`;
  let v = contractValidators.get(key);
  if (!v) {
    v = ajv.compile(contract.request as object);
    contractValidators.set(key, v);
  }
  // An object schema with required fields must not be handed `undefined`: Ajv
  // reports that as a bare type error naming no field, which tells the seat
  // nothing about what it left out.
  const ok = v(request ?? {});
  return { valid: ok === true, errors: ok ? [] : (v.errors || []).map(fmt) };
}
