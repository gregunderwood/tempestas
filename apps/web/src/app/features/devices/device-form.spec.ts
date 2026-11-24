import { DeviceRole } from '@tempestas/domain';
import { device, heatTape, node } from '../zones/zone-fixtures';
import {
  buildCreatePayload,
  buildUpdatePayload,
  describeRemapping,
  emptyDeviceForm,
  listPinChoices,
  readDeviceForm,
  type CompleteDeviceFormValue,
} from './device-form';

const patji = node('patji', 'z-pump');

const completedForm = (
  overrides: Partial<CompleteDeviceFormValue> = {},
): CompleteDeviceFormValue => ({
  ...emptyDeviceForm(),
  name: '  Shop heater ',
  nodeId: 'patji',
  gpio: 6,
  onLevel: 0,
  onDelayDuration: 300,
  ...overrides,
});

describe('a new device form', () => {
  it('leaves the on level unchosen, so nobody saves a guess', () => {
    expect(emptyDeviceForm().onLevel).toBeNull();
  });
});

describe('the payloads a device form sends', () => {
  it('lets a new device take its node zone when none is chosen', () => {
    expect(buildCreatePayload(completedForm())).not.toHaveProperty('zoneId');
  });

  it('trims the name and sends a blank rating as none', () => {
    expect(buildCreatePayload(completedForm())).toMatchObject({
      name: 'Shop heater',
      inputBtuPerHour: null,
    });
  });

  it('sends every editable field of an edit, and never the node', () => {
    const edit = buildUpdatePayload({
      ...readDeviceForm(device()),
      inputBtuPerHour: 40_000,
      role: DeviceRole.HeatTape,
    } as CompleteDeviceFormValue);
    expect(edit).toEqual({
      zoneId: 'z-pump',
      name: 'Heater',
      role: DeviceRole.HeatTape,
      gpio: 5,
      onLevel: 1,
      onDelayDuration: 300,
      inputBtuPerHour: 40_000,
    });
  });
});

describe('the pins a device form offers', () => {
  it('offers the pins the node exposes and names the device on each taken one', () => {
    expect(listPinChoices(patji, [device(), heatTape()], null)).toEqual([
      { pin: 5, usedBy: 'Heater' },
      { pin: 6, usedBy: 'Heat tape' },
    ]);
  });

  it('does not count the edited device as using its own pin', () => {
    expect(listPinChoices(patji, [device(), heatTape()], device())).toEqual([
      { pin: 5, usedBy: null },
      { pin: 6, usedBy: 'Heat tape' },
    ]);
  });

  it('still offers the edited device its own pin when the node is not loaded', () => {
    expect(listPinChoices(undefined, [device()], device())).toEqual([
      { pin: 5, usedBy: null },
    ]);
  });

  it('offers nothing until a node is chosen', () => {
    expect(listPinChoices(undefined, [device()], null)).toEqual([]);
  });
});

describe('the warnings before a relay is remapped', () => {
  it('says nothing when the pin and on level stay the same', () => {
    expect(describeRemapping(device(), readDeviceForm(device()))).toEqual([]);
  });

  it('says a new pin moves the device to another relay and leaves the old one', () => {
    const [warning] = describeRemapping(device(), {
      ...readDeviceForm(device()),
      gpio: 6,
    });
    expect(warning).toContain('changes which relay Heater drives');
    expect(warning).toContain('pin 5 is left as it is now');
  });

  it('says a new on level changes what on means without switching anything', () => {
    const [warning] = describeRemapping(device(), {
      ...readDeviceForm(device()),
      onLevel: 0,
    });
    expect(warning).toContain('changes what "on" means for Heater');
    expect(warning).toContain('Nothing switches');
  });
});
