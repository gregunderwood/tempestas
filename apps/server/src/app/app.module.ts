import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ServeStaticModule } from '@nestjs/serve-static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommonModule } from './common/common.module';
import { DevicesModule } from './devices/devices.module';
import { DeviceEntity, PinTransitionEntity } from './devices/models';
import { HardwareModule } from './hardware/hardware.module';
import { NodesModule } from './nodes/nodes.module';
import { NodeEntity } from './nodes/models';
import { ReadingsModule } from './readings/readings.module';
import { RealtimeModule } from './realtime/realtime.module';
import { RulesModule } from './rules/rules.module';
import { SensorReadingEntity } from './readings/models';
import { ZoneEntity } from './zones/models';
import { ZonesModule } from './zones/zones.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['apps/server/.env', '.env'],
    }),
    CommonModule,
    // The Angular bundle, served by the API itself rather than by a reverse
    // proxy. One process on the box, and the socket.io upgrade stays inside
    // Nest - the `map $http_upgrade` mistake sitting in the old greenhouse's
    // nginx.conf cannot be made if there is no proxy.
    //
    // Conditional because the bundle is only present on a deployed box: in dev
    // the Angular dev server serves it and proxies /api here, and registering a
    // static root that does not exist makes every unmatched route a 500 instead
    // of a 404.
    ...staticBundle(),
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
        entities: [
          ZoneEntity,
          NodeEntity,
          DeviceEntity,
          PinTransitionEntity,
          SensorReadingEntity,
        ],
      }),
    }),
    ScheduleModule.forRoot(),
    // Protects against a runaway client loop, which is the failure that
    // actually happens on a home LAN - not an adversary.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }]),
    HardwareModule,
    RealtimeModule,
    NodesModule,
    DevicesModule,
    ReadingsModule,
    RulesModule,
    ZonesModule,
    HealthModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}

/**
 * The built Angular bundle, when there is one next to the server bundle.
 *
 * `exclude` keeps the API and the socket out of the SPA fallback. Without it
 * an unknown /api path returns index.html with a 200, which is exactly the
 * shape of error this project exists to stop producing - a client cannot tell
 * a missing route from a working one.
 */
function staticBundle() {
  const root = join(__dirname, '..', 'web');
  if (!existsSync(root)) {
    return [];
  }
  return [
    ServeStaticModule.forRoot({
      rootPath: root,
      exclude: ['/api/{*path}', '/socket.io/{*path}'],
    }),
  ];
}
