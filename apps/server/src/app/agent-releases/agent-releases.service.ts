import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  AgentApp,
  compareAgentVersions,
  isNewerAgentVersion,
  parseAgentVersion,
  UPDATE_COMMAND_CONTRACT,
  type AgentRelease,
  type AgentVersionNumbers,
  type NodeCapabilities,
} from '@tempestas/domain';
import {
  readVerifiedBundles,
  type AgentReleaseBundle,
} from './agent-release-bundles';

export const AGENT_RELEASES_DIRECTORY = Symbol('AGENT_RELEASES_DIRECTORY');
const AGENT_APPS = new Set<unknown>(Object.values(AgentApp));

/** What a node says about itself in its hello, which is all an update offer needs. */
export interface RunningAgent {
  agentName: string | null;
  agentVersion: string | null;
  capabilities: NodeCapabilities;
}

interface OfferedRelease {
  release: AgentRelease;
  numbers: AgentVersionNumbers;
}

// Read once at startup: tools/deploy.sh ships bundles only alongside a server release, which restarts it.
@Injectable()
export class AgentReleasesService implements OnModuleInit {
  private readonly logger = new Logger(AgentReleasesService.name);
  private bundles: AgentReleaseBundle[] = [];

  constructor(
    @Inject(AGENT_RELEASES_DIRECTORY) private readonly directory: string,
  ) {}

  async onModuleInit(): Promise<void> {
    this.bundles = await readVerifiedBundles(
      this.directory,
      (bundleDirectory, reason) =>
        this.logger.warn(`Not offering ${bundleDirectory}: ${reason}`),
    );
    this.logger.log(
      `Offering ${this.bundles.length} agent release bundle(s) from ${this.directory}`,
    );
  }

  list(): AgentRelease[] {
    return this.bundles.map((bundle) => bundle.release);
  }

  findBundle(app: string, version: string): AgentReleaseBundle | undefined {
    return this.bundles.find(
      (bundle) =>
        bundle.release.app === app && bundle.release.version === version,
    );
  }

  /** The newest bundle for this agent on its contract major, when newer than what it runs. */
  findAvailableUpdate(agent: RunningAgent): string | null {
    if (!canTakeUpdateCommand(agent)) {
      return null;
    }
    const running = parseAgentVersion(agent.agentVersion ?? '');
    const newest = this.findNewestRelease(
      agent.agentName as AgentApp,
      agent.capabilities.contractVersion,
    );
    if (!running || !newest) {
      return null;
    }
    return isNewerAgentVersion(newest.numbers, running)
      ? newest.release.version
      : null;
  }

  private findNewestRelease(
    app: AgentApp,
    contractMajor: number,
  ): OfferedRelease | null {
    const candidates = this.bundles
      .map((bundle) => bundle.release)
      .filter(
        (release) =>
          release.app === app && release.contractMajor === contractMajor,
      )
      .map((release) => ({
        release,
        numbers: parseAgentVersion(release.version) as AgentVersionNumbers,
      }))
      .sort((first, second) =>
        compareAgentVersions(second.numbers, first.numbers),
      );
    return candidates[0] ?? null;
  }
}

// An agent older than contract 1.0 sends no name, and one before 1.1 never subscribes to `update`.
function canTakeUpdateCommand(agent: RunningAgent): boolean {
  return (
    AGENT_APPS.has(agent.agentName) &&
    isOnContractWithUpdateCommand(agent.capabilities)
  );
}

function isOnContractWithUpdateCommand(capabilities: NodeCapabilities): boolean {
  const major = capabilities.contractVersion;
  const minor = capabilities.contractMinor ?? 0;
  if (major !== UPDATE_COMMAND_CONTRACT.major) {
    return major > UPDATE_COMMAND_CONTRACT.major;
  }
  return minor >= UPDATE_COMMAND_CONTRACT.minor;
}
