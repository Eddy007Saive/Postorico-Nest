import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { LoggerSilencieux, niveauxLog } from './common/logger-silencieux';

async function bootstrap() {
  // rawBody: true expose req.rawBody (Buffer) — nécessaire pour les webhooks signés
  // (Late/Zernio, futur Stripe) où la signature HMAC doit porter sur les octets bruts.
  // Logger qui tait les ~330 lignes « Mapped {route} » / « dependencies initialized » du
  // démarrage : au-delà du plafond de logs de Railway, qui jetait les lignes suivantes.
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
    logger: new LoggerSilencieux('Nest', { logLevels: niveauxLog() }),
  });
  // Même préfixe que le backend Python (APIRouter(prefix="/api")) : le frontend construit
  // toujours ses appels en REACT_APP_BACKEND_URL + /api (lib/api.js), quel que soit le backend.
  app.setGlobalPrefix('api');
  // whitelist: rejette les champs non déclarés dans le DTO — équivalent de Pydantic qui
  // ignore silencieusement les extra sauf configuration contraire ; ici on préfère strict.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableCors();
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
