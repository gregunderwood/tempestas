import {
  compareAgentVersions,
  isNewerAgentVersion,
  isReleasedAgentVersion,
  parseAgentVersion,
  type AgentVersionNumbers,
} from './agent-release.model';

const parse = (version: string) =>
  parseAgentVersion(version) as AgentVersionNumbers;

describe('parseAgentVersion', () => {
  it('reads the three numbers, with or without a -dev suffix', () => {
    expect(parseAgentVersion('1.1.4')).toEqual({
      major: 1,
      minor: 1,
      patch: 4,
    });
    expect(parseAgentVersion('1.1.4-dev+ecdbbe7.dirty')).toEqual({
      major: 1,
      minor: 1,
      patch: 4,
    });
  });

  it('refuses anything else, including an unstamped checkout', () => {
    expect(parseAgentVersion('0.0.0+dev')).toBeNull();
    expect(parseAgentVersion('v1')).toBeNull();
    expect(parseAgentVersion('1.1')).toBeNull();
  });
});

describe('isReleasedAgentVersion', () => {
  it('accepts only a clean major.minor.patch', () => {
    expect(isReleasedAgentVersion('1.1.4')).toBe(true);
    expect(isReleasedAgentVersion('1.1.4-dev+ecdbbe7')).toBe(false);
    expect(isReleasedAgentVersion('1.1')).toBe(false);
  });
});

describe('isNewerAgentVersion', () => {
  it('compares by number, never as text', () => {
    expect(isNewerAgentVersion(parse('1.0.10'), parse('1.0.9'))).toBe(true);
    expect(isNewerAgentVersion(parse('1.0.9'), parse('1.0.10'))).toBe(false);
    expect(isNewerAgentVersion(parse('1.2.0'), parse('1.1.99'))).toBe(true);
  });

  it('does not offer a release with the same numbers as a -dev build', () => {
    expect(
      isNewerAgentVersion(parse('1.1.4'), parse('1.1.4-dev+ecdbbe7')),
    ).toBe(false);
  });
});

it('sorts newest first with the comparison reversed', () => {
  const sorted = ['1.0.9', '1.0.10', '1.0.2']
    .map(parse)
    .sort((first, second) => compareAgentVersions(second, first));
  expect(sorted.map((numbers) => numbers.patch)).toEqual([10, 9, 2]);
});
