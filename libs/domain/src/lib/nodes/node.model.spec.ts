import { describeAgent } from './node.model';

describe('describeAgent', () => {
  it('names the app before its version', () => {
    expect(
      describeAgent({
        agentName: 'agent-linux',
        agentVersion: '1.0.3+abc1234',
      }),
    ).toBe('agent-linux 1.0.3+abc1234');
  });

  it('shows only the version for an agent that does not name itself', () => {
    expect(describeAgent({ agentName: null, agentVersion: '0.1.0' })).toBe(
      '0.1.0',
    );
  });
});
