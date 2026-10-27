// Doit rester le tout premier import de main.ts (avant NestFactory, avant AppModule) :
// l'instrumentation automatique de Sentry (HTTP, Prisma…) doit patcher les modules avant
// qu'ils ne soient chargés ailleurs dans l'appli. Inactif sans SENTRY_DSN, comme le frontend.
//
// À ce stade, ConfigModule n'a pas encore tourné (il ne charge .env qu'à l'instanciation de
// NestFactory, plus tard) : on lit .env nous-mêmes ici. Sans effet en prod où les variables
// sont déjà de vraies variables d'environnement (Railway) — dotenv ne les écrase jamais.
import { config as chargerEnv } from 'dotenv';
import * as Sentry from '@sentry/nestjs';

chargerEnv();

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENV || process.env.NODE_ENV || 'production',
    tracesSampleRate: 0, // erreurs seulement, comme côté frontend
  });
}
