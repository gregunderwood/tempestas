import {
  compareAgentVersions,
  isNewerAgentVersion,
  shouldOfferAgentRelease,
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
});

describe('shouldOfferAgentRelease', () => {
  it('offers a released build only a newer release', () => {
    expect(shouldOfferAgentRelease(parse('1.1.5'), '1.1.4')).toBe(true);
    expect(shouldOfferAgentRelease(parse('1.1.4'), '1.1.4')).toBe(false);
    expect(shouldOfferAgentRelease(parse('1.1.3'), '1.1.4')).toBe(false);
  });

  it('offers a -dev build the release, whatever its branch has counted', () => {
    expect(shouldOfferAgentRelease(parse('1.1.4'), '1.1.7-dev+ecdbbe7')).toBe(
      true,
    );
    expect(
      shouldOfferAgentRelease(parse('1.1.4'), '1.1.4-dev+ecdbbe7.dirty'),
    ).toBe(true);
  });

  it('offers nothing over a version it cannot read', () => {
    expect(shouldOfferAgentRelease(parse('1.1.4'), '0.0.0+dev')).toBe(false);
  });
});

it('sorts newest first with the comparison reversed', () => {
  const sorted = ['1.0.9', '1.0.10', '1.0.2']
    .map(parse)
    .sort((first, second) => compareAgentVersions(second, first));
  expect(sorted.map((numbers) => numbers.patch)).toEqual([10, 9, 2]);
});
