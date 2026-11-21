import { findPageHeading } from '../support/app.po';

describe('web-e2e', () => {
  beforeEach(() => cy.visit('/'));

  it('should display welcome message', () => {
    findPageHeading().contains(/Welcome/);
  });
});
