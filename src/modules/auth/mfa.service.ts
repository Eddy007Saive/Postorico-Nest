import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as crypto from 'crypto';
import { PrismaService } from '../../config/prisma.service';
import { AuthService } from './auth.service';

/**
 * Double vérification à la connexion (code par email) — port direct de
 * backend/services/mfa_service.py.
 *
 * Règle : le mot de passe suffit sur un appareil déjà connu ; sur un appareil inconnu,
 * un code à 6 chiffres envoyé par email est demandé, et l'utilisateur peut marquer
 * l'appareil « de confiance » pour 30 jours. Un administrateur donne toujours le code,
 * y compris via la connexion Google (AuthController.google() route vers demanderCode()
 * pour tout compte is_admin, exactement comme /auth/admin-login).
 *
 * Mécanique : le login renvoie un jeton d'ATTENTE (JWT type=mfa, 10 min) au lieu d'une
 * session ; le code est haché en base (jamais en clair), 5 essais, un seul code vivant
 * à la fois, un renvoi par minute. L'appareil de confiance est un secret aléatoire gardé
 * par le navigateur ; on n'en stocke que le hash.
 */
const VALIDITE_CODE_MIN = 10;
const ESSAIS_MAX = 5;
const RENVOI_S = 60;
const CONFIANCE_JOURS = 30;

interface MfaJwtPayload {
  telegram_id: string;
  type: 'mfa';
  exp?: number;
}

@Injectable()
export class MfaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly authService: AuthService,
  ) {}

  private hash(valeur: string): string {
    const secret = this.config.get<string>('app.jwtSecret');
    return crypto.createHash('sha256').update(`${secret}:${valeur}`).digest('hex');
  }

  /** m***n@gmail.com : assez pour reconnaître sa boîte, pas assez pour la donner. */
  masquerEmail(email: string): string {
    try {
      const [nom, dom] = email.split('@');
      if (!dom) throw new Error('pas d\'arobase');
      if (nom.length <= 2) return `${nom[0]}***@${dom}`;
      return `${nom[0]}***${nom[nom.length - 1]}@${dom}`;
    } catch {
      return '***';
    }
  }

  // ------------------------------------------------------------------ appareils
  async appareilValide(telegramId: string, jeton?: string | null): Promise<boolean> {
    if (!jeton || jeton.length < 20) return false;
    const row = await this.prisma.appareils_confiance.findUnique({
      where: { jeton_hash: this.hash(jeton) },
      select: { id: true, telegram_id: true, expire_le: true },
    });
    if (!row || row.telegram_id !== telegramId) return false;
    if (row.expire_le < new Date()) return false;
    await this.prisma.appareils_confiance
      .update({ where: { id: row.id }, data: { vu_le: new Date() } })
      .catch(() => undefined); // best-effort, comme le Python
    return true;
  }

  /** Enregistre un appareil de confiance et renvoie le secret à garder côté navigateur. */
  async creerAppareil(telegramId: string, libelle?: string | null, ip?: string | null): Promise<string> {
    const jeton = crypto.randomBytes(32).toString('base64url');
    await this.prisma.appareils_confiance.create({
      data: {
        telegram_id: telegramId,
        jeton_hash: this.hash(jeton),
        libelle: libelle ? libelle.slice(0, 160) : null,
        ip: ip ? ip.slice(0, 64) : null,
        expire_le: new Date(Date.now() + CONFIANCE_JOURS * 24 * 60 * 60 * 1000),
      },
    });
    return jeton;
  }

  /** Au changement de mot de passe : tous les appareils redeviennent inconnus. */
  async oublierAppareils(telegramId: string): Promise<void> {
    await this.prisma.appareils_confiance.deleteMany({ where: { telegram_id: telegramId } }).catch(() => undefined);
  }

  exigeCode(user: { is_admin: boolean | null }, appareilConnu: boolean): boolean {
    if (user.is_admin) return true;
    return !appareilConnu;
  }

  // ------------------------------------------------------------------ codes
  jetonAttente(telegramId: string): string {
    return this.jwt.sign(
      { telegram_id: telegramId, type: 'mfa' } satisfies Omit<MfaJwtPayload, 'exp'>,
      { expiresIn: `${VALIDITE_CODE_MIN}m` },
    );
  }

  lireAttente(jeton: string): string {
    let payload: MfaJwtPayload;
    try {
      payload = this.jwt.verify<MfaJwtPayload>(jeton);
    } catch (e: unknown) {
      const expired = e instanceof Error && e.name === 'TokenExpiredError';
      throw new Error(expired ? 'code_expire' : 'jeton_invalide');
    }
    if (payload.type !== 'mfa' || !payload.telegram_id) {
      throw new Error('jeton_invalide');
    }
    return payload.telegram_id;
  }

  /** Un nouveau code (les précédents meurent). null si le dernier a moins d'une minute. */
  async creerCode(telegramId: string): Promise<string | null> {
    const dernier = await this.prisma.codes_connexion.findFirst({
      where: { telegram_id: telegramId, utilise_le: null },
      orderBy: { created_at: 'desc' },
      select: { created_at: true },
    });
    if (dernier && (Date.now() - dernier.created_at.getTime()) / 1000 < RENVOI_S) {
      return null;
    }
    await this.prisma.codes_connexion.deleteMany({ where: { telegram_id: telegramId, utilise_le: null } });
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    await this.prisma.codes_connexion.create({
      data: {
        telegram_id: telegramId,
        code_hash: this.hash(code),
        expire_le: new Date(Date.now() + VALIDITE_CODE_MIN * 60 * 1000),
      },
    });
    return code;
  }

  async renvoyer(jeton: string): Promise<string | null> {
    return this.creerCode(this.lireAttente(jeton));
  }

  /** Valide le code et ouvre la session. Lève : code_expire, code_faux, trop_essais, jeton_invalide. */
  async verifier(
    jeton: string,
    codeSaisi: string,
    confiance = false,
    libelle?: string | null,
    ip?: string | null,
  ) {
    const tid = this.lireAttente(jeton);
    const code = (codeSaisi || '').replace(/\D/g, '');

    const row = await this.prisma.codes_connexion.findFirst({
      where: { telegram_id: tid, utilise_le: null },
      orderBy: { created_at: 'desc' },
    });
    if (!row) throw new Error('code_expire');
    if (row.expire_le < new Date()) throw new Error('code_expire');
    if (row.tentatives >= ESSAIS_MAX) throw new Error('trop_essais');

    if (code.length !== 6 || !crypto.timingSafeEqual(Buffer.from(this.hash(code)), Buffer.from(row.code_hash))) {
      const tentatives = row.tentatives + 1;
      await this.prisma.codes_connexion.update({ where: { id: row.id }, data: { tentatives } });
      if (tentatives >= ESSAIS_MAX) throw new Error('trop_essais');
      throw new Error('code_faux');
    }

    await this.prisma.codes_connexion.update({ where: { id: row.id }, data: { utilise_le: new Date() } });

    const user = await this.prisma.users.findUnique({ where: { telegram_id: tid } });
    if (!user) throw new Error('jeton_invalide');

    const session = await this.authService.sessionFromUser(user);
    if (confiance && !user.is_admin) {
      try {
        (session as Record<string, unknown>).appareil = await this.creerAppareil(tid, libelle, ip);
      } catch {
        // best-effort, comme le Python — un échec ici ne casse pas la connexion
      }
    }
    return session;
  }
}
