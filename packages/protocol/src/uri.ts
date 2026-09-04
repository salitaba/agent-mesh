import type { ArtifactRef } from "./types";

export function artifactUri(kind: string, name: string, version: number): string {
  return `artifact://${kind}/${encodeURIComponent(name)}/${version}`;
}

export function parseArtifactUri(uri: string): { kind: string; name: string; version?: number } | null {
  const m = /^artifact:\/\/([^/]+)\/([^/]+)(?:\/(\d+))?$/.exec(uri);
  if (!m) return null;
  return {
    kind: m[1],
    name: decodeURIComponent(m[2]),
    version: m[3] !== undefined ? Number(m[3]) : undefined,
  };
}

export function refToString(ref: ArtifactRef): string {
  if (ref.version !== undefined) {
    const parsed = parseArtifactUri(ref.uri);
    if (parsed) return artifactUri(parsed.kind, parsed.name, ref.version);
  }
  return ref.uri;
}

export function refEq(a: ArtifactRef, b: ArtifactRef): boolean {
  if (a.version !== undefined && b.version !== undefined) {
    return a.uri === b.uri && a.version === b.version;
  }
  return a.uri === b.uri;
}
