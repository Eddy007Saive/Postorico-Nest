import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Vérification Cloudflare Turnstile (anti-bot) pour le formulaire public.
 * Port direct de backend/services/turnstile_service.py. */
@Injectable()
export class TurnstileService implements OnModuleInit {
  private readonly logger = new Logger(TurnstileService.name);
  private readonly VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

  constructor(private readonly config: ConfigService) {}

  /** Clé secrète de TEST Cloudflare (« toujours valide ») — developers.cloudflare.com/turnstile/troubleshooting/testing */
  static readonly CLE_TEST = '1x0000000000000000000000000000000AA';

  /** Vrai si Turnstile laisse tout passer (clé absente ou clé de test). */
  get enModeTest(): boolean {
    const cle = (this.config.get<string>('app.turnstileSecretKey') || '').trim();
    return !cle || cle === TurnstileService.CLE_TEST;
  }

  onModuleInit() {
    if (this.enModeTest) {
      this.logger.warn(
        'Turnstile en MODE TEST (TURNSTILE_SECRET_KEY absente ou clé de test Cloudflare) : la vérification ' +
          "anti-robot laisse TOUT passer sur /onboarding/audit et /onboarding/analyser-site. Poser la vraie clé avant l'ouverture publique.",
      );
    }
  }

  /** Retourne true si le token Turnstile est valide.
   * Sans secret configuré, on laisse passer (dev). Avec secret, un token vide/faux échoue. */
  async verify(token: string, remoteIp = ''): Promise<boolean> {
    const secretKey = this.config.get<string>('app.turnstileSecretKey');
    if (!secretKey) return true;
    if (!token) return false;

    const data: Record<string, string> = { secret: secretKey, response: token };
    if (remoteIp) data.remoteip = remoteIp;

    try {
      const resp = await fetch(this.VERIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(data).toString(),
      });
      const j = (await resp.json()) as { success?: boolean };
      return j.success === true;
    } catch (e) {
      this.logger.warn(`turnstile verify: ${e instanceof Error ? e.message : e}`);
      return false;
    }
  }
}