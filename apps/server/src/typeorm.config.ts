import { config } from 'dotenv';
import { join } from 'path';
import { DataSource } from 'typeorm';
import {
  postgresConnectionOptions,
  readProcessEnvironment,
} from './app/common/postgres-connection';

// Loaded for the TypeORM CLI only. The running app uses @nestjs/config.
config({ path: join(__dirname, '../.env') });

export default new DataSource({
  ...postgresConnectionOptions(readProcessEnvironment),
  logging: process.env['NODE_ENV'] === 'development',
  entities: [join(__dirname, 'app/**/models{.ts,.js}')],
  // Timestamped files only: `**/*` also matches the migrations/index.ts barrel and loads each twice.
  migrations: [join(__dirname, 'migrations/[0-9]*{.ts,.js}')],
});
