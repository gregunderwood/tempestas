beforeEach(() => {
  cy.task('recordTestStart', Cypress.currentTest.title, { log: false });
});
