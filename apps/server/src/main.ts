import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import { runMigrationCommand } from './migrate';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');

  // lvcc installs class-validator and never wires this up, so its DTOs are
  // decorative. Here it is global, strips unknown keys, and rejects them.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Non-negotiable on this system: on SIGTERM we must publish the server's LWT
  // and disconnect MQTT cleanly so every node's dead-man fires deterministically
  // rather than after a keepalive timeout.
  app.enableShutdownHooks();

  app.enableCors({
    origin: [
      /^http:\/\/localhost:\d+$/,
      /^http:\/\/192\.168\.\d+\.\d+(:\d+)?$/,
    ],
    credentials: true,
  });

  // 7000 mirrors the reference stack; the old Flask app used 5000, so both can
  // run side by side during the transition.
  const port = process.env.PORT || 7000;
  await app.listen(port);
  Logger.log(`tempestas API listening on http://localhost:${port}/api`);
}

/**
 * `main.js migrate:run` applies migrations and exits without starting the API.
 *
 * Shipped in the same artifact because the TypeORM CLI needs the TypeScript
 * source and the whole devDependency tree, which is not something to install on
 * the box that runs the burner. Never automatic - deployment restarts the
 * service, and a schema change is a separate deliberate command.
 */
const [, , command] = process.argv;
if (command?.startsWith('migrate:')) {
  void runMigrationCommand(command.slice('migrate:'.length))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      Logger.error(`Migration failed: ${String(err)}`);
      process.exit(1);
    });
} else {
  bootstrap();
}
