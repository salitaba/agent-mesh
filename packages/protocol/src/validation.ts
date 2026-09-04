import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { ValidateFunction } from "ajv";
import { SCHEMAS, type SchemaName } from "./schemas";

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

export function validateArtifact(artifact: unknown): ValidationResult {
  return validateSchema("artifact", artifact);
}

export function validateMeshConfig(config: unknown): ValidationResult {
  return validateSchema("mesh", config);
}
