import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DevicesModule } from './devices/devices.module';
import { DeviceEntity } from './devices/models';
import { HardwareModule } from './hardware/hardware.module';
import { NodesModule } from './nodes/nodes.module';
import { NodeEntity } from './nodes/models';
import { ReadingsModule } from './readings/readings.module';
import { SensorReadingEntity } from './readings/models';
import { ZoneEntity } from './zones/models';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['apps/server/.env', '.env'] }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        host: config.get<string>('DATABASE_HOST', '127.0.0.1'),
        port: Number(config.get<string | number>('DATABASE_PORT', 5432)),
        username: config.get<string>('DATABASE_USER', 'tempestas'),
        password: config.get<string>('DATABASE_PASSWORD', 'tempestas'),
        database: config.get<string>('DATABASE_NAME', 'tempestas'),
        // Built into Postgres 13+, so no extension is required.
        uuidExtension: 'pgcrypto' as const,
        // Never true. Schema changes go through reviewed migrations only.
        synchronize: false,
        logging: config.get<string>('NODE_ENV') === 'development',
        // Explicit list, not globs: a webpack bundle has no directory to scan.
        entities: [ZoneEntity, NodeEntity, DeviceEntity, SensorReadingEntity],
      }),
    }),
    ScheduleModule.forRoot(),
    // Protects against a runaway client loop, which is the failure that
    // actually happens on a home LAN - not an adversary.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }]),
    HardwareModule,
    NodesModule,
    DevicesModule,
    ReadingsModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
