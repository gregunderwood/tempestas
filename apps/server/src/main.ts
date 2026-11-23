import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import { API_PREFIX } from './app/common/api-prefix';
import { LAN_ORIGINS } from './app/common/lan-origins';
import { runMigrationCommand } from './migrate';

// The old Flask app used 5000, so both can run side by side during the transition.
const DEFAULT_PORT = 7000;
const MIGRATION_COMMAND_PREFIX = 'migrate:';
const EXIT_FAILURE = 1;

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix(API_PREFIX);
  enforceDtoValidation(app);
  // On SIGTERM the server publishes its offline status and disconnects, so every node's dead-man fires at once.
  app.enableShutdownHooks();
  app.enableCors({ origin: LAN_ORIGINS, credentials: true });

  const port = process.env.PORT || DEFAULT_PORT;
  await app.listen(port);
  Logger.log(
    `tempestas API listening on http://localhost:${port}/${API_PREFIX}`,
  );
}

function enforceDtoValidation(app: INestApplication): void {
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
}

function runMigrationAndExit(command: string): void {
  void runMigrationCommand(command.slice(MIGRATION_COMMAND_PREFIX.length))
    .then((exitCode) => process.exit(exitCode))
    .catch((error: unknown) => {
      Logger.error(`Migration failed: ${String(error)}`);
      process.exit(EXIT_FAILURE);
    });
}

const [, , command] = process.argv;
if (command?.startsWith(MIGRATION_COMMAND_PREFIX)) {
  runMigrationAndExit(command);
} else {
  bootstrap();
}
