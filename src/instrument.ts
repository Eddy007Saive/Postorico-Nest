/**
 * Sentry : alertes sur les erreurs du serveur — port de backend/services/suivi_erreurs.py.
 * Importé EN PREMIER dans main.ts (Sentry instrumente les modules au chargement).
 * Inactif tant que SENTRY_DSN n'est pas posé. Ni corps de requête (designs, images, contenus),
 * ni IP, ni en-têtes d'authentification ; les erreurs HTTP attendues (4xx) ne remontent pas.
 */
import * as Sentry from '@sentry/nestjs';

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENV || 'production',
    integrations: [Sentry.httpIntegration({ maxRequestBodySize: 'none' })], // jamais les corps de requête
    tracesSampleRate: 0, // erreurs seulement
  });
}
