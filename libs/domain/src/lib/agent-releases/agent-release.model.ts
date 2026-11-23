import type { AgentApp } from '../hardware/mqtt-contract';

const AGENT_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.+-]+)?$/;
const RELEASED_AGENT_VERSION = /^\d+\.\d+\.\d+$/;
export const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface AgentVersionNumbers {
  major: number;
  minor: number;
  patch: number;
}

export interface AgentReleaseFile {
  /** Relative to the agent's install root, with `/` separators. */
  path: string;
  sha256: string;
}

/** `manifest.json` in a release bundle, written by tools/deploy.sh. */
export interface AgentReleaseManifest {
  app: AgentApp;
  version: string;
  contractMajor: number;
  contractMinor: number;
  files: AgentReleaseFile[];
}

export interface AgentRelease {
  app: AgentApp;
  version: string;
  contractMajor: number;
  contractMinor: number;
  /** Under the server's origin, so a node needs only the server's address. */
  manifestPath: string;
  /** Of the manifest's bytes, as an `update` command pins it. */
  manifestSha256: string;
}

/** Null for anything but `major.minor.patch`, with or without a `-dev` suffix. */
export function parseAgentVersion(version: string): AgentVersionNumbers | null {
  const match = AGENT_VERSION.exec(version);
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/** Only a clean origin/main build is released; a `-dev` one is never bundled. */
export function isReleasedAgentVersion(version: string): boolean {
  return RELEASED_AGENT_VERSION.test(version);
}

// A -dev build's patch also counts its own branch's commits, so its numbers cannot say whether a release is newer.
export function shouldOfferAgentRelease(
  release: AgentVersionNumbers,
  runningVersion: string,
): boolean {
  const running = parseAgentVersion(runningVersion);
  if (!running) {
    return false;
  }
  return (
    !isReleasedAgentVersion(runningVersion) ||
    isNewerAgentVersion(release, running)
  );
}

/** By number, so 1.0.10 is newer than 1.0.9. */
export function isNewerAgentVersion(
  candidate: AgentVersionNumbers,
  running: AgentVersionNumbers,
): boolean {
  return compareAgentVersions(candidate, running) > 0;
}

export function compareAgentVersions(
  first: AgentVersionNumbers,
  second: AgentVersionNumbers,
): number {
  return (
    first.major - second.major ||
    first.minor - second.minor ||
    first.patch - second.patch
  );
}
