import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Zone } from '@tempestas/domain';
import { ZoneEntity } from './models';

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
