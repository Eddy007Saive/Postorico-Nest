import * as jwt from 'jsonwebtoken';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../config/prisma.service';

/**
 * Notifications push via Firebase Cloud Messaging (API HTTP v1) — port direct de
 * backend/services/push_service.py. Auth par compte de service (JWT-bearer OAuth2,
 * RFC 7523) : on signe un JWT court avec la clé privée RS256 du compte de service et on
 * l'échange contre un jeton d'accès auprès de Google, sans dépendance Google supplémentaire
 * (jsonwebtoken suffit, déjà présent via @nestjs/jwt). Si non configuré -> no-op (l'app
 * marche sans push).
 *
 * Contrairement à Python, pas de repli sur un fichier JSON local
 * (backend/firebase-service-account.json) : seules les variables d'environnement sont
 * lues, cohérent avec « pas de secret en fichier » du reste du portage.
 */

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

interface ServiceAccountInfo {
  project_id: string;
  client_email: string;
  private_key: string;
}

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private info: ServiceAccountInfo | null | undefined; // undefined = pas encore chargé
  private accessToken: string | null = null;
  private accessTokenExp = 0; // epoch ms

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.info = this.chargerInfo(config);
  }

  private chargerInfo(config: ConfigService): ServiceAccountInfo | null {
    try {
      const b64 = config.get<string>('app.firebaseServiceAccountB64');
      const raw = config.get<string>('app.firebaseServiceAccount');
      let jsonTexte: string | null = null;
      if (b64) {
        jsonTexte = Buffer.from(b64, 'base64').toString('utf-8');
      } else if (raw) {
        let r = raw.trim();
        // tolère une valeur entourée de guillemets
        if (r.length >= 2 && r[0] === '"' && r[r.length - 1] === '"') r = r.slice(1, -1);
        jsonTexte = r;
      } else {
        this.logger.log('Push FCM non configuré (pas de service account) — push désactivé');
        return null;
      }
      let info: ServiceAccountInfo;
      try {
        info = JSON.parse(jsonTexte) as ServiceAccountInfo;
      } catch {
        // private_key avec de vrais retours à la ligne -> on les ré-échappe en \n
        const fixed = jsonTexte.replace(/(-----BEGIN [^-]+-----)([\s\S]*?)(-----END [^-]+-----)/, (_m, a: string, b: string, c: string) => a + b.replace(/\n/g, '\\n') + c);
        info = JSON.parse(fixed) as ServiceAccountInfo;
      }
      if (!info.project_id || !info.client_email || !info.private_key) return null;
      return info;
    } catch (e) {
      this.logger.warn(`Push FCM init error: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  /** Vrai si un compte de service Firebase valide a pu être chargé (panneau admin « Système »). */
  estConfigure(): boolean {
    return Boolean(this.info);
  }

  private async accessTokenValide(): Promise<string | null> {
    if (!this.info) return null;
    if (this.accessToken && Date.now() < this.accessTokenExp - 60_000) return this.accessToken;
    const now = Math.floor(Date.now() / 1000);
    const assertion = jwt.sign(
      { iss: this.info.client_email, scope: FCM_SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 },
      this.info.private_key,
      { algorithm: 'RS256' },
    );
    try {
      const resp = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) {
        this.logger.warn(`Push FCM token error: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
        return null;
      }
      const d = (await resp.json()) as { access_token: string; expires_in: number };
      this.accessToken = d.access_token;
      this.accessTokenExp = Date.now() + d.expires_in * 1000;
      return this.accessToken;
    } catch (e) {
      this.logger.warn(`Push FCM token error: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  /** Envoie un push à tous les appareils de l'utilisateur. Best-effort, jamais bloquant.
   * Retourne vrai si au moins un envoi a réussi (utilisé par le diffuseur admin pour
   * compter les envois réels — le port Python correspondant ne renvoie jamais rien, ce
   * qui laissait `broadcast_push` afficher "0 envoyés" en toutes circonstances). */
  async sendToUser(telegramId: string, title: string, body: string, data?: Record<string, unknown>): Promise<boolean> {
    const token = await this.accessTokenValide();
    if (!token || !this.info) return false;
    let deviceTokens: string[];
    try {
      const rows = await this.prisma.device_tokens.findMany({ where: { telegram_id: telegramId }, select: { token: true } });
      deviceTokens = rows.map((r) => r.token).filter(Boolean);
    } catch (e) {
      this.logger.warn(`Push: lecture device_tokens: ${e instanceof Error ? e.message : e}`);
      return false;
    }
    if (!deviceTokens.length) return false;

    let uneReussite = false;
    const url = `https://fcm.googleapis.com/v1/projects/${this.info.project_id}/messages:send`;
    const payloadData = Object.fromEntries(Object.entries(data || {}).map(([k, v]) => [k, String(v)]));
    for (const tk of deviceTokens) {
      const msg = {
        message: {
          token: tk,
          notification: { title, body },
          data: payloadData,
          android: { priority: 'high', notification: { sound: 'default', channel_id: 'presence_default', default_sound: true } },
        },
      };
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(msg),
          signal: AbortSignal.timeout(15_000),
        });
        if (resp.ok) {
          uneReussite = true;
        } else {
          const txt = (await resp.text()).toLowerCase();
          if (resp.status === 404 || txt.includes('unregistered') || txt.includes('not-registered') || txt.includes('invalid-argument')) {
            // token mort -> on le purge
            await this.prisma.device_tokens.deleteMany({ where: { token: tk } });
          } else {
            this.logger.warn(`FCM send ${resp.status}: ${txt.slice(0, 200)}`);
          }
        }
      } catch (e) {
        this.logger.warn(`FCM send error: ${e instanceof Error ? e.message : e}`);
      }
    }
    return uneReussite;
  }
}
