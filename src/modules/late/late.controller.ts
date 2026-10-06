import { BadRequestException, Body, Controller, Get, HttpException, HttpStatus, Logger, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import type { Request, Response } from 'express';
import { PrismaService } from '../../config/prisma.service';
import { JwtPayload } from '../auth/auth.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { InboxService } from '../comments/inbox.service';
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
    private readonly analyticsService: AnalyticsService,
    // InboxService vit dans CommentsModule, qui importe déjà LateModule : on le résout à la
    // demande (ModuleRef) plutôt que de créer un import circulaire.
    private readonly moduleRef: ModuleRef,
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
      // Compte changé : rien n'est reprogrammé d'office — la page Paramètres pose la question
      // (indicateur levé par finalizeConnection, lu par GET /late/a-reprogrammer).
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

    // Déjà programmé chez Zernio à cette même date (cas de la validation : le serveur vient de
    // programmer le contenu, puis l'interface appelle cette route) : rien à refaire. Recréer le
    // post échouait en « doublon » chez Zernio et passait le contenu en échec à tort.
    if (
      contenu.late_post_id &&
      (statutPub === 'programmé' || statutPub === 'envoi') &&
      (await this.lateService.dejaProgrammeA(contenu.late_post_id, contenu.date_publication))
    ) {
      return { publish_status: statutPub, late_post_id: contenu.late_post_id, deja: true };
    }

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

  /** Réseaux dont le compte vient de changer, avec les posts non publiés qu'on propose de
   * reprogrammer. Un réseau sans aucun post concerné est marqué traité (rien à demander). */
  @Get('a-reprogrammer')
  @UseGuards(JwtAuthGuard)
  async aReprogrammer(@Req() req: AuthedRequest) {
    const telegramId = req.user.telegram_id;
    const out: Record<string, { id: string; titre: string | null; date_publication: Date | null; en_retard: boolean }[]> = {};
    for (const p of await this.socialService.reprogEnAttente(telegramId)) {
      const posts = await this.lateService.candidatsReprogrammation(telegramId, p);
      if (posts.length) {
        out[p] = posts.map((c) => ({ id: c.id, titre: c.titre, date_publication: c.date_publication, en_retard: c.en_retard }));
      } else {
        await this.socialService.reprogTraitee(telegramId, p);
      }
    }
    return out;
  }

  /** Réponse du client : `ids` = posts à reprogrammer (vide = « non merci »). Question close. */
  @Post('reprogrammer')
  @UseGuards(JwtAuthGuard)
  async reprogrammer(@Body() body: { platform?: string; ids?: string[] }, @Req() req: AuthedRequest) {
    const telegramId = req.user.telegram_id;
    const platform = (body?.platform || '').toLowerCase();
    const ids = Array.isArray(body?.ids) ? body.ids.map(String) : [];
    const n = ids.length ? await this.lateService.reprogrammerReseau(telegramId, platform, ids) : 0;
    await this.socialService.reprogTraitee(telegramId, platform);
    return { success: true, reprogrammes: n };
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

  /** Webhook DÉDIÉ à `analytics.synced` (recommandation Zernio) : événement très fréquent
   * (~1 par compte et par heure), isolé pour qu'une coupure ne fasse pas désactiver le webhook
   * des posts. Réponse immédiate, rafraîchissement en tâche de fond. */
  @Post('webhook-analytics')
  async webhookAnalytics(@Req() req: AuthedRequest & { rawBody?: Buffer }) {
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const sig = (req.headers['x-zernio-signature'] as string) || (req.headers['x-late-signature'] as string) || '';
    if (!this.lateService.verifySignature(raw, sig)) {
      throw new HttpException('Signature invalide', HttpStatus.UNAUTHORIZED);
    }
    let payload: Record<string, unknown> = {};
    try {
      payload = raw.length ? JSON.parse(raw.toString('utf-8')) : {};
    } catch {
      payload = {};
    }
    const event = String(payload.event || '').toLowerCase();
    if (event !== 'analytics.synced') return { received: true, ok: true, ignored: event };
    void this.analyticsService.refreshDepuisWebhook(payload);
    return { received: true, ok: true, event };
  }

  /** Webhook Late (public, vérifié par signature HMAC best-effort) : met à jour le statut
   * de publication. */
  @Post('webhook')
  async webhook(@Req() req: AuthedRequest & { rawBody?: Buffer }) {
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    // Zernio signe avec X-Zernio-Signature (ancien nom : X-Late-Signature)
    const sig = (req.headers['x-zernio-signature'] as string) || (req.headers['x-late-signature'] as string) || '';
    if (!this.lateService.verifySignature(raw, sig)) {
      throw new HttpException('Signature invalide', HttpStatus.UNAUTHORIZED);
    }
    let payload: Record<string, unknown> = {};
    try {
      payload = raw.length ? JSON.parse(raw.toString('utf-8')) : {};
    } catch {
      payload = {};
    }
    const event = String(payload.event || '').toLowerCase();
    if (event === 'analytics.synced') {
      // Gros volume (un par compte et par cycle) : réponse immédiate, rafraîchissement en fond.
      void this.analyticsService.refreshDepuisWebhook(payload);
      return { received: true, ok: true, event };
    }
    let res: Record<string, unknown>;
    try {
      res = event.startsWith('comment.')
        ? await this.moduleRef.get(InboxService, { strict: false }).handleCommentWebhook(payload)
        : await this.lateService.handleWebhook(payload);
    } catch (e) {
      this.logger.error(`Late webhook error: ${e instanceof Error ? e.message : e}`);
      res = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    return { received: true, ...res };
  }
}
