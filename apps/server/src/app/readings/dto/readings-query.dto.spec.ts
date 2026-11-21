import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ReadingsQueryDto } from './readings-query.dto';

function failedFieldsOf(query: Record<string, string>): string[] {
  const errors = validateSync(plainToInstance(ReadingsQueryDto, query));
  return errors.map((error) => error.property);
}

describe('ReadingsQueryDto', () => {
  it('refuses a sensor without its node, since sensor ids repeat across nodes', () => {
    expect(failedFieldsOf({ sensorId: 'pipes' })).toEqual(['nodeId']);
  });

  it('takes a sensor with its node', () => {
    expect(failedFieldsOf({ nodeId: 'patji', sensorId: 'pipes' })).toEqual([]);
  });

  it('needs neither', () => {
    expect(failedFieldsOf({})).toEqual([]);
  });
});
