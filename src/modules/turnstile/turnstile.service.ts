import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Vérification Cloudflare Turnstile (anti-bot) pour le formulaire public.
 * Port direct de backend/services/turnstile_service.py. */
@Injectable()
export class TurnstileService {
  private readonly logger = new Logger(TurnstileService.name);
  private readonly VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

  constructor(private readonly config: ConfigService) {}

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