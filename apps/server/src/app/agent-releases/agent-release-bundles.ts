import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AgentApp,
  isReleasedAgentVersion,
  parseAgentVersion,
  type AgentRelease,
  type AgentReleaseFile,
  type AgentReleaseManifest,
} from '@tempestas/domain';

export const MANIFEST_FILE = 'manifest.json';
export const BUNDLE_FILES_DIRECTORY = 'files';
const SHA256_HEX = /^[0-9a-f]{64}$/;
// tools/deploy.sh ships a bundle under a dot-name and renames it into place once complete.
const PARTIAL_BUNDLE_PREFIX = '.';
const AGENT_APPS = new Set<unknown>(Object.values(AgentApp));

/** A verified bundle: every file its manifest lists is there, with the hash the manifest gives. */
export interface AgentReleaseBundle {
  release: AgentRelease;
  manifestFile: string;
  /** Each listed path, to the file on disk; nothing else in the bundle is ever served. */
  filesByPath: Map<string, string>;
}

export type ReportRejectedBundle = (
  bundleDirectory: string,
  reason: string,
) => void;

/** `<root>/<app>/<version>/{manifest.json,files/…}`; a bundle that does not verify is left out and reported. */
export async function readVerifiedBundles(
  root: string,
  reportRejected: ReportRejectedBundle,
): Promise<AgentReleaseBundle[]> {
  const bundles: AgentReleaseBundle[] = [];
  for (const app of await listDirectories(root)) {
    for (const version of await listDirectories(join(root, app))) {
      const bundleDirectory = join(root, app, version);
      try {
        bundles.push(await readVerifiedBundle(bundleDirectory, app, version));
      } catch (rejection) {
        reportRejected(bundleDirectory, String((rejection as Error).message));
      }
    }
  }
  return bundles;
}

async function readVerifiedBundle(
  bundleDirectory: string,
  app: string,
  version: string,
): Promise<AgentReleaseBundle> {
  const manifestFile = join(bundleDirectory, MANIFEST_FILE);
  const manifestBytes = await readFile(manifestFile);
  const manifest = parseManifest(manifestBytes.toString('utf8'));
  const problem = describeManifestProblem(manifest, app, version);
  if (problem) {
    throw new Error(problem);
  }
  const filesByPath = await verifyListedFiles(bundleDirectory, manifest.files);
  return {
    release: {
      app: manifest.app,
      version: manifest.version,
      contractMajor: manifest.contractMajor,
      contractMinor: manifest.contractMinor,
      manifestPath: `/api/agent-releases/${manifest.app}/${manifest.version}/${MANIFEST_FILE}`,
      manifestSha256: hashBytes(manifestBytes),
    },
    manifestFile,
    filesByPath,
  };
}

function parseManifest(text: string): AgentReleaseManifest {
  try {
    return JSON.parse(text) as AgentReleaseManifest;
  } catch {
    throw new Error(`${MANIFEST_FILE} is not JSON`);
  }
}

/** Null when the manifest is whole and agrees with the directory it sits in. */
export function describeManifestProblem(
  manifest: AgentReleaseManifest,
  app: string,
  version: string,
): string | null {
  if (!AGENT_APPS.has(manifest.app) || manifest.app !== app) {
    return `manifest app ${JSON.stringify(manifest.app)} is not the directory's ${app}`;
  }
  if (
    !isReleasedAgentVersion(manifest.version) ||
    manifest.version !== version
  ) {
    return `manifest version ${JSON.stringify(manifest.version)} is not the directory's ${version}`;
  }
  const numbers = parseAgentVersion(manifest.version);
  if (
    numbers?.major !== manifest.contractMajor ||
    numbers.minor !== manifest.contractMinor
  ) {
    return `contract ${manifest.contractMajor}.${manifest.contractMinor} does not match version ${manifest.version}`;
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    return 'manifest lists no files';
  }
  const unsafeFile = manifest.files.find(
    (file) => !isListedFileWellFormed(file),
  );
  if (unsafeFile) {
    return `manifest lists ${JSON.stringify(unsafeFile)}, which is not a safe path with a sha256`;
  }
  if (
    new Set(manifest.files.map((file) => file.path)).size !==
    manifest.files.length
  ) {
    return 'manifest lists a path twice';
  }
  return null;
}

function isListedFileWellFormed(file: AgentReleaseFile): boolean {
  return (
    typeof file?.sha256 === 'string' &&
    SHA256_HEX.test(file.sha256) &&
    isSafeRelativePath(file.path)
  );
}

// Served by name from a URL, so a path must stay inside the bundle.
function isSafeRelativePath(path: unknown): path is string {
  if (typeof path !== 'string' || path.includes('\\')) {
    return false;
  }
  const segments = path.split('/');
  return segments.every(
    (segment) => segment !== '' && segment !== '.' && segment !== '..',
  );
}

async function verifyListedFiles(
  bundleDirectory: string,
  files: AgentReleaseFile[],
): Promise<Map<string, string>> {
  const filesByPath = new Map<string, string>();
  for (const file of files) {
    const onDisk = join(bundleDirectory, BUNDLE_FILES_DIRECTORY, file.path);
    const actualSha256 = hashBytes(await readListedFile(onDisk, file.path));
    if (actualSha256 !== file.sha256) {
      throw new Error(
        `${file.path} does not have the sha256 the manifest gives`,
      );
    }
    filesByPath.set(file.path, onDisk);
  }
  return filesByPath;
}

async function readListedFile(onDisk: string, path: string): Promise<Buffer> {
  try {
    return await readFile(onDisk);
  } catch {
    throw new Error(`${path} is listed but missing`);
  }
}

async function listDirectories(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  );
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith(PARTIAL_BUNDLE_PREFIX));
}

function hashBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
