import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';

const DEBIAN_VERSION_LIBRARY = new URL('./debian-version.sh', import.meta.url)
  .pathname;

function runToDebianVersion(version) {
  return spawnSync(
    'bash',
    [
      '-c',
      'source "$1"; to_debian_version "$2"',
      'bash',
      DEBIAN_VERSION_LIBRARY,
      version,
    ],
    {
      encoding: 'utf8',
    },
  );
}

function toDebianVersion(version) {
  const result = runToDebianVersion(version);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function isDebianVersionLower(lower, higher) {
  return (
    spawnSync('dpkg', ['--compare-versions', lower, 'lt', higher]).status === 0
  );
}

describe('to_debian_version', () => {
  it('keeps a release version as it is', () => {
    assert.equal(toDebianVersion('1.2.3'), '1.2.3');
  });

  it("turns a pre-release's dash into a tilde", () => {
    assert.equal(
      toDebianVersion('1.2.3-dev+96a677e.dirty'),
      '1.2.3~dev+96a677e.dirty',
    );
    assert.equal(
      toDebianVersion('1.4.0-dev.1+3.gabc1234'),
      '1.4.0~dev.1+3.gabc1234',
    );
  });

  it('sorts a pre-release below its release, and a build past a release above it', () => {
    assert.ok(
      isDebianVersionLower(
        toDebianVersion('1.4.0-dev.1'),
        toDebianVersion('1.4.0'),
      ),
    );
    assert.ok(
      isDebianVersionLower(
        toDebianVersion('1.4.0'),
        toDebianVersion('1.4.0+2.gabc1234'),
      ),
    );
    assert.ok(
      isDebianVersionLower(
        toDebianVersion('1.4.0+2.gabc1234'),
        toDebianVersion('1.4.1-dev.1'),
      ),
    );
  });

  for (const invalid of ['v1.2.3', '1.2.3-dev_1', '', 'dev']) {
    it(`refuses ${JSON.stringify(invalid)}, which dpkg would not accept`, () => {
      const result = runToDebianVersion(invalid);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, '');
    });
  }

  it('gives versions dpkg itself accepts', () => {
    execFileSync('dpkg', [
      '--validate-version',
      toDebianVersion('1.2.3-dev+96a677e.dirty'),
    ]);
  });
});
