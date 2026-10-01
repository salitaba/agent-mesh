/**
 * The licence, as the console shows it: a card on Host settings that says what this install is entitled to
 * and how much of it is in use, and a banner above every view when something needs doing about it.
 *
 * Read-only on purpose. A licence is installed with `mesh license install` on the machine that runs the host,
 * where the file is written owner-only; a web form that wrote it would be a second, weaker way to do the same
 * thing. The banner is quiet for a healthy licence and for no licence at all: Community is a plan, not an error.
 */
import React, { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Button, Card, Chip } from "./components";

export interface LicenseView {
  status: "community" | "valid" | "grace" | "expired" | "invalid";
  plan: string;
  licensedPlan?: string;
  customer?: string;
  expiresAt?: string;
  graceEndsAt?: string;
  limits: { maxSeatsPerMesh: number | null; maxProjects: number | null; maxConcurrentTurns: number | null };
  features: string[];
  enforcement: "off" | "warn" | "enforce";
  summary: string;
  warnings: string[];
  source?: string;
  usage: Record<string, number>;
}

const REFRESH_MS = 5 * 60 * 1000;

/** The host's licence. `null` until it has answered, and after a server that has no such route (an older build). */
export function useLicense(): { license: LicenseView | null; reload: () => void } {
  const [license, setLicense] = useState<LicenseView | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let dead = false;
    void (async () => {
      const res = await api("GET", "/api/license");
      if (dead) return;
      setLicense(res.status === 200 && res.json ? (res.json as LicenseView) : null);
    })();
    const timer = window.setTimeout(() => setTick((t) => t + 1), REFRESH_MS);
    return () => {
      dead = true;
      window.clearTimeout(timer);
    };
  }, [tick]);
  return { license, reload: useCallback(() => setTick((t) => t + 1), []) };
}

const limitText = (n: number | null): string => (n === null ? "unlimited" : String(n));

/** What is in use against what the plan allows, for the limits that have a number. */
function overLimits(l: LicenseView): string[] {
  const out: string[] = [];
  // The plan limits projects OPEN at once; registering more is free, so the registered count is not what is compared.
  const open = l.usage.open;
  if (l.limits.maxProjects !== null && typeof open === "number" && open > l.limits.maxProjects) {
    out.push(`${open} projects are open; the ${l.plan} plan allows ${l.limits.maxProjects} at once`);
  }
  return out;
}

/** Above the views. Silent unless the licence is expiring, lapsed, unreadable, or the install is over a limit. */
export function LicenseBanner({ onOpen }: { onOpen: () => void }): React.JSX.Element | null {
  const { license } = useLicense();
  if (!license || license.enforcement === "off") return null;
  const problems = [...license.warnings, ...overLimits(license)];
  const bad = license.status === "expired" || license.status === "invalid";
  if (problems.length === 0 && !bad) return null;
  return (
    <div className={`banner ${bad ? "bad" : "warn"} server-banner`} role="status" id="license-banner">
      <b>{bad ? "Licence problem." : "Licence."}</b> <span className="muted">{problems.length ? problems.join(" · ") : license.summary}</span>
      <Button variant="banner-act" onClick={onOpen}>Details</Button>
    </div>
  );
}

const ENFORCEMENT_TEXT: Record<LicenseView["enforcement"], string> = {
  off: "nothing is checked",
  warn: "a breach is reported and nothing is refused",
  enforce: "what the plan does not allow will not start; nothing running is stopped",
};

export function LicenseCard(): React.JSX.Element | null {
  const { license, reload } = useLicense();
  if (!license) return null;
  const projects = license.usage.registered;
  const open = license.usage.open;
  return (
    <Card
      title="Licence"
      actions={
        <Button variant="small" onClick={reload} title="Read the licence again">
          Refresh
        </Button>
      }
    >
      <p>{license.summary}</p>
      <div className="page-actions">
        <Chip hot={license.status === "valid"} warn={license.status !== "valid" && license.status !== "community"} title="Whether the licence verifies and has not lapsed">
          {license.status === "community" ? "no licence · Community" : `${license.status} · ${license.plan}`}
        </Chip>
        <Chip warn={license.enforcement === "enforce"} title={`MESH_LICENSE_ENFORCEMENT=${license.enforcement}: ${ENFORCEMENT_TEXT[license.enforcement]}`}>
          enforcement: {license.enforcement}
        </Chip>
        {license.source ? <Chip mono title="Where the licence was found">{license.source}</Chip> : null}
      </div>
      <p className="muted">
        Seats per mesh: <b>{limitText(license.limits.maxSeatsPerMesh)}</b> · Projects: <b>{limitText(license.limits.maxProjects)}</b>
        {typeof projects === "number" ? ` (${projects} registered${typeof open === "number" ? `, ${open} open` : ""})` : ""} · Concurrent turns:{" "}
        <b>{limitText(license.limits.maxConcurrentTurns)}</b>
      </p>
      <p className="muted">
        Enforcement is <code>{license.enforcement}</code>: {ENFORCEMENT_TEXT[license.enforcement]}.
        {license.features.length ? ` Features: ${license.features.join(", ")}.` : ""}
      </p>
      {license.warnings.map((w) => (
        <div key={w} className="banner warn" role="status">
          {w}
        </div>
      ))}
      <p className="muted">
        Install or replace a licence on the machine that runs the host: <code>mesh license install &lt;key&gt;</code>. The host picks it up
        within 30 seconds; nothing here is sent anywhere.
      </p>
    </Card>
  );
}
