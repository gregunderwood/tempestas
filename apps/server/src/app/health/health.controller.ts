import { Controller, Get } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/** The endpoint you curl at 2am when the greenhouse is cold. */
@Controller('health')
export class HealthController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  @Get()
  async check() {
    let db = false;
    try {
      await this.dataSource.query('select 1');
      db = true;
    } catch {
      db = false;
    }
    return {
      status: db ? 'ok' : 'degraded',
      db,
      uptimeSeconds: Math.round(process.uptime()),
    };
  }
}
