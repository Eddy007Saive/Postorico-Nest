import { ConflictException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { randomBytes, randomUUID } from 'crypto';
import { PrismaService } from '../../config/prisma.service';
import { RegisterDto } from './dto/register.dto';

/** Identité vérifiée auprès de Google — port de _identite_google(). */
interface IdentiteGoogle {
  sub: string;
  email: string;
  nom: string;
  photo?: string;
}

/** Erreur porteuse d'un code stable (email_google_non_verifie, jeton_google_invalide...) —
 * équivalent des `raise ValueError(code)` du Python, que le contrôleur retransmet tel quel. */
export class GoogleAuthError extends Error {}

/** Réclamations portées par le jeton — mêmes clés que backend/services/auth_service.py
 * pour que les deux backends restent interopérables tant que la migration n'est pas finie. */
export interface JwtPayload {
  telegram_id: string;
  email: string;
  is_admin: boolean;
  origine: string;
  fp: string;
  role?: 'admin';
  exp?: number;
  // Présent seulement après une bascule vers un sous-compte (voir AccountsService.switch).
  master_id?: string | null;
}

@Injectable()
export class AuthService {
  // Cache d'empreinte de mot de passe (invalidation de session) — port direct de
  // _fp_cache dans auth_service.py. TTL court : un changement de mdp déconnecte
  // les autres appareils en <= FP_TTL secondes, sans lire la base à chaque requête.
  private readonly FP_TTL_MS = 30_000;
  private fpCache = new Map<string, { fp: string; expiresAt: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, 12); // même facteur de coût que bcrypt.gensalt(rounds=12)
  }

  async verifyPassword(password: string, hashed: string | null): Promise<boolean> {
    // Un compte créé par Google n'a pas de mot de passe.
    if (!password || !hashed) return false;
    try {
      return await bcrypt.compare(password, hashed);
    } catch {
      return false;
    }
  }

  /** Empreinte courte du hash actuel — rend un lien de reset à usage unique (même algo Python : sha256[:16]). */
  private pwdFingerprint(passwordHash: string | null): string {
    return crypto
      .createHash('sha256')
      .update(passwordHash || '')
      .digest('hex')
      .slice(0, 16);
  }

  sanitizeUser<T extends { password_hash?: unknown }>(user: T): Omit<T, 'password_hash'> {
    const { password_hash: _drop, ...rest } = user;
    return rest;
  }

  /** `masterId` : réservé aux appels INTERNES (création d'un sous-compte depuis
   * /accounts) — jamais exposé sur le DTO public /auth/register. */
  async registerUser(dto: RegisterDto, masterId?: string) {
    // `email` n'a pas de contrainte unique en base (vérifié dans le schéma introspecté) —
    // l'unicité est garantie côté applicatif seulement, comme dans le Python d'origine.
    // findFirst, pas findUnique : Prisma exige un champ @unique/@id pour findUnique.
    const existing = await this.prisma.users.findFirst({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException('email_exists');
    }

    const passwordHash = await this.hashPassword(dto.password);
    const telegramId = randomUUID(); // identifiant interne — pas de dépendance Telegram, cf. CLAUDE.md

    const data: Record<string, unknown> = {
      telegram_id: telegramId,
      nom: dto.nom,
      email: dto.email,
      username: dto.username ?? null,
      password_hash: passwordHash,
      actif: true,
      langue: ['fr', 'en', 'es'].includes(dto.langue ?? '') ? dto.langue : 'fr',
      created_at: new Date(),
      ...(masterId ? { master_id: masterId } : {}),
    };
    // Fuseau du navigateur, seulement s'il ressemble à un identifiant IANA (contient "/").
    if (dto.fuseau && dto.fuseau.includes('/') && dto.fuseau.length < 64) {
      data.timezone = dto.fuseau;
    }

    await this.prisma.users.create({ data: data as never });
    await this.creerFicheMarque(telegramId);

    return { telegramId, nom: dto.nom, email: dto.email, passwordHash };
  }

  /** Jeton d'auto-login émis juste après l'inscription — port de
   * `create_token({telegram_id, email, is_admin:false})` côté Python, corrigé suite au
   * scan Strix du 2026-09-28 : l'original ne portait pas `fp` (« pas encore de mot de
   * passe à empreindre » au moment du port), alors que le mot de passe VIENT d'être posé
   * ci-dessus dans registerUser() — l'empreinte est donc disponible et doit être portée,
   * sans quoi ce jeton (7 jours) survivrait à un changement de mot de passe immédiat. */
  issueRegistrationToken(telegramId: string, email: string, passwordHash: string | null): string {
    return this.jwt.sign(
      { telegram_id: telegramId, email, is_admin: false, origine: telegramId, fp: this.pwdFingerprint(passwordHash) },
      { expiresIn: '7d' },
    );
  }

  /** Fiche de marque par défaut à l'inscription — port de marque_service.creer(). Les
   * couleurs/réglages par défaut sont déjà posés comme défauts de colonne côté base
   * (vérifié dans le schéma introspecté), donc un simple upsert (idempotent, comme le
   * Python) suffit sans avoir à les recopier ici. */
  private async creerFicheMarque(telegramId: string): Promise<void> {
    try {
      await this.prisma.marques.upsert({
        where: { telegram_id: telegramId },
        update: {},
        create: { telegram_id: telegramId },
      });
    } catch (e) {
      // Best-effort, comme le Python : un échec ici ne doit jamais faire échouer l'inscription.
      console.error(`création marque ${telegramId}:`, e);
    }
  }

  private buildClaims(user: {
    telegram_id: string;
    email: string | null;
    is_admin: boolean | null;
    password_hash: string | null;
  }): JwtPayload {
    const estAdmin = Boolean(user.is_admin);
    const claims: JwtPayload = {
      telegram_id: user.telegram_id,
      email: user.email ?? '', // toujours renseigné en pratique (requis à l'inscription) ; le
      // schéma le laisse nullable en base, donc on protège le type sans changer le comportement.
      is_admin: estAdmin,
      // « origine » : le compte qui s'est RÉELLEMENT authentifié, ne change jamais même en
      // basculant de marque — porte la qualité d'administrateur (cf. commentaire Python).
      origine: user.telegram_id,
      fp: this.pwdFingerprint(user.password_hash),
    };
    if (estAdmin) claims.role = 'admin';
    return claims;
  }

  private issueToken(claims: JwtPayload, isAdmin: boolean): string {
    const heures = isAdmin ? this.config.get<number>('app.adminSessionHeures')! : 24 * 7;
    return this.jwt.sign(claims, { expiresIn: `${heures}h` });
  }

  /** Vérifie email + mot de passe, renvoie la ligne `users` brute ou null. Ne décide PAS du
   * MFA ni n'émet de jeton — c'est au contrôleur d'orchestrer (évite une dépendance
   * circulaire avec MfaService, qui a lui-même besoin de sessionFromUser). */
  async verifyCredentials(email: string, password: string) {
    const user = await this.prisma.users.findFirst({ where: { email } });
    if (!user || !(await this.verifyPassword(password, user.password_hash))) {
      return null;
    }
    return user;
  }

  /** Le même jeton que loginUser, à partir d'une ligne users déjà authentifiée — port direct
   * de _jeton_session() en Python. Utilisé après un login direct ou après validation MFA. */
  async sessionFromUser(user: {
    telegram_id: string;
    email: string | null;
    is_admin: boolean | null;
    password_hash: string | null;
    actif: boolean | null;
    nom?: string | null;
  }) {
    const estAdmin = Boolean(user.is_admin);
    const claims = this.buildClaims(user);
    const token = this.issueToken(claims, estAdmin);
    return {
      token,
      user: this.sanitizeUser(user),
      is_admin: estAdmin,
      pending: estAdmin ? false : !user.actif,
    };
  }

  async loginUser(email: string, password: string) {
    const user = await this.verifyCredentials(email, password);
    if (!user) return { error: 'invalid' as const };
    return this.sessionFromUser(user);
  }

  async loginAdmin(email: string, password: string) {
    const user = await this.verifyCredentials(email, password);
    if (!user) return { error: 'invalid' as const };
    if (!user.is_admin) return { error: 'not_admin' as const };
    return this.sessionFromUser(user);
  }

  // ------------------------------------------------------------------ Google OAuth
  /** Vérifie un jeton d'accès Google et renvoie son identité. Deux appels à Google :
   * tokeninfo (le jeton est-il bien émis POUR NOTRE client ?) puis userinfo (identité).
   * Port direct de _identite_google() en Python. */
  private async identiteGoogle(accessToken: string): Promise<IdentiteGoogle> {
    const clientId = this.config.get<string>('app.googleClientId');
    if (!clientId) throw new GoogleAuthError('google_indisponible');

    const ti = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`,
    );
    if (ti.status !== 200) throw new GoogleAuthError('jeton_google_invalide');
    const info = (await ti.json()) as { aud?: string; azp?: string };
    if (info.aud !== clientId && info.azp !== clientId) {
      throw new GoogleAuthError('jeton_google_autre_client');
    }

    const ui = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (ui.status !== 200) throw new GoogleAuthError('jeton_google_invalide');
    const u = (await ui.json()) as {
      sub?: string;
      email?: string;
      email_verified?: boolean | string;
      name?: string;
      picture?: string;
    };

    const email = (u.email || '').trim().toLowerCase();
    const verifie = u.email_verified === true || u.email_verified === 'true';
    if (!u.sub || !email || !verifie) throw new GoogleAuthError('email_google_non_verifie');
    return { sub: u.sub, email, nom: (u.name || '').trim(), photo: u.picture };
  }

  /** Vérifie l'identité Google, retrouve ou crée le compte associé. Ne décide PAS du MFA ni
   * n'émet de jeton — comme verifyCredentials(), c'est au contrôleur d'orchestrer, pour que
   * les comptes admin passent par le même code par email que /auth/admin-login (voir
   * mfaService.exigeCode : un administrateur donne TOUJOURS le code). Port de login_google()
   * en Python, corrigé pour ne plus contourner le MFA admin. */
  async loginGoogle(accessToken: string, langue?: string, fuseau?: string) {
    const ident = await this.identiteGoogle(accessToken);

    let user = await this.prisma.users.findFirst({ where: { google_sub: ident.sub } });
    let nouveau = false;

    if (!user) {
      const parEmail = await this.prisma.users.findFirst({ where: { email: ident.email } });
      if (parEmail) {
        user = await this.prisma.users.update({
          where: { telegram_id: parEmail.telegram_id },
          data: { google_sub: ident.sub },
        });
      } else {
        const cree = await this.registerUser({
          nom: ident.nom || ident.email.split('@')[0],
          email: ident.email,
          password: randomBytes(24).toString('base64url'), // compte sans mdp connu, comme le Python
          langue,
          fuseau,
        } as RegisterDto);
        user = await this.prisma.users.update({
          where: { telegram_id: cree.telegramId },
          data: { google_sub: ident.sub, password_hash: null, ...(ident.photo ? { avatar_url: ident.photo } : {}) },
        });
        nouveau = true;
      }
    }

    return { user, nouveau };
  }

  // ------------------------------------------------------------------ Mot de passe oublié
  findUserByEmail(email: string) {
    return this.prisma.users.findFirst({
      where: { email },
      select: { telegram_id: true, email: true, nom: true, username: true, password_hash: true },
    });
  }

  /** Jeton de réinitialisation (1h). Lié au hash courant -> invalide dès que le mdp change. */
  createResetToken(telegramId: string, passwordHash: string | null): string {
    return this.jwt.sign(
      { telegram_id: telegramId, type: 'reset', fp: this.pwdFingerprint(passwordHash) },
      { expiresIn: '1h' },
    );
  }

  async resetPassword(token: string, newPassword: string): Promise<{ success?: true; error?: string }> {
    let payload: { telegram_id?: string; type?: string; fp?: string };
    try {
      payload = this.jwt.verify(token);
    } catch (e: unknown) {
      const expired = e instanceof Error && e.name === 'TokenExpiredError';
      return { error: expired ? 'expired' : 'invalid' };
    }
    if (payload.type !== 'reset' || !payload.telegram_id) return { error: 'invalid' };

    const user = await this.prisma.users.findUnique({
      where: { telegram_id: payload.telegram_id },
      select: { password_hash: true },
    });
    if (!user) return { error: 'invalid' };
    // Lien déjà utilisé : le hash a changé donc l'empreinte ne correspond plus.
    if (payload.fp !== this.pwdFingerprint(user.password_hash)) return { error: 'used' };

    const newHash = await this.hashPassword(newPassword);
    await this.prisma.users.update({
      where: { telegram_id: payload.telegram_id },
      data: { password_hash: newHash },
    });
    this.invalidateFp(payload.telegram_id);
    // Déconnecte les autres sessions : les appareils de confiance redeviennent inconnus.
    // Duplique la requête d'une ligne de MfaService.oublierAppareils() plutôt que d'y
    // dépendre directement, pour éviter une dépendance circulaire AuthService <-> MfaService
    // (MfaService a déjà besoin de sessionFromUser).
    await this.prisma.appareils_confiance.deleteMany({ where: { telegram_id: payload.telegram_id } });
    return { success: true };
  }

  /** Identité minimale pour un jeton d'attente MFA — port de supabase_user() (routes/auth.py). */
  async userForMfa(telegramId: string) {
    return this.prisma.users.findUnique({
      where: { telegram_id: telegramId },
      select: { telegram_id: true, email: true, nom: true },
    });
  }

  /** True si l'empreinte portée par le jeton correspond au mot de passe actuel du compte. */
  async sessionValid(telegramId: string, fp: string): Promise<boolean> {
    const cached = this.fpCache.get(telegramId);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return cached.fp === fp;
    }
    const user = await this.prisma.users.findUnique({
      where: { telegram_id: telegramId },
      select: { password_hash: true },
    });
    if (!user) return false;
    const currentFp = this.pwdFingerprint(user.password_hash);
    this.fpCache.set(telegramId, { fp: currentFp, expiresAt: now + this.FP_TTL_MS });
    return currentFp === fp;
  }

  invalidateFp(telegramId: string): void {
    this.fpCache.delete(telegramId);
  }

  /** Jeton scopé sur un compte de la famille (bascule master ↔ sous-marque) — port direct
   * de la construction de jeton dans routes/accounts.py::switch_account.
   * `fp` porte l'empreinte du mot de passe de la CIBLE (le compte réellement scopé par ce
   * jeton, payload.telegram_id) — jamais celle de l'appelant. Corrigé suite au scan Strix
   * du 2026-09-28 : sans `fp`, ce jeton (jusqu'à 7 jours, ou la durée de session admin)
   * survivait à un changement de mot de passe sur le compte cible, contrairement au jeton
   * de login normal (voir sessionValid() / JwtAuthGuard). */
  issueSwitchToken(targetTelegramId: string, email: string | null, isAdmin: boolean, origine: string, masterId: string | null, passwordHash: string | null): string {
    const heures = isAdmin ? this.config.get<number>('app.adminSessionHeures')! : 24 * 7;
    return this.jwt.sign(
      { telegram_id: targetTelegramId, email: email ?? '', is_admin: isAdmin, origine, master_id: masterId, fp: this.pwdFingerprint(passwordHash) },
      { expiresIn: `${heures}h` },
    );
  }

  /** Mode Vision (admin) : jeton UTILISATEUR temporaire (1h) pour voir/agir comme le
   * client — les actions consomment les quotas du CLIENT, pas de l'admin.
   * `fp` porte l'empreinte du mot de passe du CLIENT visé (payload.telegram_id), pour que
   * ce jeton s'invalide aussi si son mot de passe change pendant la session Vision — même
   * correctif que issueSwitchToken (scan Strix du 2026-09-28). */
  issueVisionToken(targetTelegramId: string, adminTelegramId: string, passwordHash: string | null): string {
    return this.jwt.sign(
      { telegram_id: targetTelegramId, vision: true, impersonated_by: adminTelegramId, fp: this.pwdFingerprint(passwordHash) },
      { expiresIn: '1h' },
    );
  }

  /** Change le mot de passe après vérification de l'ancien (route /users/me/password).
   * Renvoie un NOUVEAU jeton (empreinte à jour) pour l'appareil courant — les autres
   * sessions portent l'ancienne empreinte et seront déconnectées à leur prochaine requête. */
  async changePassword(telegramId: string, oldPassword: string, newPassword: string): Promise<{ success?: true; token?: string; error?: string }> {
    const user = await this.prisma.users.findUnique({
      where: { telegram_id: telegramId },
      select: { password_hash: true, email: true, is_admin: true },
    });
    if (!user) return { error: 'not_found' };
    if (!(await this.verifyPassword(oldPassword, user.password_hash))) return { error: 'wrong_old' };
    if (newPassword.length < 6) return { error: 'too_short' };

    const newHash = await this.hashPassword(newPassword);
    await this.prisma.users.update({ where: { telegram_id: telegramId }, data: { password_hash: newHash } });
    this.invalidateFp(telegramId);
    // Déconnecte les autres sessions : les appareils de confiance redeviennent inconnus
    // (même logique que resetPassword — cf. commentaire ci-dessus sur la dépendance évitée).
    await this.prisma.appareils_confiance.deleteMany({ where: { telegram_id: telegramId } });

    const isAdmin = Boolean(user.is_admin);
    const claims = this.buildClaims({ telegram_id: telegramId, email: user.email, is_admin: user.is_admin, password_hash: newHash });
    const token = this.issueToken(claims, isAdmin);
    return { success: true, token };
  }
}
