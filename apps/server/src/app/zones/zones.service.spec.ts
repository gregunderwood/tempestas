import type { Repository } from 'typeorm';
import type { ZoneRulesConfig } from '@tempestas/domain';
import type { ZoneEntity } from './models';
import { ZonesService } from './zones.service';

const CONFIG = {
  enabledRoles: ['heater'],
  sensorPolicy: { default: { source: 'min', maxAgeMs: 120_000 } },
  rules: {
    heater: {
      kind: 'thermostat',
      mode: 'heat',
      onAtC: 2,
      offAtC: 5,
      onStale: 'on',
    },
  },
  timezone: 'America/Vancouver',
} as ZoneRulesConfig;

describe('ZonesService', () => {
  it('returns each zone with its config as stored and when it last changed', async () => {
    const find = vi.fn().mockResolvedValue([
      {
        id: 'z1',
        slug: 'pumphouse',
        displayName: 'Pumphouse',
        rulesConfig: CONFIG,
        updatedAt: new Date('2026-11-17T23:15:57Z'),
      },
    ]);
    const service = new ZonesService({
      find,
    } as unknown as Repository<ZoneEntity>);

    expect(await service.findAll()).toEqual([
      {
        id: 'z1',
        slug: 'pumphouse',
        displayName: 'Pumphouse',
        rulesConfig: CONFIG,
        updatedAt: '2026-11-17T23:15:57.000Z',
      },
    ]);
    expect(find).toHaveBeenCalledWith({ order: { slug: 'ASC' } });
  });
});
