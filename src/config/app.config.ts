import { registerAs } from '@nestjs/config';

/**
 * Port direct des constantes lues dans backend/config.py.
 * Règle à garder : ne jamais relire process.env ailleurs que dans ce fichier
 * (même discipline que « Never re-read env vars outside config.py » côté Python).
 */
const FALLBACK_JWT_SECRET_INTERDIT = 'your-secret-key-change-in-production';

export default registerAs('app', () => {
  const jwtSecret = process.env.JWT_SECRET;
  // Pas de fallback silencieux ici : un secret de signature connu (même resté dans un
  // vieux commit) permettrait de forger n'importe quel JWT, y compris admin. Signalé par
  // le scan Strix du 2026-09-28 (VULN : "Default JWT secret fallback") — mieux vaut un
  // crash au démarrage qu'une compromission silencieuse en production.
  if (!jwtSecret || jwtSecret === FALLBACK_JWT_SECRET_INTERDIT) {
    throw new Error(
      'JWT_SECRET manquant ou égal à la valeur par défaut interdite — définis une valeur ' +
        'aléatoire forte (ex. `openssl rand -hex 32`) avant de démarrer l\'application.',
    );
  }
  return {
    jwtSecret,
  // Durée de session admin, en heures. 8h côté mémoire/tests — le fallback Python (24*7)
  // n'est qu'un défaut jamais réellement utilisé (l'env var le fixe à 8 en prod comme en tests).
  adminSessionHeures: parseInt(process.env.ADMIN_SESSION_HEURES || '8', 10),
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
  backendUrl: (process.env.BACKEND_URL || 'http://localhost:3000').replace(/\/$/, ''),
  resendApiKey: process.env.RESEND_API_KEY || '',
  resendFrom: process.env.RESEND_FROM || 'Postorico <onboarding@resend.dev>',
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  claudeApiKey: process.env.api_claude || process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY || '',
  claudeModel: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
  openaiApiKey: process.env.OPENAI_API_KEY || process.env.OPENS_API || '',
  embeddingModel: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
  memoireVoixActive: process.env.MEMOIRE_VOIX_ACTIVE !== '0',
  cloudinaryCloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
  cloudinaryApiKey: process.env.CLOUDINARY_API_KEY || '',
  cloudinaryApiSecret: process.env.CLOUDINARY_API_SECRET || '',
  // Optionnel : force le binaire Chromium utilisé par Playwright (carrousels). Utile en
  // dev quand `npx playwright install` n'a pas pu tourner (offline, réseau lent) — laisse
  // vide en production, où le binaire géré par Playwright doit être installé normalement.
  chromiumExecutablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '',
  openrouterApiKey: process.env.OPENROUTER_API_KEY || process.env.api_openrouter || process.env.API_OPENROUTER || '',
  openrouterImageModel: process.env.OPENROUTER_IMAGE_MODEL || 'google/gemini-2.5-flash-image',
  openrouterVideoModel: process.env.OPENROUTER_VIDEO_MODEL || 'google/gemini-3.8-flash',
  lateApiKey: process.env.LATE_API_KEY || process.env.api_late || '',
  lateWebhookSecret: process.env.LATE_WEBHOOK_SECRET || '',
  adminNotifEmail: process.env.ADMIN_NOTIF_EMAIL || 'martindumoulin88@gmail.com',
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  stripePricePro: process.env.STRIPE_PRICE_PRO || '',
  stripePriceProUsd: process.env.STRIPE_PRICE_PRO_USD || '',
  stripePriceBusiness: process.env.STRIPE_PRICE_BUSINESS || '',
  stripePricePackEur: process.env.STRIPE_PRICE_PACK_EUR || '',
  stripePricePackUsd: process.env.STRIPE_PRICE_PACK_USD || '',
  // false en local pour tester le paiement (compte Stripe test sans adresse de siège).
  stripeAutoTax: (process.env.STRIPE_AUTO_TAX || 'true').trim().toLowerCase() !== 'false' && (process.env.STRIPE_AUTO_TAX || 'true').trim().toLowerCase() !== '0' && (process.env.STRIPE_AUTO_TAX || 'true').trim().toLowerCase() !== 'no',
  // Parcours 1 (Pack Fondations) : délai avant que l'abonnement démarre tout seul si
  // personne ne l'a déclenché manuellement. 0 désactive le filet.
  packDelaiJours: parseInt(process.env.PACK_DELAI_JOURS || '14', 10),
  // Simples indicateurs de présence pour le panneau admin « Système » — ces intégrations
  // elles-mêmes (HeyGen, solde Anthropic) ne sont pas portées.
  heygenApiKey: process.env.HEYGEN_API_KEY || '',
  anthropicAdminKey: process.env.ANTHROPIC_ADMIN_KEY || '',
  posthogApiKey: process.env.POSTHOG_API_KEY || '',
  analyticsCronHeures: parseInt(process.env.ANALYTICS_CRON_HOURS || '1', 10),
  // Rendu Remotion (reels, stories animées) — voir modules/remotion/remotion.service.ts.
  // REMOTION_RENDER_URL configuré : appelle le service Node persistant (backend/remotion/server,
  // bundle une seule fois) au lieu de `npx remotion render` en subprocess (2-3x plus rapide).
  remotionDir: process.env.REMOTION_DIR || '',
  remotionBrowser: process.env.REMOTION_BROWSER || '',
  remotionRenderUrl: (process.env.REMOTION_RENDER_URL || '').replace(/\/$/, ''),
  remotionCrf: parseInt(process.env.REMOTION_CRF || '23', 10),
  remotionCoutMinuteUsd: parseFloat(process.env.REMOTION_COUT_MINUTE_USD || '0.0014'),
  remotionRendusSimultanes: parseInt(process.env.REMOTION_RENDUS_SIMULTANES || '2', 10),
  remotionAttenteMaxS: parseInt(process.env.REMOTION_ATTENTE_MAX_S || '150', 10),
  elevenlabsApiKey: process.env.ELEVENLABS_API_KEY || '',
  // Studio Vidéo (montage IA) : service self-hosted "submagic-poc" (Railway séparé),
  // remplace Submagic (payant) — voir modules/video/montage-poc.service.ts.
  montagePocUrl: (process.env.MONTAGE_POC_URL || '').replace(/\/$/, ''),
  montagePocInternalKey: process.env.MONTAGE_POC_INTERNAL_KEY || '',
  // Push (Firebase Cloud Messaging, API HTTP v1) — voir modules/notifications/push.service.ts.
  // Compte de service au format JSON, en base64 (env la plus simple à coller telle quelle)
  // ou brut ; absent -> push silencieusement désactivé (l'app marche sans).
  firebaseServiceAccountB64: process.env.FIREBASE_SERVICE_ACCOUNT_B64 || '',
  firebaseServiceAccount: process.env.FIREBASE_SERVICE_ACCOUNT || '',
  // Cloudflare Turnstile (anti-bot, formulaire public /audit-marque) — voir modules/turnstile.
  turnstileSecretKey: process.env.TURNSTILE_SECRET_KEY || '',
  // Newsletter hebdomadaire « La lettre de Rico » — voir modules/newsletter.
  // NEWSLETTER_CRON_ACTIVE=0 sur le backend dev (sinon dev et prod préparent/envoient chacun leur édition).
  newsletterCronActive: (process.env.NEWSLETTER_CRON_ACTIVE || '1') !== '0',
  // Cron impayés (une passe par jour, 6 h Europe/Paris) — même interrupteur que le Python
  // (IMPAYES_CRON_ACTIVE=0 pour le couper, ex. sur une instance de test).
  impayesCronActive: (process.env.IMPAYES_CRON_ACTIVE || '1') !== '0',
  // Worker de rendu Remotion (reels, stories animées) — même interrupteur que le Python
  // (RENDER_WORKER_ACTIVE=0 : cette instance ne réclame aucun job de la file partagée).
  renderWorkerActive: (process.env.RENDER_WORKER_ACTIVE || '1') !== '0',
  // Rattrapage des publications (toutes les 10 min) : PUBLISH_SWEEP_ACTIVE=0 pour le couper sur
  // cette instance tant qu'un autre backend (le Python en prod) le fait déjà — sinon un même
  // contenu peut être poussé deux fois chez Zernio.
  publishSweepActive: (process.env.PUBLISH_SWEEP_ACTIVE || '1') !== '0',
  newsletterPerplexityModel: process.env.NEWSLETTER_PERPLEXITY_MODEL || 'perplexity/sonar-pro',
  newsletterJour: parseInt(process.env.NEWSLETTER_JOUR || '1', 10), // 0=lundi … 6=dimanche (défaut mardi)
  newsletterHeure: parseInt(process.env.NEWSLETTER_HEURE || '9', 10),
  newsletterTz: process.env.NEWSLETTER_TZ || 'Europe/Paris',
  };
});
