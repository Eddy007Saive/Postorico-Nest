import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { clientIp } from '../../common/utils/client-ip.util';
import { RateLimitService } from '../../common/utils/rate-limit.service';
import { PrismaService } from '../../config/prisma.service';
import { JwtPayload } from '../auth/auth.service';
import { AdminGuard } from '../auth/guards/admin.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { BillingService } from '../billing/billing.service';
import { MailService } from '../mail/mail.service';
import { AdresseRefusee, SiteIllisible, SiteService } from '../site/site.service';
import { ConfigurationService } from './configuration.service';
import { AUDIO_MAX_OCTETS, TranscriptionService } from './transcription.service';

type AuthedRequest = Request & { user: JwtPayload };

/** Seuls les comptes créés à partir de cette date doivent choisir : les clients d'avant sont déjà configurés. */
export const DEBUT_CHOIX_STUDIO = new Date('2026-10-27T00:00:00Z');

/** Le client « attend » si le compteur est bloqué ; sinon on compte cette action. */
function limiter(rl: RateLimitService, cle: string, max: number, fenetreS: number, verrouS: number, message: string) {
  const reste = rl.lockedFor(cle);
  if (reste > 0) throw new HttpException(message, HttpStatus.TOO_MANY_REQUESTS);
  rl.fail(cle, max, fenetreS, verrouS);
}

/**
 * Configuration du studio d'un nouveau compte : le choix « je l'ai déjà pris / clé en main /
 * je paramètre seul », le lien de paiement du Pack Fondations, le questionnaire de marque
 * rempli dans le compte (fiche de marque écrite par l'IA), la dictée au micro, et côté admin
 * la liste des studios à livrer.
 */
@Controller('configuration')
export class ConfigurationController {
  private readonly logger = new Logger(ConfigurationController.name);

  constructor(
    private readonly configuration: ConfigurationService,
    private readonly transcription: TranscriptionService,
    private readonly billing: BillingService,
    private readonly site: SiteService,
    private readonly mail: MailService,
    private readonly prisma: PrismaService,
    private readonly rateLimit: RateLimitService,
    private readonly config: ConfigService,
  ) {}

  private async compte(telegramId: string) {
    return this.prisma.users.findUnique({ where: { telegram_id: telegramId }, select: { nom: true, email: true, langue: true, created_at: true } });
  }

  /** État du choix + dernières réponses au questionnaire (pour le rouvrir pré-rempli). */
  @Get()
  @UseGuards(JwtAuthGuard)
  async lire(@Req() req: AuthedRequest) {
    const telegramId = req.user.telegram_id;
    const [e, u] = await Promise.all([this.configuration.etat(telegramId), this.compte(telegramId)]);
    const nouveau = Boolean(u?.created_at && u.created_at >= DEBUT_CHOIX_STUDIO);
    return { ...e, a_choisir: !e.etat && nouveau, reponses: await this.configuration.dernieresReponses(u?.email) };
  }

  /** « Je l'ai déjà pris » (l'équipe prend la main) ou « je paramètre seul ». */
  @Post('choix')
  @UseGuards(JwtAuthGuard)
  async choisir(@Body() body: Record<string, unknown>, @Req() req: AuthedRequest) {
    const telegramId = req.user.telegram_id;
    const choix = body.choix;
    if (choix !== 'deja_pris' && choix !== 'seul') throw new BadRequestException('Choix invalide.');
    const { etat } = await this.configuration.etat(telegramId);
    if (choix === 'seul') {
      if (!etat) await this.configuration.poser(telegramId, 'seul');
      return this.configuration.etat(telegramId);
    }
    if (etat === 'livre' || etat === 'equipe') return this.configuration.etat(telegramId);
    await this.configuration.poser(telegramId, 'equipe');
    // L'équipe est prévenue : un studio à configurer (à vérifier côté paiements si besoin).
    try {
      const u = await this.compte(telegramId);
      const html = this.mail.auditReplyHtml(null,
        `${u?.nom || 'Un client'} (${u?.email || 'sans email'}) indique avoir pris le Pack Fondations : son studio est à configurer.\n\n` +
        'Vérifie le paiement dans Stripe, puis marque le studio comme livré dans l\'admin quand il est prêt.');
      await this.mail.sendEmail(this.config.get<string>('app.adminNotifEmail')!, `Studio à configurer : ${u?.nom || u?.email || telegramId}`, html);
    } catch (e) {
      this.logger.warn(`notif studio à configurer: ${e instanceof Error ? e.message : e}`);
    }
    return this.configuration.etat(telegramId);
  }

  /** Lien de paiement Stripe du Pack Fondations, pour ce compte. */
  @Post('lien-pack')
  @UseGuards(JwtAuthGuard)
  async lienPack(@Req() req: AuthedRequest) {
    const telegramId = req.user.telegram_id;
    limiter(this.rateLimit, `lien-pack:${telegramId}`, 10, 3600, 600, 'Réessaie dans quelques minutes.');
    const res = await this.billing.lienPack({ telegram_id: telegramId });
    if (!res.ok || !res.url) throw new HttpException(res.error || 'Le paiement est indisponible pour le moment.', HttpStatus.SERVICE_UNAVAILABLE);
    return { url: res.url };
  }

  /** Pré-remplissage depuis le site du client (dans le compte : 3 analyses par jour). */
  @Post('analyser-site')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async analyserSite(@Body() body: Record<string, unknown>, @Req() req: AuthedRequest) {
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    if (!url) throw new BadRequestException("Indique l'adresse de ton site.");
    limiter(this.rateLimit, `config-site:${req.user.telegram_id}`, 3, 86400, 86400, 'Tu as déjà analysé ton site aujourd\'hui : continue le questionnaire, tes réponses sont gardées.');
    try {
      const r = await this.site.preRemplir(url);
      return { url: r.url, champs: r.champs, pages_lues: r.pages_lues };
    } catch (e) {
      if (e instanceof AdresseRefusee) throw new BadRequestException(e.message);
      if (e instanceof SiteIllisible) throw new HttpException(`Impossible de lire ce site : ${e.message}`, HttpStatus.UNPROCESSABLE_ENTITY);
      this.logger.error(`config analyse site: ${e instanceof Error ? e.message : e}`);
      throw new HttpException('Analyse du site impossible pour le moment.', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  /** Questionnaire rempli dans le compte : l'IA écrit la fiche de marque. */
  @Post('formulaire')
  @UseGuards(JwtAuthGuard)
  async formulaire(@Body() body: Record<string, unknown>, @Req() req: AuthedRequest) {
    const telegramId = req.user.telegram_id;
    const answers = body.answers;
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new BadRequestException('Réponses invalides.');
    limiter(this.rateLimit, `config-formulaire:${telegramId}`, 5, 3600, 1800, 'Réessaie dans quelques minutes.');
    const u = await this.compte(telegramId);
    try {
      const champs = await this.configuration.configurerDepuisFormulaire(telegramId, u?.email ?? null, answers as Record<string, unknown>, typeof body.recap === 'string' ? body.recap : '');
      return { champs };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === 'reponses_vides') throw new BadRequestException('Réponds au moins à quelques questions.');
      this.logger.error(`config formulaire ${telegramId}: ${msg}`);
      throw new HttpException("Ta fiche de marque n'a pas pu être préparée. Réessaie, tes réponses sont gardées.", HttpStatus.BAD_GATEWAY);
    }
  }

  private async transcrireFichier(file: Express.Multer.File | undefined, langue: unknown) {
    if (!file) throw new BadRequestException('Enregistrement manquant.');
    if (!TranscriptionService.typeAccepte(file.mimetype)) throw new BadRequestException("Format d'enregistrement non pris en charge.");
    if (file.size > AUDIO_MAX_OCTETS) throw new BadRequestException('Enregistrement trop long (10 minutes au plus).');
    if (!this.transcription.actif) throw new HttpException('La dictée est indisponible pour le moment.', HttpStatus.SERVICE_UNAVAILABLE);
    try {
      const texte = await this.transcription.transcrire(file.buffer, file.mimetype, typeof langue === 'string' ? langue.slice(0, 2) : 'fr');
      return { texte };
    } catch (e) {
      this.logger.error(`transcription: ${e instanceof Error ? e.message : e}`);
      throw new HttpException("La dictée n'a pas pu être transcrite. Réessaie ou écris ta réponse.", HttpStatus.BAD_GATEWAY);
    }
  }

  /** Dictée au micro, dans le compte (40 par heure). */
  @Post('transcrire')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('audio'))
  async transcrire(@UploadedFile() file: Express.Multer.File, @Body('langue') langue: string, @Req() req: AuthedRequest) {
    limiter(this.rateLimit, `transcrire:${req.user.telegram_id}`, 40, 3600, 1800, 'Beaucoup de dictées : réessaie dans quelques minutes.');
    return this.transcrireFichier(file, langue);
  }

  /** Dictée au micro, questionnaire public /audit-marque (15 par heure et par adresse IP). */
  @Post('transcrire-public')
  @UseInterceptors(FileInterceptor('audio'))
  async transcrirePublic(@UploadedFile() file: Express.Multer.File, @Body('langue') langue: string, @Req() req: Request) {
    limiter(this.rateLimit, `transcrire-ip:${clientIp(req)}`, 15, 3600, 3600, 'Beaucoup de dictées : réessaie dans un moment, ou écris ta réponse.');
    return this.transcrireFichier(file, langue);
  }

  // ---------------------------------------------------------------- admin

  @Get('admin/studios')
  @UseGuards(AdminGuard)
  async studios() {
    return { studios: await this.configuration.studiosEnCours() };
  }

  /** Studio livré : le message « en cours de configuration » disparaît, le client est prévenu. */
  @Post('admin/studios/:telegramId/livre')
  @UseGuards(AdminGuard)
  async livrer(@Param('telegramId') telegramId: string) {
    const { etat } = await this.configuration.etat(telegramId).catch(() => ({ etat: null }));
    if (etat !== 'equipe') throw new NotFoundException('Aucun studio en cours pour ce compte.');
    await this.configuration.poser(telegramId, 'livre');
    try {
      const u = await this.compte(telegramId);
      if (u?.email) {
        const lien = `${this.config.get<string>('app.frontendUrl')}/dashboard`;
        const html = this.mail.auditReplyHtml(u.nom,
          `Bonne nouvelle : ton studio Postorico est prêt. Ta voix, tes sujets et tes visuels sont configurés.\n\n` +
          `Tu peux générer tes premiers contenus dès maintenant : ${lien}`);
        await this.mail.sendEmail(u.email, 'Ton studio Postorico est prêt', html);
      }
    } catch (e) {
      this.logger.warn(`email studio livré: ${e instanceof Error ? e.message : e}`);
    }
    return { ok: true };
  }
}
