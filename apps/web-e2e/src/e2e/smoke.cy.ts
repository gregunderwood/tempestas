import { REALTIME_EVENTS } from '@tempestas/domain';
import {
  NODE_DISPLAY_NAME,
  ZONE_DISPLAY_NAME,
  buildReading,
  buildSystemStatus,
} from '../fixtures/greenhouse';
import {
  findLiveIndicator,
  findMenuButton,
  findNavLink,
  findPageHeading,
} from '../support/app.po';
import { installFakeRealtimeServer } from '../support/fake-realtime-server';
import { stubApi } from '../support/stub-api';

const DESKTOP_VIEWPORT = { width: 1280, height: 800 };
const PHONE_VIEWPORT = { width: 390, height: 844 };

// Waits for the first navigation, which closes the menu and would race an early click.
function openAppWithLiveFeed(): void {
  stubApi();
  const now = new Date();
  cy.visit('/', {
    onBeforeLoad: (window) =>
      installFakeRealtimeServer(window, [
        {
          event: REALTIME_EVENTS.systemStatus,
          payload: buildSystemStatus(now),
        },
        { event: REALTIME_EVENTS.readingLatest, payload: buildReading(now) },
      ]),
  });
  shouldShowPage('Dashboard');
}

function shouldShowPage(heading: string): void {
  findPageHeading().should('have.text', heading);
}

describe('smoke', () => {
  describe('on a desktop', () => {
    beforeEach(() => {
      cy.viewport(DESKTOP_VIEWPORT.width, DESKTOP_VIEWPORT.height);
      openAppWithLiveFeed();
    });

    it('opens on the dashboard with the socket live', () => {
      cy.location('pathname').should('eq', '/dashboard');
      findLiveIndicator().should('have.text', 'live');
      findMenuButton().should('not.be.visible');
    });

    it('shows a card for the node the socket reported', () => {
      cy.contains('temp-node-stat-card', NODE_DISPLAY_NAME)
        .should('contain.text', '21.4')
        .and('contain.text', '812');
    });

    it('moves to Zones and Nodes from the rail', () => {
      findNavLink('Zones').click();
      shouldShowPage('Zones');
      cy.contains(ZONE_DISPLAY_NAME).should('be.visible');

      findNavLink('Nodes').click();
      shouldShowPage('Nodes');
      cy.contains('mat-card', NODE_DISPLAY_NAME).should('be.visible');
      findNavLink('Nodes').should('have.attr', 'aria-current', 'page');
    });
  });

  describe('on a phone', () => {
    beforeEach(() => {
      cy.viewport(PHONE_VIEWPORT.width, PHONE_VIEWPORT.height);
      openAppWithLiveFeed();
    });

    it('hides the nav behind the menu button', () => {
      findLiveIndicator().should('have.text', 'live');
      findNavLink('Zones').should('not.be.visible');
      findMenuButton().should('have.attr', 'aria-expanded', 'false');
    });

    it('moves to Zones and Nodes from the menu, closing it each time', () => {
      findMenuButton().click();
      findMenuButton().should('have.attr', 'aria-expanded', 'true');
      findNavLink('Zones').click();
      shouldShowPage('Zones');
      findMenuButton().should('have.attr', 'aria-expanded', 'false');
      cy.contains(ZONE_DISPLAY_NAME).should('be.visible');

      findMenuButton().click();
      findNavLink('Nodes').click();
      shouldShowPage('Nodes');
      findMenuButton().should('have.attr', 'aria-expanded', 'false');
      cy.contains('mat-card', NODE_DISPLAY_NAME).should('be.visible');
    });
  });
});
