import { BadRequestException, Controller, Get, HttpException, HttpStatus, Logger, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { PrismaService } from '../../config/prisma.service';
import { JwtPayload } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { QuotaService } from '../quota/quota.service';
import { SocialService } from '../social/social.service';
import { LateService } from './late.service';

type AuthedRequest = Request & { user: JwtPayload };

/** Port direct de backend/routes/late.py. */
@Controller('late')
export class LateController {
  private readonly logger = new Logger(LateController.name);
  private readonly frontendUrl: string;

  constructor(
    private readonly lateService: LateService,
    private readonly socialService: SocialService,
    private readonly quotaService: QuotaService,
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.frontendUrl = config.get<string>('app.frontendUrl') || 'http://localhost:3000';
  }

  /** Callback OAuth réseaux (public) : Late a connecté le compte au profil, on enregistre
   * l'accountId puis on ferme le popup. Le front (à la fermeture) rafraîchit l'utilisateur. */
  @Get('oauth-callback')
  async oauthCallback(
    @Query('telegram_id') telegramId: string,
    @Query('platform') platform: string,
    @Query('accountId') accountId: string | undefined,
    @Res() res: Response,
  ) {
    let ok = false;
    try {
      const result = await this.socialService.finalizeConnection(telegramId, platform, accountId);
      ok = result.ok;
    } catch (e) {
      this.logger.error(`oauth-callback error ${telegramId}/${platform}: ${e instanceof Error ? e.message : e}`);
    }
    const titre = ok ? 'Compte connecté ✅' : 'Connexion échouée';
    const detail = ok ? 'Tu peux fermer cette fenêtre.' : "Réessaie depuis l'application.";
    const html = `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">
<title>${titre}</title><style>
body{font-family:-apple-system,Segoe UI,sans-serif;background:#020617;color:#e8edf6;display:grid;place-items:center;height:100vh;margin:0;text-align:center}
.c{max-width:360px;padding:24px}h1{font-size:20px;margin:0 0 8px}p{color:#93a1b8;font-size:14px}
</style></head><body><div class="c"><h1>${titre}</h1><p>${detail}</p></div>
<script>try{window.close();}catch(e){} setTimeout(function(){try{window.close();}catch(e){} location.replace('${this.frontendUrl}/dashboard/parametres');}, 1200);</script>
</body></html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  }

  /** Pousse un contenu validé dans Late (programmé à sa date). Anti-doublon via late_post_id. */
  @Post('publier/:contenuId')
  @UseGuards(JwtAuthGuard)
  async publier(@Param('contenuId') contenuId: string, @Req() req: AuthedRequest) {
    const telegramId = req.user.telegram_id;
    await this.quotaService.exigerAbonnement(telegramId); // sans carte -> popup mur de paiement
    const contenu = await this.prisma.contenu.findFirst({ where: { id: contenuId, telegram_id: telegramId } });
    if (!contenu) throw new HttpException('Contenu introuvable', HttpStatus.NOT_FOUND);

    // Garde-fou vidéo : une vidéo/reel doit être MONTÉE (video_url présente) avant publication.
    const isVideo = ['Reel', 'Video', 'Short'].includes(contenu.type || '') || Boolean(contenu.video_status);
    if (isVideo && !contenu.video_url) {
      throw new HttpException(
        "La vidéo n'est pas encore montée — attends la fin du montage avant de publier.",
        HttpStatus.CONFLICT,
      );
    }
    const statutPub = contenu.publish_status;
    if (statutPub === 'publié') throw new HttpException('Ce contenu est déjà publié.', HttpStatus.CONFLICT);

    // Re-programmation (ex. changement de date) : on annule l'ancien post Late puis on recrée.
    if (contenu.late_post_id && (statutPub === 'programmé' || statutPub === 'envoi')) {
      try {
        await this.lateService.cancelPost(contenu.late_post_id);
        this.logger.log(`Re-programmation ${contenuId} : ancien post Late annulé`);
      } catch (e) {
        this.logger.warn(`Re-programmation ${contenuId} : annulation ancien post échouée: ${e instanceof Error ? e.message : e}`);
      }
    }

    const res = await this.lateService.publishContenu(telegramId, contenu as unknown as Record<string, unknown>);
    if (res.ok) {
      // 'envoi' : confirmé 'programmé' quand Late renverra l'event post.scheduled.
      await this.prisma.contenu.updateMany({
        where: { id: contenuId, telegram_id: telegramId },
        data: { late_post_id: res.late_post_id, publish_status: 'envoi', publish_error: null },
      });
      return { publish_status: 'envoi', late_post_id: res.late_post_id };
    }

    // Échec -> on stocke la raison (visible dans l'app) et on remonte un message clair.
    await this.prisma.contenu.updateMany({
      where: { id: contenuId, telegram_id: telegramId },
      data: { publish_status: 'échec', publish_error: res.error },
    });
    throw new HttpException(res.error || 'Échec de la publication', HttpStatus.BAD_GATEWAY);
  }

  /** Annule l'envoi d'un contenu programmé dans Late. */
  @Post('annuler/:contenuId')
  @UseGuards(JwtAuthGuard)
  async annuler(@Param('contenuId') contenuId: string, @Req() req: AuthedRequest) {
    const telegramId = req.user.telegram_id;
    const contenu = await this.prisma.contenu.findFirst({ where: { id: contenuId, telegram_id: telegramId } });
    if (!contenu) throw new HttpException('Contenu introuvable', HttpStatus.NOT_FOUND);
    if (contenu.publish_status === 'publié') {
      throw new HttpException("Déjà publié — impossible d'annuler.", HttpStatus.CONFLICT);
    }
    if (!contenu.late_post_id) throw new BadRequestException("Ce contenu n'a pas été programmé.");

    const res = await this.lateService.cancelPost(contenu.late_post_id);
    if (!res.ok) throw new HttpException(res.error || "Échec de l'annulation", HttpStatus.BAD_GATEWAY);

    // Retour au statut "Valider" : le contenu reste approuvé mais n'est PLUS planifié
    // (sinon la base/l'UI continuent d'afficher "Planifié" après l'annulation Zernio).
    await this.prisma.contenu.updateMany({
      where: { id: contenuId, telegram_id: telegramId },
      data: { publish_status: 'annulé', late_post_id: null, statut: 'Valider' },
    });
    return { publish_status: 'annulé', statut: 'Valider' };
  }

  /** Webhook Late (public, vérifié par signature HMAC best-effort) : met à jour le statut
   * de publication. */
  @Post('webhook')
  async webhook(@Req() req: AuthedRequest & { rawBody?: Buffer }) {
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const sig = (req.headers['x-late-signature'] as string) || '';
    if (!this.lateService.verifySignature(raw, sig)) {
      throw new HttpException('Signature invalide', HttpStatus.UNAUTHORIZED);
    }
    let payload: Record<string, unknown> = {};
    try {
      payload = raw.length ? JSON.parse(raw.toString('utf-8')) : {};
    } catch {
      payload = {};
    }
    let res: Record<string, unknown>;
    try {
      res = await this.lateService.handleWebhook(payload);
    } catch (e) {
      this.logger.error(`Late webhook error: ${e instanceof Error ? e.message : e}`);
      res = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    return { received: true, ...res };
  }
}
