/**
 * The licence a hosted workspace runs with.
 *
 * A workspace is an ordinary Curule host. What limits it is the same signed licence a self-hosted customer holds, minted for
 * the plan and verified offline by the workspace with the public key in the build. The operator holds the signing key; the
 * control plane is the only thing that uses it. Payment is enforced by the control plane stopping the workspace, not by the
 * licence running out, so a licence is valid for a long time and is replaced when the plan changes.
 */
import type { KeyObject } from "node:crypto";
import { signLicense, type LicenseClaims, type PlanId } from "../../licensing/src/index";

export interface LicenceSigner {
  kid: string;
  privateKey: string | KeyObject;
}

export interface MintInput {
  signer: LicenceSigner;
  plan: PlanId;
  accountId: string;
  workspaceId: string;
  now: Date;
  /** Days the licence is valid for. Default 400. */
  validDays?: number;
  notes?: string;
}

export function mintWorkspaceLicence(input: MintInput): { token: string; claims: LicenseClaims } {
  const days = input.validDays ?? 400;
  const claims: LicenseClaims = {
    v: 1,
    id: `lic_${input.workspaceId}_${input.now.getTime().toString(36)}`,
    customer: input.accountId,
    plan: input.plan,
    issuedAt: input.now.toISOString(),
    expiresAt: new Date(input.now.getTime() + days * 86_400_000).toISOString(),
    notes: input.notes ?? `hosted workspace ${input.workspaceId}`,
  };
  return { token: signLicense(claims, input.signer.kid, input.signer.privateKey), claims };
}
