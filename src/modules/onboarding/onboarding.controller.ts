import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { ConfigService } from '@nestjs/config';
import { clientIp } from '../../common/utils/client-ip.util';
import { RateLimitService } from '../../common/utils/rate-limit.service';
import { AdminGuard } from '../auth/guards/admin.guard';
import { MailService } from '../mail/mail.service';
import { TurnstileService } from '../turnstile/turnstile.service';
import { OnboardingService } from './onboarding.service';
import { SubmitAuditDto } from './dto/submit-audit.dto';
import { ReplyAuditDto } from './dto/reply-audit.dto';
import { SetAuditStatusDto } from './dto/set-audit-status.dto';

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 Mo par fichier
const UPLOAD_MAX = 20; // max 20 uploads
const UPLOAD_WINDOW = 10 * 60; // par 10 min
const UPLOAD_LOCK = 10 * 60; // verrou 10 min

@Controller('onboarding')
export class OnboardingController {
  private readonly logger = new Logger(OnboardingController.name);

  constructor(
    private readonly onboardingService: OnboardingService,
    private readonly turnstileService: TurnstileService,
    private readonly mailService: MailService,
    private readonly rateLimit: RateLimitService,
    private readonly config: ConfigService,
  ) {}

  /** Upload public (logo / image) pour le formulaire d'audit. Limité en taille et en débit. */
  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @Body('kind') kind: string,
    @Req() req: Request,
  ) {
    const ip = clientIp(req);
    const key = `onboarding_upload:${ip}`;
    const left = this.rateLimit.lockedFor(key);
    if (left) {
      throw new HttpException(
        `Trop d'envois. Réessaie dans ${Math.floor(left / 60) + 1} min.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (!file) throw new BadRequestException('Fichier manquant.');
    if (!file.mimetype?.startsWith('image/')) {
      throw new BadRequestException('Le fichier doit être une image (png, jpg, svg, webp…)');
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new BadRequestException('Fichier trop lourd (5 Mo maximum).');
    }

    this.rateLimit.fail(key, UPLOAD_MAX, UPLOAD_WINDOW, UPLOAD_LOCK); // compte cet upload
    try {
      const url = await this.onboardingService.uploadAsset(file.buffer, kind || 'image', file.mimetype);
      return { url };
    } catch (e) {
      this.logger.error(`Onboarding upload error: ${e instanceof Error ? e.message : e}`);
      throw new HttpException("Échec de l'upload.", HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  /** Réception publique du questionnaire d'audit de marque (lead anonyme).
   * Aucune auth : formulaire public. Un honeypot `_hp` filtre les bots basiques. */
  @Post('audit')
  async submitAudit(@Body() body: SubmitAuditDto, @Req() req: Request) {
    // Honeypot anti-bot : champ caché qui doit rester vide.
    if ((body._hp || '').trim()) {
      return { success: true }; // on fait semblant d'accepter, sans rien stocker
    }

    const token = body.cf_turnstile_token || body.turnstile_token || '';
    if (!(await this.turnstileService.verify(token, clientIp(req)))) {
      throw new HttpException('Vérification anti-bot échouée. Recharge la page et réessaie.', HttpStatus.FORBIDDEN);
    }

    const answers = body.answers || {};
    if (typeof answers !== 'object' || Array.isArray(answers)) {
      throw new BadRequestException('Format invalide');
    }

    const marque = body.marque || (answers as Record<string, unknown>).marque as string || '';
    const email = body.email || '';
    const recap = body.recap || '';

    // Garde-fou minimal : il faut au moins un email ou une marque + un peu de contenu.
    if (!((email || '').trim() || (marque || '').trim()) || Object.keys(answers).length === 0) {
      throw new BadRequestException('Réponses incomplètes');
    }

    let result: { success: true; id: string };
    try {
      const ua = req.headers['user-agent'] || '';
      result = await this.onboardingService.saveAudit(marque, email, answers, recap, ua);
    } catch (e) {
      this.logger.error(`Save audit error: ${e instanceof Error ? e.message : e}`);
      throw new HttpException('Impossible d\'enregistrer le questionnaire', HttpStatus.INTERNAL_SERVER_ERROR);
    }

    // Notification interne (best-effort : un échec d'email ne casse pas la soumission)
    try {
      const adminUrl = `${this.config.get<string>('app.frontendUrl')}/admin`;
      const html = this.mailService.auditNotificationHtml(marque, email, recap, adminUrl);
      await this.mailService.sendEmail(
        this.config.get<string>('app.adminNotifEmail')!,
        `Nouvel audit de marque : ${marque || 'Sans nom'}`,
        html,
      );
    } catch (e) {
      this.logger.error(`Audit notification email failed: ${e instanceof Error ? e.message : e}`);
    }

    return result;
  }

  // ---- Admin : consultation des leads ----
  @Get('audits')
  @UseGuards(AdminGuard)
  async listAudits() {
    return { audits: await this.onboardingService.listAudits() };
  }

  @Get('audits/:auditId')
  @UseGuards(AdminGuard)
  async getAudit(@Param('auditId') auditId: string) {
    const audit = await this.onboardingService.getAudit(auditId);
    if (!audit) throw new NotFoundException('Introuvable');
    return audit;
  }

  /** Répondre au prospect par email depuis l'admin. */
  @Post('audits/:auditId/reply')
  @UseGuards(AdminGuard)
  async replyAudit(@Param('auditId') auditId: string, @Body() body: ReplyAuditDto) {
    const audit = await this.onboardingService.getAudit(auditId);
    if (!audit) throw new NotFoundException('Introuvable');
    const to = (audit.email || '').trim();
    if (!to) throw new BadRequestException("Ce lead n'a pas d'email.");
    const subject = (body.subject || '').trim() || 'Réponse à ton audit de marque (Postorico)';
    const message = (body.message || '').trim();
    if (!message) throw new BadRequestException('Le message est vide.');
    const html = this.mailService.auditReplyHtml(audit.marque, message);
    const res = await this.mailService.sendEmail(to, subject, html);
    if (res.error) {
      throw new HttpException("L'email n'a pas pu être envoyé. Vérifie la config Resend.", HttpStatus.BAD_GATEWAY);
    }
    await this.onboardingService.updateStatus(auditId, 'traite');
    return { success: true };
  }

  @Patch('audits/:auditId/status')
  @UseGuards(AdminGuard)
  async setAuditStatus(@Param('auditId') auditId: string, @Body() body: SetAuditStatusDto) {
    const status = (body.status || '').trim();
    if (!['nouveau', 'en_cours', 'traite'].includes(status)) {
      throw new BadRequestException('Statut invalide');
    }
    await this.onboardingService.updateStatus(auditId, status);
    return { success: true };
  }
}