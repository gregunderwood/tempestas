// Runs against tools/e2e-stack.sh, which admits the simulated nodes but creates no devices.
const SIMULATED_PI_SLUG = 'sim-pi';
const DEVICE_NAME_PREFIX = 'E2E';
const ADDED_DEVICE = `${DEVICE_NAME_PREFIX} heater`;
const DEVICE_FROM_ANOTHER_PAGE = `${DEVICE_NAME_PREFIX} fan`;
const FIRST_PIN = 4;
const MOVED_TO_PIN = 6;
const PIN_FROM_ANOTHER_PAGE = 5;
const FIRST_RATING = '40000';
const CHANGED_RATING = '60000';

interface DeviceSummary {
  id: string;
  name: string;
}

function removeTestDevices(): void {
  cy.request<DeviceSummary[]>('/api/devices').then(({ body: devices }) => {
    devices
      .filter((device) => device.name.startsWith(DEVICE_NAME_PREFIX))
      .forEach((device) => {
        cy.request({
          method: 'POST',
          url: `/api/devices/${device.id}/off`,
          failOnStatusCode: false,
        });
        cy.request('DELETE', `/api/devices/${device.id}`);
      });
  });
}

function findField(label: string): Cypress.Chainable<JQuery<HTMLElement>> {
  return cy.contains('mat-dialog-container mat-form-field', label);
}

function chooseOption(label: string, option: string): void {
  findField(label).find('mat-select').click();
  cy.contains('mat-option', option).click();
}

function typeInto(label: string, text: string): void {
  findField(label).find('input').clear().type(text);
}

function pressInDialog(label: string): void {
  cy.get('mat-dialog-container').contains('button', label).click();
}

function findDeviceCard(name: string): Cypress.Chainable<JQuery<HTMLElement>> {
  return cy.contains('mat-card', name);
}

function findDeviceState(name: string): Cypress.Chainable<JQuery<HTMLElement>> {
  return findDeviceCard(name).find('mat-card-content strong');
}

function pressInDeviceCard(name: string, label: string): void {
  findDeviceCard(name).contains('button', label).click();
}

describe('Adding and editing a device from the Devices page', () => {
  before(removeTestDevices);
  after(removeTestDevices);

  it('asks for a name, then adds the device', () => {
    cy.visit('/devices');
    cy.contains('button', 'Add device').click();

    chooseOption('Node', SIMULATED_PI_SLUG);
    chooseOption('GPIO pin', String(FIRST_PIN));
    chooseOption('On level', 'High (1)');
    typeInto('On delay', '0');
    typeInto('Input rating', FIRST_RATING);
    cy.get('mat-dialog-container').should(
      'contain.text',
      'Check them against the wiring',
    );
    pressInDialog('Add device');
    findField('Name').should('contain.text', 'A device needs a name.');

    typeInto('Name', ADDED_DEVICE);
    pressInDialog('Add device');

    cy.get('mat-dialog-container').should('not.exist');
    findDeviceCard(ADDED_DEVICE).should(
      'contain.text',
      `${SIMULATED_PI_SLUG} · pin ${FIRST_PIN}`,
    );
  });

  it('marks a pin another device already uses', () => {
    cy.visit('/devices');
    cy.contains('button', 'Add device').click();

    chooseOption('Node', SIMULATED_PI_SLUG);
    findField('GPIO pin').find('mat-select').click();
    cy.contains('mat-option', `used by ${ADDED_DEVICE}`).should(
      'have.attr',
      'aria-disabled',
      'true',
    );
    cy.get('body').type('{esc}');
    pressInDialog('Cancel');
  });

  it('warns before moving a device to another pin, then saves the move and the rating', () => {
    cy.visit('/devices');
    pressInDeviceCard(ADDED_DEVICE, 'Edit');
    findField('Input rating').find('input').should('have.value', FIRST_RATING);

    chooseOption('GPIO pin', String(MOVED_TO_PIN));
    cy.get('mat-dialog-container [role="alert"]').should(
      'contain.text',
      `Moving to pin ${MOVED_TO_PIN}`,
    );
    typeInto('Input rating', CHANGED_RATING);
    pressInDialog('Save');

    cy.get('mat-dialog-container').should('not.exist');
    findDeviceCard(ADDED_DEVICE).should('contain.text', `pin ${MOVED_TO_PIN}`);
    pressInDeviceCard(ADDED_DEVICE, 'Edit');
    findField('Input rating')
      .find('input')
      .should('have.value', CHANGED_RATING);
    pressInDialog('Cancel');
  });

  it('locks the pin and on level while the device is on', () => {
    cy.visit('/devices');
    pressInDeviceCard(ADDED_DEVICE, 'Turn on');
    findDeviceState(ADDED_DEVICE).should('have.text', 'ON');

    pressInDeviceCard(ADDED_DEVICE, 'Edit');
    cy.get('mat-dialog-container').should(
      'contain.text',
      `${ADDED_DEVICE} is on. Turn it off before changing its pin`,
    );
    findField('GPIO pin')
      .find('mat-select')
      .should('have.attr', 'aria-disabled', 'true');
    findField('On level')
      .find('mat-select')
      .should('have.attr', 'aria-disabled', 'true');
    pressInDialog('Cancel');

    pressInDeviceCard(ADDED_DEVICE, 'Turn off');
    findDeviceState(ADDED_DEVICE).should('have.text', 'off');
  });

  it('shows a device added on another page without a reload', () => {
    cy.visit('/devices');
    findDeviceCard(ADDED_DEVICE);

    cy.request('POST', '/api/devices', {
      nodeId: SIMULATED_PI_SLUG,
      name: DEVICE_FROM_ANOTHER_PAGE,
      gpio: PIN_FROM_ANOTHER_PAGE,
      onLevel: 1,
      onDelayDuration: 0,
    });

    findDeviceCard(DEVICE_FROM_ANOTHER_PAGE).should(
      'contain.text',
      `pin ${PIN_FROM_ANOTHER_PAGE}`,
    );
  });
});
