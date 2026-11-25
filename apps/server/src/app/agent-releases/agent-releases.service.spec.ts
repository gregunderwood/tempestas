import { AgentApp, type NodeCapabilities } from '@tempestas/domain';
import {
  AgentReleasesService,
  describeWhyNotUpdatable,
  type RunningAgent,
} from './agent-releases.service';
import {
  makeAgentReleasesRoot,
  writeBundle,
} from './agent-release-bundles.fixtures';

const ON_CONTRACT_1_1: NodeCapabilities = {
  contractVersion: 1,
  contractMinor: 1,
  sensors: [],
  hasRtc: true,
};

async function makeServiceOffering(
  ...bundles: [AgentApp, string][]
): Promise<AgentReleasesService> {
  const root = makeAgentReleasesRoot();
  for (const [app, version] of bundles) {
    writeBundle(root, app, version);
  }
  const service = new AgentReleasesService(root);
  await service.onModuleInit();
  return service;
}

function linuxAgent(changes: Partial<RunningAgent> = {}): RunningAgent {
  return {
    agentName: AgentApp.Linux,
    agentVersion: '1.1.3',
    capabilities: ON_CONTRACT_1_1,
    ...changes,
  };
}

describe('AgentReleasesService.findAvailableUpdate', () => {
  it('offers the newest bundle for the agent, compared by number', async () => {
    const service = await makeServiceOffering(
      [AgentApp.Linux, '1.1.9'],
      [AgentApp.Linux, '1.1.10'],
      [AgentApp.MicroPython, '1.1.20'],
    );

    expect(service.findAvailableUpdate(linuxAgent())).toBe('1.1.10');
  });

  it('offers nothing to an agent already on the newest', async () => {
    const service = await makeServiceOffering([AgentApp.Linux, '1.1.3']);

    expect(service.findAvailableUpdate(linuxAgent())).toBeNull();
  });

  it('never offers a bundle for another contract major', async () => {
    const service = await makeServiceOffering([AgentApp.Linux, '2.0.0']);

    expect(service.findAvailableUpdate(linuxAgent())).toBeNull();
  });

  it('offers a later contract major an update from its first minor', async () => {
    const service = await makeServiceOffering([AgentApp.Linux, '2.0.1']);

    expect(
      service.findAvailableUpdate(
        linuxAgent({
          agentVersion: '2.0.0',
          // The type allows only contract 1 until a contract 2 exists.
          capabilities: {
            ...ON_CONTRACT_1_1,
            contractVersion: 2,
            contractMinor: 0,
          } as unknown as NodeCapabilities,
        }),
      ),
    ).toBe('2.0.1');
  });

  it('offers nothing to a node before contract 1.1, which never subscribes to update', async () => {
    const service = await makeServiceOffering([AgentApp.Linux, '1.1.4']);

    expect(
      service.findAvailableUpdate(
        linuxAgent({
          agentVersion: '1.0.5',
          capabilities: { ...ON_CONTRACT_1_1, contractMinor: undefined },
        }),
      ),
    ).toBeNull();
  });

  it('offers nothing to a node that has never named its agent', async () => {
    const service = await makeServiceOffering([AgentApp.Linux, '1.1.4']);

    expect(
      service.findAvailableUpdate(linuxAgent({ agentName: null })),
    ).toBeNull();
  });

  it('offers nothing when the running version cannot be read', async () => {
    const service = await makeServiceOffering([AgentApp.Linux, '1.1.4']);

    expect(
      service.findAvailableUpdate(linuxAgent({ agentVersion: '0.0.0+dev' })),
    ).toBeNull();
  });

  it('offers the release to a -dev build whose branch counted past it', async () => {
    const service = await makeServiceOffering([AgentApp.Linux, '1.1.4']);

    expect(
      service.findAvailableUpdate(
        linuxAgent({ agentVersion: '1.1.7-dev+ecdbbe7' }),
      ),
    ).toBe('1.1.4');
  });

  it('offers a newer release to a -dev build behind it', async () => {
    const service = await makeServiceOffering([AgentApp.Linux, '1.1.4']);

    expect(
      service.findAvailableUpdate(
        linuxAgent({ agentVersion: '1.1.3-dev+ecdbbe7' }),
      ),
    ).toBe('1.1.4');
  });
});

describe('describeWhyNotUpdatable', () => {
  const agent = (overrides: Partial<RunningAgent>): RunningAgent => ({
    agentName: AgentApp.Linux,
    agentVersion: '1.1.0',
    capabilities: ON_CONTRACT_1_1,
    ...overrides,
  });

  it('says nothing for an agent that takes the update command', () => {
    expect(describeWhyNotUpdatable(agent({}))).toBeNull();
  });

  it.each([
    ['one too old to name itself', agent({ agentName: null }), 'too old'],
    ['an app it does not know', agent({ agentName: 'esphome' }), 'esphome'],
    [
      'one on contract 1.0',
      agent({ capabilities: { ...ON_CONTRACT_1_1, contractMinor: 0 } }),
      'needs contract 1.1',
    ],
  ])('explains %s', (_case, running, reason) => {
    expect(describeWhyNotUpdatable(running)).toContain(reason);
  });
});
