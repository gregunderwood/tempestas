type Found<Element extends HTMLElement> = Cypress.Chainable<JQuery<Element>>;

export const findPageHeading = (): Found<HTMLHeadingElement> => cy.get('h1');

export const findNavLink = (label: string): Found<HTMLAnchorElement> =>
  cy.get('nav[aria-label="Main"]').contains('a', label);

export const findMenuButton = (): Found<HTMLButtonElement> =>
  cy.get('button[aria-controls="temp-nav"]');

// The shell renders the indicator twice, in the rail foot and the top bar, and shows one per width.
export const findLiveIndicator = (): Found<HTMLElement> =>
  cy.contains('.temp-link-label:visible', /^(live|offline)$/);
