import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DESCRIBE_PRODUCT_VERSION = new URL(
  '../describe-product-version.sh',
  import.meta.url,
).pathname;
const COMMIT_ID_LENGTH = 7;

function makeRepository() {
  const repository = mkdtempSync(join(tmpdir(), 'product-version-'));
  runGit(repository, 'init', '--quiet');
  return repository;
}

function runGit(repository, ...gitArguments) {
  return execFileSync(
    'git',
    [
      '-C',
      repository,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      ...gitArguments,
    ],
    { encoding: 'utf8' },
  ).trim();
}

function commit(repository, message) {
  runGit(repository, 'commit', '--quiet', '--allow-empty', '-m', message);
  return runGit(repository, 'rev-parse', `--short=${COMMIT_ID_LENGTH}`, 'HEAD');
}

function describeProductVersion(repository) {
  return execFileSync(DESCRIBE_PRODUCT_VERSION, [repository], {
    encoding: 'utf8',
  }).trim();
}

describe('describe-product-version.sh', () => {
  it('counts from 0.0.0 before the first release tag', () => {
    const repository = makeRepository();
    commit(repository, 'first');
    const head = commit(repository, 'second');
    assert.equal(describeProductVersion(repository), `0.0.0+2.g${head}`);
  });

  it('is the bare version at a release tag', () => {
    const repository = makeRepository();
    commit(repository, 'first');
    runGit(repository, 'tag', 'v1.2.0');
    assert.equal(describeProductVersion(repository), '1.2.0');
  });

  it('counts the commits past the last release tag', () => {
    const repository = makeRepository();
    commit(repository, 'first');
    runGit(repository, 'tag', 'v1.2.0');
    const head = commit(repository, 'second');
    assert.equal(describeProductVersion(repository), `1.2.0+1.g${head}`);
  });

  it('ignores tags that are not release versions', () => {
    const repository = makeRepository();
    commit(repository, 'first');
    runGit(repository, 'tag', 'v1.2.0');
    const head = commit(repository, 'second');
    runGit(repository, 'tag', 'bench-run');
    assert.equal(describeProductVersion(repository), `1.2.0+1.g${head}`);
  });

  it('marks uncommitted changes as dirty, at a tag and past one', () => {
    const repository = makeRepository();
    commit(repository, 'first');
    runGit(repository, 'tag', 'v1.2.0');
    writeFileSync(join(repository, 'changed.txt'), 'changed');
    assert.equal(describeProductVersion(repository), '1.2.0+dirty');
    runGit(repository, 'add', 'changed.txt');
    const head = commit(repository, 'second');
    writeFileSync(join(repository, 'changed.txt'), 'changed again');
    assert.equal(describeProductVersion(repository), `1.2.0+1.g${head}.dirty`);
  });
});
