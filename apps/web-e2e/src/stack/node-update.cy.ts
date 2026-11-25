// Runs against tools/e2e-stack.sh: the fake driver plays each update through, a step every 1.5 s.
const SIMULATED_PI = 'sim-pi';
const SIMULATED_ESP32 = 'sim-esp32';
const RUNNING_VERSION = '1.2.0';
const OFFERED_VERSION = '1.2.1';
const UPDATE_FINISHED_WITHIN_MILLISECONDS = 20_000;

function findSoftwareCard(): Cypress.Chainable<JQuery<HTMLElement>> {
  return cy.contains('mat-card', 'Software');
}

function pressInSoftwareCard(label: string): void {
  findSoftwareCard().contains('button', label).click();
}

function confirmFromSoftwareCard(label: string): void {
  pressInSoftwareCard(label);
  findSoftwareCard().should('contain.text', 'fail-safe levels');
  pressInSoftwareCard(label);
}

function shouldFinishHealthy(attempt: string): void {
  findSoftwareCard().contains('.progress', attempt);
  cy.contains('mat-card', 'Software', {
    timeout: UPDATE_FINISHED_WITHIN_MILLISECONDS,
  }).should('contain.text', `${attempt}: healthy`);
}

describe('Updating a node from its page', () => {
  it('asks first, and backs out on Cancel', () => {
    cy.visit(`/nodes/${SIMULATED_PI}`);

    pressInSoftwareCard(`Update to ${OFFERED_VERSION}`);
    findSoftwareCard().should('contain.text', 'fail-safe levels');
    pressInSoftwareCard('Cancel');

    findSoftwareCard().should('not.contain.text', 'fail-safe levels');
    findSoftwareCard().contains('button', `Update to ${OFFERED_VERSION}`);
  });

  it('updates the node, follows it to healthy, then rolls it back', () => {
    cy.visit(`/nodes/${SIMULATED_PI}`);
    findSoftwareCard().should('contain.text', `agent-linux ${RUNNING_VERSION}`);

    confirmFromSoftwareCard(`Update to ${OFFERED_VERSION}`);
    shouldFinishHealthy(`Update to ${OFFERED_VERSION}`);
    findSoftwareCard().should('contain.text', `agent-linux ${OFFERED_VERSION}`);

    confirmFromSoftwareCard(`Roll back to ${RUNNING_VERSION}`);
    shouldFinishHealthy(`Roll back to ${RUNNING_VERSION}`);
    findSoftwareCard().should('contain.text', `agent-linux ${RUNNING_VERSION}`);
    findSoftwareCard().contains('button', `Update to ${OFFERED_VERSION}`);
  });

  it('says why a MicroPython node is not offered an update', () => {
    cy.visit(`/nodes/${SIMULATED_ESP32}`);

    findSoftwareCard().should('contain.text', 'needs contract 1.1');
    findSoftwareCard().find('button').should('not.exist');
  });
});
