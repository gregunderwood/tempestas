import { config } from 'dotenv';
import { join } from 'path';
import { DataSource } from 'typeorm';

// Loaded for the TypeORM CLI only. The running app uses @nestjs/config.
config({ path: join(__dirname, '../.env') });

/**
 * Standalone DataSource for the migration CLI. Kept separate from the app's
 * TypeOrmModule config (which uses an explicit entity array) because the CLI
 * needs globs to discover entities without booting Nest.
 */
export default new DataSource({
  type: 'postgres',
  host: process.env['DATABASE_HOST'] ?? '127.0.0.1',
  port: Number(process.env['DATABASE_PORT'] ?? 5432),
  username: process.env['DATABASE_USER'] ?? 'tempestas',
  password: process.env['DATABASE_PASSWORD'] ?? 'tempestas',
  database: process.env['DATABASE_NAME'] ?? 'tempestas',
  // Emits gen_random_uuid(), built into Postgres 13+, rather than
  // uuid_generate_v4(), which would require the uuid-ossp extension.
  uuidExtension: 'pgcrypto',
  // Never true. Schema changes go through reviewed migrations.
  synchronize: false,
  logging: process.env['NODE_ENV'] === 'development',
  entities: [join(__dirname, 'app/**/models{.ts,.js}')],
  // Only the timestamped files. A plain `**/*` also matches `migrations/index.ts`,
  // the barrel the bundled runner needs, and every migration is then seen twice:
  // "Duplicate migrations: ...".
  migrations: [join(__dirname, 'migrations/[0-9]*{.ts,.js}')],
});
