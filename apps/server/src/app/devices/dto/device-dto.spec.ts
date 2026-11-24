import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { MAX_INPUT_BTU_PER_HOUR } from '@tempestas/domain';
import { CreateDeviceDto } from './create-device.dto';
import { UpdateDeviceDto } from './update-device.dto';

const VALID_DEVICE = {
  nodeId: 'elantris',
  name: 'CO2 burner',
  gpio: 16,
  onDelayDuration: 300,
  onLevel: 0,
};

function failedFieldsOfCreate(payload: Record<string, unknown>): string[] {
  const errors = validateSync(plainToInstance(CreateDeviceDto, payload));
  return errors.map((error) => error.property);
}

function failedFieldsOfUpdate(payload: Record<string, unknown>): string[] {
  const errors = validateSync(plainToInstance(UpdateDeviceDto, payload));
  return errors.map((error) => error.property);
}

describe('the burner input rating on a device', () => {
  it('is optional', () => {
    expect(failedFieldsOfCreate(VALID_DEVICE)).toEqual([]);
  });

  it('may be null, for a device that burns no propane or whose rating is not known yet', () => {
    expect(
      failedFieldsOfCreate({ ...VALID_DEVICE, inputBtuPerHour: null }),
    ).toEqual([]);
    expect(failedFieldsOfUpdate({ inputBtuPerHour: null })).toEqual([]);
  });

  it('takes a nameplate rating', () => {
    expect(
      failedFieldsOfCreate({ ...VALID_DEVICE, inputBtuPerHour: 40_000 }),
    ).toEqual([]);
    expect(failedFieldsOfUpdate({ inputBtuPerHour: 40_000 })).toEqual([]);
  });

  it.each([0, -1, 40_000.5, '40000', MAX_INPUT_BTU_PER_HOUR + 1])(
    'refuses %s',
    (inputBtuPerHour) => {
      expect(
        failedFieldsOfCreate({ ...VALID_DEVICE, inputBtuPerHour }),
      ).toEqual(['inputBtuPerHour']);
      expect(failedFieldsOfUpdate({ inputBtuPerHour })).toEqual([
        'inputBtuPerHour',
      ]);
    },
  );
});
