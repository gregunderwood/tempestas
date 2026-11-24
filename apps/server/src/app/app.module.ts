import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ServeStaticModule } from '@nestjs/serve-static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentReleasesModule } from './agent-releases/agent-releases.module';
import { CommonModule } from './common/common.module';
import { postgresConnectionOptions } from './common/postgres-connection';
import { DevicesModule } from './devices/devices.module';
import { DeviceEntity, PinTransitionEntity } from './devices/models';
import { HardwareModule } from './hardware/hardware.module';
import { NodesModule } from './nodes/nodes.module';
import { NodeEntity } from './nodes/models';
import { ReadingsModule } from './readings/readings.module';
import { RealtimeModule } from './realtime/realtime.module';
import { ReportsModule } from './reports/reports.module';
import { RulesModule } from './rules/rules.module';
import { SensorReadingEntity } from './readings/models';
import { ZoneEntity } from './zones/models';
import { ZonesModule } from './zones/zones.module';
import { HealthModule } from './health/health.module';

const WEB_BUNDLE_DIRECTORY = join(__dirname, '..', 'web');

// Sized for a runaway client loop, the failure that actually happens on a home LAN.
const RUNAWAY_CLIENT_LIMIT = { ttl: 60_000, limit: 300 };

// Listed rather than globbed: a webpack bundle has no directory to scan.
const ENTITIES = [
  ZoneEntity,
  NodeEntity,
  DeviceEntity,
  PinTransitionEntity,
  SensorReadingEntity,
];

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['apps/server/.env', '.env'],
    }),
    CommonModule,
    ...serveWebBundleWhenBuilt(),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        ...postgresConnectionOptions((name) => config.get<string>(name)),
        logging: config.get<string>('NODE_ENV') === 'development',
        entities: ENTITIES,
      }),
    }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([RUNAWAY_CLIENT_LIMIT]),
    HardwareModule,
    RealtimeModule,
    NodesModule,
    DevicesModule,
    ReadingsModule,
    ReportsModule,
    RulesModule,
    ZonesModule,
    HealthModule,
    AgentReleasesModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}

// Only a deployed box has the bundle; a static root that does not exist turns every 404 into a 500.
function serveWebBundleWhenBuilt() {
  if (!existsSync(WEB_BUNDLE_DIRECTORY)) {
    return [];
  }
  return [
    ServeStaticModule.forRoot({
      rootPath: WEB_BUNDLE_DIRECTORY,
      exclude: ['/api/{*path}', '/socket.io/{*path}'],
    }),
  ];
}
