import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { json } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { loadEnv } from './config/env.js';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule, {
    logger: ['log', 'error', 'warn', 'debug'],
  });

  app.use(helmet());
  app.enableCors({ origin: env.API_CORS_ORIGIN, credentials: true });
  // Phase E — raise JSON body limit so Postmark inbound payloads with
  // base64-inflated 50 MB attachments fit (default Express limit is
  // 100 KB). Multer is used for partner intake's multipart so this only
  // affects the email webhook.
  app.use(json({ limit: '60mb' }));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  // Tokenised gathering links live at the unprefixed /g/:token namespace
  // (design doc §4.5). Phase E adds /partner-intake/:token + the Postmark
  // /webhooks/email-inbound webhook — both also need clean URLs.
  app.setGlobalPrefix('api/v1', {
    exclude: ['/g/(.*)', '/partner-intake/(.*)', '/webhooks/(.*)'],
  });

  await app.listen(env.API_PORT);
  Logger.log(`Rhud API listening on :${env.API_PORT}`, 'Bootstrap');
}

bootstrap().catch((err) => {
  console.error('Fatal boot error', err);
  process.exit(1);
});
