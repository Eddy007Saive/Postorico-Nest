import { BadRequestException, Body, Controller, Get, HttpException, HttpStatus, Logger, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { PrismaService } from '../../config/prisma.service';
import { JwtPayload } from '../auth/auth.service';
import { AdminGuard } from '../auth/guards/admin.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { MailService } from '../mail/mail.service';
import { SocialService } from '../social/social.service';
import { BillingService } from './billing.service';
import { CheckoutDto } from './dto/checkout.dto';
import { LienPackDto } from './dto/lien-pack.dto';
import { MotifDepartDto } from './dto/motif-depart.dto';
import { PackCheckoutDto } from './dto/pack-checkout.dto';
import { ParcoursRetenuDto } from './dto/parcours-retenu.dto';
import { PauseDto } from './dto/pause.dto';
import { ResilierDto } from './dto/resilier.dto';

type AuthedRequest = Request & { user: JwtPayload; rawBody?: Buffer };

/** Port direct de backend/routes/billing.py. */
@Controller('billing')
export class BillingController {
  private readonly logger = new Logger(BillingController.name);
  private readonly frontendUrl: string;
  private readonly adminNotifEmail: string;

  constructor(
    private readonly billingService: BillingService,
    private readonly mailService: MailService,
    private readonly socialService: SocialService,
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.frontendUrl = config.get<string>('app.frontendUrl') || 'http://localhost:3000';
    this.adminNotifEmail = config.get<string>('app.adminNotifEmail') || 'martindumoulin88@gmail.com';
  }

  /** Génère le lien de paiement du Pack Fondations pour un client précis (envoyé après le
   * rendez-vous). Le code de l'apporteur d'affaires est déposé en metadata. */
  @Post('admin/lien-pack')
  @UseGuards(AdminGuard)
  async lienPack(@Body() dto: LienPackDto) {
    const res = await this.billingService.lienPack({
      email: dto.email,
      telegram_id: dto.telegram_id,
      affilie: dto.affilie,
      devise: dto.devise,
      langue: dto.langue,
    });
    if (!res.ok) throw new BadRequestException(res.error);
    return res;
  }

  @Post('checkout')
  @UseGuards(JwtAuthGuard)
  async checkout(@Body() dto: CheckoutDto, @Req() req: AuthedRequest) {
    const telegramId = req.user.telegram_id;
    const plan = (dto.plan || 'pro').toLowerCase();
    if (plan !== 'pro') throw new BadRequestException('Offre invalide');
    // essai=true : parcours d'inscription. La carte est saisie, rien n'est prélevé. On ne
    // l'accorde qu'une fois : un compte qui a déjà eu un abonnement repasse en paiement
    // immédiat, sinon l'essai se renouvelle à volonté en résiliant puis se réabonnant.
    const essai = dto.essai && !(await this.billingService.aDejaEuUnAbonnement(telegramId)) ? this.billingService.ESSAI_JOURS : 0;
    const r = await this.billingService.createCheckout(telegramId, plan, essai);
    if (!r.ok) throw new BadRequestException(r.error);
    return { url: r.url };
  }

  /** Packs de rachat disponibles (en résultats), optionnellement filtrés par type. */
  @Get('packs')
  @UseGuards(JwtAuthGuard)
  async packs(@Query('action_type') actionType?: string) {
    return { packs: await this.billingService.listPacks(actionType) };
  }

  @Post('pack-checkout')
  @UseGuards(JwtAuthGuard)
  async packCheckout(@Body() dto: PackCheckoutDto, @Req() req: AuthedRequest) {
    const telegramId = req.user.telegram_id;
    if (!dto.pack_id) throw new BadRequestException('pack_id requis');
    const r = await this.billingService.createPackCheckout(telegramId, dto.pack_id);
    if (!r.ok) throw new BadRequestException(r.error);
    return { url: r.url };
  }

  /** Resynchronise l'abonnement Stripe -> table subscriptions (au retour du paiement /
   * webhook manqué). */
  @Post('sync')
  @UseGuards(JwtAuthGuard)
  async sync(@Req() req: AuthedRequest) {
    return this.billingService.syncSubscription(req.user.telegram_id);
  }

  @Get('invoices')
  @UseGuards(JwtAuthGuard)
  async invoices(@Req() req: AuthedRequest) {
    return { invoices: await this.billingService.listInvoices(req.user.telegram_id) };
  }

  @Post('portal')
  @UseGuards(JwtAuthGuard)
  async portal(@Req() req: AuthedRequest) {
    const r = await this.billingService.createPortal(req.user.telegram_id);
    if (!r.ok) throw new BadRequestException(r.error);
    return { url: r.url };
  }

  /** Arrête le renouvellement. Fait ICI et non dans le portail Stripe : le portail emmène
   * le client hors de chez nous, où l'on ne peut ni lui demander pourquoi il part, ni lui
   * proposer autre chose. */
  @Post('resilier')
  @UseGuards(JwtAuthGuard)
  async resilier(@Body() dto: ResilierDto, @Req() req: AuthedRequest) {
    const telegramId = req.user.telegram_id;
    const res = await this.billingService.resilier(telegramId, dto.raison || '', dto.commentaire, dto.parcours);
    if (!res.ok) throw new BadRequestException(res.error);
    // Confirmation écrite, avec la date de fin d'accès : sans elle, la question "jusqu'à
    // quand ?" revient au support dans les heures qui suivent.
    try {
      const u = await this.prisma.users.findUnique({ where: { telegram_id: telegramId }, select: { email: true, nom: true } });
      if (u?.email) {
        const fin = res.fin_acces_le instanceof Date ? res.fin_acces_le.toISOString() : (res.fin_acces_le ?? null);
        const { subject, html } = this.mailService.resiliationHtml(u.nom, fin, `${this.frontendUrl}/dashboard/parametres?s=abonnement`);
        await this.mailService.sendEmail(u.email, subject, html);
      }
    } catch (e) {
      this.logger.error(`email de resiliation: ${e instanceof Error ? e.message : e}`);
    }
    return res;
  }

  /** Enregistre la raison dès qu'elle est donnée, avant toute décision. Appelée à la sortie
   * de l'écran du motif. */
  @Post('motif-depart')
  @UseGuards(JwtAuthGuard)
  async motifDepart(@Body() dto: MotifDepartDto, @Req() req: AuthedRequest) {
    return this.billingService.ouvrirParcours(req.user.telegram_id, dto.raison || '', dto.commentaire);
  }

  /** Le parcours s'arrête : la personne reste. */
  @Post('parcours-retenu')
  @UseGuards(JwtAuthGuard)
  async parcoursRetenu(@Body() dto: ParcoursRetenuDto, @Req() req: AuthedRequest) {
    return this.billingService.noterRetenue(req.user.telegram_id, dto.parcours, dto.detail);
  }

  /** Suspend la facturation ET l'accès, un à trois mois, config conservée. */
  @Post('pause')
  @UseGuards(JwtAuthGuard)
  async pause(@Body() dto: PauseDto, @Req() req: AuthedRequest) {
    const res = await this.billingService.mettreEnPause(req.user.telegram_id, dto.mois ?? 1, dto.raison, dto.commentaire, dto.parcours);
    if (!res.ok) throw new BadRequestException(res.error);
    return res;
  }

  /** Sort de pause, ou annule une résiliation programmée. Un seul geste. */
  @Post('reprendre')
  @UseGuards(JwtAuthGuard)
  async reprendre(@Req() req: AuthedRequest) {
    const res = await this.billingService.reprendre(req.user.telegram_id);
    if (!res.ok) throw new BadRequestException(res.error);
    return res;
  }

  @Post('webhook')
  async webhook(@Req() req: AuthedRequest) {
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const sig = req.headers['stripe-signature'] as string | undefined;
    let result: Awaited<ReturnType<BillingService['handleWebhook']>>;
    try {
      result = await this.billingService.handleWebhook(raw, sig);
    } catch (e) {
      // Une panne de NOTRE côté : on le dit à Stripe, qui rejouera. Les traitements
      // sensibles sont déjà protégés contre le doublon.
      this.logger.error(`stripe webhook error: ${e instanceof Error ? e.message : e}`);
      throw new HttpException('traitement impossible', HttpStatus.INTERNAL_SERVER_ERROR);
    }

    // Un événement REFUSÉ doit répondre en erreur, jamais 200 : sinon Stripe croit
    // l'événement traité et ne le rejoue jamais (secret mal configuré -> invisible).
    if (!result.ok) {
      const motif = result.error || 'webhook refusé';
      const code = motif.includes('configur') ? HttpStatus.INTERNAL_SERVER_ERROR : HttpStatus.BAD_REQUEST;
      this.logger.error(`stripe webhook refusé (${code}) : ${motif}`);
      throw new HttpException(motif, code);
    }

    // Abonnement terminé (fin de cycle) -> déconnecter ses réseaux (stoppe le coût Late).
    if (result.canceled_uid) {
      try {
        await this.socialService.disconnectAll(result.canceled_uid);
      } catch (e) {
        this.logger.error(`webhook disconnect_all ${result.canceled_uid}: ${e instanceof Error ? e.message : e}`);
      }
    }

    // Notification admin (email) sur les événements de facturation.
    if (result.notify) {
      try {
        const detail =
          {
            new_sub: 'Plan Pro — 279 €/mois',
            canceling: result.notify.extra || 'Se termine en fin de période.',
            pack: `Pack : ${result.notify.extra || 'crédits'}`,
            canceled: 'Abonnement terminé — réseaux libérés.',
            payment_failed: result.notify.extra ? `Le prélèvement a échoué : ${result.notify.extra}` : 'Le prélèvement a échoué (carte ?).',
          }[result.notify.kind] || '';
        const { subject, html } = this.mailService.adminPaymentHtml(result.notify.kind, result.notify.nom, result.notify.email ?? null, detail);
        await this.mailService.sendEmail(this.adminNotifEmail, subject, html);
      } catch (e) {
        this.logger.error(`webhook admin notif: ${e instanceof Error ? e.message : e}`);
      }
    }
    // Mail 1 au CLIENT : premier échec de prélèvement (lien direct de régularisation).
    if (result.client_impaye) {
      try {
        const { subject, html } = this.mailService.impayeEchecHtml(result.client_impaye.nom, result.client_impaye.lien);
        await this.mailService.sendEmail(result.client_impaye.email, subject, html);
      } catch (e) {
        this.logger.error(`webhook mail impayé client: ${e instanceof Error ? e.message : e}`);
      }
    }
    // Facture au CLIENT (paiement d'abonnement réussi ou achat de pack).
    if (result.facture) {
      try {
        const { subject, html } = this.mailService.factureHtml(
          result.facture.nom,
          result.facture.montant,
          result.facture.devise,
          result.facture.libelle,
          result.facture.numero ?? undefined,
          result.facture.url ?? undefined,
          result.facture.pdf ?? undefined,
        );
        await this.mailService.sendEmail(result.facture.email, subject, html);
      } catch (e) {
        this.logger.error(`webhook facture client: ${e instanceof Error ? e.message : e}`);
      }
    }
    // Rappel au CLIENT, trois jours avant le premier prélèvement.
    if (result.rappel) {
      try {
        const { subject, html } = this.mailService.rappelPrelevementHtml(
          result.rappel.nom,
          result.rappel.montant,
          result.rappel.devise,
          result.rappel.date,
          `${this.frontendUrl}/dashboard/parametres?s=abonnement`,
          result.rappel.apres_pack,
        );
        await this.mailService.sendEmail(result.rappel.email, subject, html);
      } catch (e) {
        this.logger.error(`webhook rappel client: ${e instanceof Error ? e.message : e}`);
      }
    }
    return result;
  }
}
