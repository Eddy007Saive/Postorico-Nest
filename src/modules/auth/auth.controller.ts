import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { clientIp } from '../../common/utils/client-ip.util';
import { RateLimitService } from '../../common/utils/rate-limit.service';
import { AffiliationService } from '../affiliation/affiliation.service';
import { MailService } from '../mail/mail.service';
import { SocialService } from '../social/social.service';
import { AuthService, GoogleAuthError } from './auth.service';
import { AdminLoginDto } from './dto/admin-login.dto';
import { CodeRenvoyerDto } from './dto/code-renvoyer.dto';
import { CodeVerifierDto } from './dto/code-verifier.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { GoogleLoginDto } from './dto/google-login.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { MfaService } from './mfa.service';

// Anti-bruteforce : verrou par (ip+email) après 5 échecs/15 min ; par ip après 20 échecs/15 min.
// Mêmes seuils que backend/routes/auth.py::_LOGIN / _LOGIN_IP.
const LOGIN = { maxFails: 5, window: 900, lock: 900 };
const LOGIN_IP = { maxFails: 20, window: 900, lock: 1800 };

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly authService: AuthService,
    private readonly mfaService: MfaService,
    private readonly mailService: MailService,
    private readonly rateLimit: RateLimitService,
    private readonly config: ConfigService,
    private readonly socialService: SocialService,
    private readonly affiliationService: AffiliationService,
  ) {}

  private clientIp(req: Request): string {
    return clientIp(req);
  }

  /** Lève 429 si l'ip ou (ip+email) est verrouillé. Retourne les clés pour fail/clear. */
  private guardLogin(req: Request, email: string): { key: string; keyIp: string } {
    const ip = this.clientIp(req);
    const key = `login:${ip}:${email.toLowerCase()}`;
    const keyIp = `loginip:${ip}`;
    const remaining = Math.max(this.rateLimit.lockedFor(key), this.rateLimit.lockedFor(keyIp));
    if (remaining > 0) {
      throw new HttpException(
        `Trop de tentatives. Réessaie dans ${Math.floor(remaining / 60) + 1} min.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return { key, keyIp };
  }

  private recordLoginFail(keys: { key: string; keyIp: string }): void {
    this.rateLimit.fail(keys.key, LOGIN.maxFails, LOGIN.window, LOGIN.lock);
    this.rateLimit.fail(keys.keyIp, LOGIN_IP.maxFails, LOGIN_IP.window, LOGIN_IP.lock);
  }

  /** Le mot de passe est bon mais l'appareil est inconnu (ou compte admin) : on crée le code,
   * on l'envoie par email, et on rend un jeton d'attente, pas une session.
   * Port de _demander_code (routes/auth.py) — échec d'envoi = 503, comme le Python. */
  private async demanderCode(user: { telegram_id: string; email: string | null; nom: string | null }) {
    const code = await this.mfaService.creerCode(user.telegram_id);
    if (code) {
      const { subject, html } = this.mailService.codeConnexionHtml(user.nom, code);
      const envoi = await this.mailService.sendEmail(user.email ?? '', subject, html);
      if (envoi.error) {
        this.logger.error(`mfa: envoi du code impossible pour ${user.telegram_id}: ${envoi.error}`);
        throw new ServiceUnavailableException('envoi_code_impossible');
      }
    }
    return {
      code_requis: true,
      jeton: this.mfaService.jetonAttente(user.telegram_id),
      email: this.mfaService.masquerEmail(user.email ?? ''),
    };
  }

  @Post('register')
  async register(@Body() dto: RegisterDto, @Req() req: Request) {
    const result = await this.authService.registerUser(dto);
    // Parrainage : le front transmet le code capté dans l'URL. Best-effort,
    // une attribution ratée ne doit jamais faire échouer une inscription.
    if (dto.ref) {
      try {
        await this.affiliationService.attribuer(dto.ref, result.telegramId, result.email, this.clientIp(req));
      } catch (e) {
        this.logger.warn(`attribution affiliation ignorée pour ${result.telegramId}: ${e instanceof Error ? e.message : e}`);
      }
    }
    // Compte actif immédiatement -> profil Late (best-effort, jamais bloquant).
    try {
      await this.socialService.createLateProfile(result.telegramId, result.nom);
    } catch (e) {
      this.logger.warn(`Late profile creation failed for ${result.telegramId}: ${e instanceof Error ? e.message : e}`);
    }
    // Auto-login : un jeton direct vers le tableau de bord, comme côté Python.
    const token = this.authService.issueRegistrationToken(result.telegramId, result.email, result.passwordHash);
    return { success: true, token, telegramId: result.telegramId, pending: false };
  }

  /** Le client OAuth Google, lu au chargement par le bouton (vide = bouton masqué). */
  @Get('google/config')
  googleConfig() {
    return { client_id: this.config.get<string>('app.googleClientId') };
  }

  @Post('google')
  async google(@Body() dto: GoogleLoginDto, @Req() req: Request) {
    const ip = this.clientIp(req);
    const keyIp = `loginip:${ip}`;
    if (this.rateLimit.lockedFor(keyIp) > 0) {
      throw new HttpException('Trop de tentatives. Réessaie dans quelques minutes.', HttpStatus.TOO_MANY_REQUESTS);
    }
    let result: Awaited<ReturnType<AuthService['loginGoogle']>>;
    try {
      result = await this.authService.loginGoogle(dto.access_token, dto.langue, dto.fuseau);
    } catch (e: unknown) {
      if (e instanceof GoogleAuthError) {
        this.rateLimit.fail(keyIp, LOGIN_IP.maxFails, LOGIN_IP.window, LOGIN_IP.lock);
        throw new UnauthorizedException(e.message);
      }
      this.logger.error(`auth google: ${e instanceof Error ? e.message : e}`);
      throw new HttpException('Connexion Google impossible', HttpStatus.INTERNAL_SERVER_ERROR);
    }
    const { user, nouveau } = result;
    if (nouveau) {
      // Mêmes suites qu'une inscription classique (best-effort, jamais bloquant).
      if (dto.ref) {
        try {
          await this.affiliationService.attribuer(dto.ref, user.telegram_id, user.email ?? '', ip);
        } catch (e) {
          this.logger.warn(`attribution affiliation ignorée pour ${user.telegram_id}: ${e instanceof Error ? e.message : e}`);
        }
      }
      try {
        await this.socialService.createLateProfile(user.telegram_id, user.nom || '');
      } catch (e) {
        this.logger.warn(`Late profile creation failed for ${user.telegram_id}: ${e instanceof Error ? e.message : e}`);
      }
    }
    this.rateLimit.clear(keyIp);

    // Un administrateur donne TOUJOURS le code MFA, même via Google — même règle que
    // /auth/admin-login (mfaService.exigeCode). Sans ça, ce chemin de connexion
    // contournait entièrement la double vérification prévue pour les admins.
    if (user.is_admin) {
      return this.demanderCode(user);
    }
    const session = await this.authService.sessionFromUser(user);
    return { token: session.token, is_admin: session.is_admin, pending: session.pending, nouveau };
  }

  @Post('forgot-password')
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    try {
      const user = await this.authService.findUserByEmail(dto.email);
      if (user) {
        const token = this.authService.createResetToken(user.telegram_id, user.password_hash);
        const link = `${this.config.get<string>('app.frontendUrl')}/reset-password?token=${token}`;
        const html = this.mailService.resetEmailHtml(user.nom ?? user.username ?? null, link);
        const envoi = await this.mailService.sendEmail(
          user.email ?? '',
          'Réinitialisation de votre mot de passe — Postorico',
          html,
        );
        if (envoi.error) {
          this.logger.error(`Reset email non envoyé (${dto.email}): ${envoi.error}`);
        }
      }
    } catch (e: unknown) {
      this.logger.error(`forgot-password error: ${e instanceof Error ? e.message : e}`);
    }
    // On ne révèle jamais si l'email existe (anti-énumération) — même réponse dans tous les cas.
    return { success: true, message: "Si un compte est associé à cet email, un lien vient d'être envoyé." };
  }

  @Post('reset-password')
  async resetPassword(@Body() dto: ResetPasswordDto) {
    const result = await this.authService.resetPassword(dto.token, dto.password);
    if (result.error === 'expired') {
      throw new BadRequestException('Ce lien a expiré. Refaites une demande de réinitialisation.');
    }
    if (result.error === 'used') {
      throw new BadRequestException('Ce lien a déjà été utilisé.');
    }
    if (result.error) {
      throw new BadRequestException('Lien invalide ou expiré.');
    }
    return { success: true, message: 'Mot de passe réinitialisé avec succès.' };
  }

  @Post('login')
  async login(@Body() dto: LoginDto, @Req() req: Request) {
    const keys = this.guardLogin(req, dto.email);
    const user = await this.authService.verifyCredentials(dto.email, dto.password);
    if (!user) {
      this.recordLoginFail(keys);
      throw new UnauthorizedException('Email ou mot de passe incorrect.');
    }
    this.rateLimit.clear(keys.key);

    const appareilConnu = await this.mfaService.appareilValide(user.telegram_id, dto.appareil);
    if (this.mfaService.exigeCode(user, appareilConnu)) {
      return this.demanderCode(user);
    }
    return this.authService.sessionFromUser(user);
  }

  @Post('admin-login')
  async adminLogin(@Body() dto: AdminLoginDto, @Req() req: Request) {
    const keys = this.guardLogin(req, dto.email);
    const user = await this.authService.verifyCredentials(dto.email, dto.password);
    if (!user || !user.is_admin) {
      this.recordLoginFail(keys);
      throw new UnauthorizedException('Identifiants administrateur invalides.');
    }
    this.rateLimit.clear(keys.key);
    // Un administrateur donne TOUJOURS le code — pas de vérification d'appareil de confiance
    // pour ce rôle (même règle que login_admin côté Python).
    return this.demanderCode(user);
  }

  @Post('code/verifier')
  async codeVerifier(@Body() dto: CodeVerifierDto, @Req() req: Request) {
    const ip = this.clientIp(req);
    const keyIp = `loginip:${ip}`;
    if (this.rateLimit.lockedFor(keyIp) > 0) {
      throw new HttpException('Trop de tentatives. Réessaie dans quelques minutes.', HttpStatus.TOO_MANY_REQUESTS);
    }
    try {
      const res = await this.mfaService.verifier(
        dto.jeton,
        dto.code,
        dto.confiance,
        req.headers['user-agent']?.slice(0, 160),
        ip,
      );
      this.rateLimit.clear(keyIp);
      return res;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'jeton_invalide';
      if (msg === 'code_faux' || msg === 'trop_essais') {
        this.rateLimit.fail(keyIp, LOGIN_IP.maxFails, LOGIN_IP.window, LOGIN_IP.lock);
      }
      throw new UnauthorizedException(msg);
    }
  }

  @Post('code/renvoyer')
  async codeRenvoyer(@Body() dto: CodeRenvoyerDto) {
    let code: string | null;
    try {
      code = await this.mfaService.renvoyer(dto.jeton);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'jeton_invalide';
      throw new UnauthorizedException(msg);
    }
    if (!code) {
      throw new HttpException('renvoi_trop_tot', HttpStatus.TOO_MANY_REQUESTS);
    }
    const telegramId = this.mfaService.lireAttente(dto.jeton);
    const user = await this.authService.userForMfa(telegramId);
    const { subject, html } = this.mailService.codeConnexionHtml(user?.nom ?? null, code);
    const envoi = await this.mailService.sendEmail(user?.email ?? '', subject, html);
    if (envoi.error) {
      throw new ServiceUnavailableException('envoi_code_impossible');
    }
    return { ok: true, email: this.mfaService.masquerEmail(user?.email ?? '') };
  }
}
