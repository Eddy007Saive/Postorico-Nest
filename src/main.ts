import './instrument';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { SentryGlobalFilter } from '@sentry/nestjs/setup';
import { AppModule } from './app.module';
import { LoggerSilencieux, niveauxLog } from './common/logger-silencieux';
import { origineAcceptee, originesAutorisees } from './common/utils/cors.util';
import { contexteIa, routeGenerique } from './common/contexte-ia';

async function bootstrap() {
  // rawBody: true expose req.rawBody (Buffer) — nécessaire pour les webhooks signés
  // (Late/Zernio, futur Stripe) où la signature HMAC doit porter sur les octets bruts.
  // Logger qui tait les ~330 lignes « Mapped {route} » / « dependencies initialized » du
  // démarrage : au-delà du plafond de logs de Railway, qui jetait les lignes suivantes.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    logger: new LoggerSilencieux('Nest', { logLevels: niveauxLog() }),
  });
  // Même préfixe que le backend Python (APIRouter(prefix="/api")) : le frontend construit
  // toujours ses appels en REACT_APP_BACKEND_URL + /api (lib/api.js), quel que soit le backend.
  // Éditeur de carrousel : jusqu'à 10 slides exportées en JPEG (data URL) dans une requête
  app.useBodyParser('json', { limit: '40mb' });
  // Suivi des coûts IA : chaque requête porte son contexte (client, action), complété par JwtAuthGuard
  app.use((req: { method: string; originalUrl: string }, _res: unknown, next: () => void) =>
    contexteIa.run({ telegramId: null, action: routeGenerique(req.method, req.originalUrl) }, next),
  );
  app.setGlobalPrefix('api');
  // Sans effet si Sentry est inactif (pas de SENTRY_DSN) : le filtre ne fait que relayer.
  // L'adaptateur HTTP est requis : sans lui, BaseExceptionFilter plante sur toute erreur
  // (this.applicationRef resterait undefined).
  app.useGlobalFilters(new SentryGlobalFilter(app.getHttpAdapter()));
  // whitelist: rejette les champs non déclarés dans le DTO — équivalent de Pydantic qui
  // ignore silencieusement les extra sauf configuration contraire ; ici on préfère strict.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  const config = app.get(ConfigService);
  const autorisees = originesAutorisees(
    config.get<string>('app.corsOrigins') || '',
    config.get<string>('app.frontendUrl') || '',
  );
  if (!autorisees.size)
    Logger.warn(
      'CORS_ORIGINS vide : l’API accepte les appels de tous les sites.',
      'Cors',
    );
  app.enableCors({
    origin: (origin, rappel) =>
      rappel(null, origineAcceptee(origin, autorisees)),
  });
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
