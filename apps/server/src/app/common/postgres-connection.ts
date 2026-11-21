export type ReadSetting = (name: string) => string | undefined;

export const readProcessEnvironment: ReadSetting = (name) => process.env[name];

export function postgresConnectionOptions(readSetting: ReadSetting) {
  return {
    type: 'postgres' as const,
    host: readSetting('DATABASE_HOST') ?? '127.0.0.1',
    port: Number(readSetting('DATABASE_PORT') ?? 5432),
    username: readSetting('DATABASE_USER') ?? 'tempestas',
    password: readSetting('DATABASE_PASSWORD') ?? 'tempestas',
    database: readSetting('DATABASE_NAME') ?? 'tempestas',
    // gen_random_uuid() is built into Postgres 13+; uuid_generate_v4() would need uuid-ossp.
    uuidExtension: 'pgcrypto' as const,
    // Never true: schema changes go through reviewed migrations only.
    synchronize: false,
  };
}
