import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isAgentApp,
  isReleasedAgentVersion,
  parseAgentVersion,
  SHA256_HEX,
  type AgentRelease,
  type AgentReleaseFile,
  type AgentReleaseManifest,
} from '@tempestas/domain';
import { API_PREFIX } from '../common/api-prefix';

export const AGENT_RELEASES_ROUTE = 'agent-releases';
export const MANIFEST_FILE = 'manifest.json';
export const BUNDLE_FILES_DIRECTORY = 'files';
// tools/deploy.sh ships a bundle under a dot-name and renames it into place once complete.
const PARTIAL_BUNDLE_PREFIX = '.';
const MISSING_FILE_CODE = 'ENOENT';

export interface AgentReleaseBundle {
  release: AgentRelease;
  // Served from memory, so the bytes always match the sha256 advertised for them, whatever lands on disk later.
  manifestBytes: Buffer;
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
  for (const app of await listDirectories(root, reportRejected)) {
    for (const version of await listDirectories(
      join(root, app),
      reportRejected,
    )) {
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
  const manifestBytes = await readFile(join(bundleDirectory, MANIFEST_FILE));
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
      manifestPath: `/${API_PREFIX}/${AGENT_RELEASES_ROUTE}/${manifest.app}/${manifest.version}/${MANIFEST_FILE}`,
      manifestSha256: sha256Hex(manifestBytes),
    },
    manifestBytes,
    filesByPath,
  };
}

function parseManifest(text: string): AgentReleaseManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${MANIFEST_FILE} is not JSON`);
  }
  if (!isJsonObject(parsed)) {
    throw new Error(`${MANIFEST_FILE} is not a JSON object`);
  }
  return parsed as unknown as AgentReleaseManifest;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function describeManifestProblem(
  manifest: AgentReleaseManifest,
  app: string,
  version: string,
): string | null {
  if (!isAgentApp(manifest.app) || manifest.app !== app) {
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
  for (const file of manifest.files) {
    if (!isListedFileWellFormed(file)) {
      return `manifest lists ${JSON.stringify(file)}, which is not a safe path with a sha256`;
    }
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
    const actualSha256 = sha256Hex(await readListedFile(onDisk, file.path));
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

// Only a missing directory is quietly empty: an unreadable one would otherwise look like no bundles at all.
async function listDirectories(
  directory: string,
  reportRejected: ReportRejectedBundle,
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (failure: NodeJS.ErrnoException) => {
      if (failure.code !== MISSING_FILE_CODE) {
        reportRejected(directory, failure.message);
      }
      return [];
    },
  );
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith(PARTIAL_BUNDLE_PREFIX));
}

export function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}
