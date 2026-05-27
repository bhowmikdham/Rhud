import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { loadEnv } from './config/env.js';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule, {
    logger: ['log', 'error', 'warn', 'debug'],
  });

  app.use(helmet());
  // API_CORS_ORIGIN is a comma-separated list — needed because the
  // Outlook add-in lives on addin.rhud.net (separate origin from the
  // web app at rhud.net) and needs to call the API for templates +
  // opportunity creation. NestJS's enableCors() accepts an array of
  // strings natively and echoes the matching origin back on each request.
  const origins = env.API_CORS_ORIGIN
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({ origin: origins, credentials: true });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  // Tokenised gathering links live at the unprefixed /g/:token namespace
  // (design doc §4.5). Everything else is /api/v1.
  app.setGlobalPrefix('api/v1', { exclude: ['/g/(.*)'] });

  await app.listen(env.API_PORT);
  Logger.log(`Rhud API listening on :${env.API_PORT}`, 'Bootstrap');
}

bootstrap().catch((err) => {
  console.error('Fatal boot error', err);
  process.exit(1);
});
