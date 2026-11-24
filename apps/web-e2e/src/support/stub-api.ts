import {
  buildEmptyDayNightStats,
  buildEmptyZoneHistory,
  buildNode,
  buildZone,
} from '../fixtures/greenhouse';

const UNSTUBBED_STATUS_CODE = 501;

// Readings come only over the socket, so a card on the dashboard proves the socket stub delivered.
export function stubApi(): void {
  cy.intercept('/api/**', {
    statusCode: UNSTUBBED_STATUS_CODE,
    body: { message: 'Not stubbed in the smoke test' },
  });
  cy.intercept('GET', '/api/nodes', [buildNode()]);
  cy.intercept('GET', '/api/devices', []);
  cy.intercept('GET', '/api/zones', [buildZone()]);
  cy.intercept('GET', '/api/zone-history', buildEmptyZoneHistory());
  cy.intercept('GET', '/api/readings/latest', []);
  cy.intercept({ method: 'GET', pathname: '/api/readings' }, []);
  cy.intercept(
    'GET',
    '/api/readings/stats/day-night?*',
    buildEmptyDayNightStats(),
  );
  cy.intercept('GET', '/api/rules/latest-cycle', { cycle: null });
}
