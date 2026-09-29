import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  // rawBody: true expose req.rawBody (Buffer) — nécessaire pour les webhooks signés
  // (Late/Zernio, futur Stripe) où la signature HMAC doit porter sur les octets bruts.
  const app = await NestFactory.create(AppModule, { rawBody: true });
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
