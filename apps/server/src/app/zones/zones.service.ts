import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Zone } from '@tempestas/domain';
import { ZoneEntity } from './models';

/**
 * Read-only on purpose. A zone's rules drive a heater and a CO2 burner, and are
 * changed by reviewed SQL (`tools/pumphouse-zone.sql`), not by a form. This
 * exists so a screen can show what the rules ARE beside what they are doing.
 *
 * The config is returned as stored. Whether it parses is the rules engine's
 * verdict, reported per cycle in `rules:evaluation` as a failing zone - one
 * opinion about validity, in one place.
 */
@Injectable()
export class ZonesService {
  constructor(
    @InjectRepository(ZoneEntity)
    private readonly zones: Repository<ZoneEntity>,
  ) {}

  async findAll(): Promise<Zone[]> {
    const rows = await this.zones.find({ order: { slug: 'ASC' } });
    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      displayName: row.displayName,
      rulesConfig: row.rulesConfig,
      updatedAt: row.updatedAt.toISOString(),
    }));
  }
}
