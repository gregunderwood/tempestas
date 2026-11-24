import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { explainDatabaseRefusal } from './development-database.mjs';

const COMPOSE_DEV_LABELS = { 'com.docker.compose.service': 'db' };
const DOCKER_RUN_LABELS = {};

describe('explainDatabaseRefusal', () => {
  for (const allowed of [
    'tempestas_dev',
    'tempestas_dev_reports',
    'tempestas_pr_139_after',
  ]) {
    it(`allows ${allowed}`, () => {
      assert.equal(explainDatabaseRefusal(allowed, DOCKER_RUN_LABELS), null);
    });
  }

  it('allows tempestas in the container docker compose started for dev', () => {
    assert.equal(explainDatabaseRefusal('tempestas', COMPOSE_DEV_LABELS), null);
  });

  it('refuses tempestas in a container started with docker run, as production is', () => {
    assert.match(
      explainDatabaseRefusal('tempestas', DOCKER_RUN_LABELS),
      /refusing tempestas: .* may be production/,
    );
  });

  it('refuses tempestas when the container cannot be inspected', () => {
    assert.match(
      explainDatabaseRefusal('tempestas', null),
      /refusing tempestas/,
    );
  });

  it('refuses tempestas under a different compose service', () => {
    assert.match(
      explainDatabaseRefusal('tempestas', {
        'com.docker.compose.service': 'postgres',
      }),
      /refusing tempestas/,
    );
  });

  for (const refused of ['postgres', 'tempestas_prod', 'tempestas_pr_12']) {
    it(`refuses ${refused} even in the dev container`, () => {
      assert.match(
        explainDatabaseRefusal(refused, COMPOSE_DEV_LABELS),
        new RegExp(`refusing ${refused}: not a dev or screenshot`),
      );
    });
  }
});
