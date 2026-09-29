import { BadRequestException, Body, Controller, Get, Logger, NotFoundException, Param, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { clientIp } from '../../common/utils/client-ip.util';
import { JwtPayload } from '../auth/auth.service';
import { AdminGuard } from '../auth/guards/admin.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../../config/prisma.service';
import { AffiliationService } from './affiliation.service';
import { AdminDeciderDto } from './dto/admin-decider.dto';
import { DemandeDto } from './dto/demande.dto';
import { MonIbanDto } from './dto/mon-iban.dto';

type AuthedRequest = Request & { user: JwtPayload };

/** Port direct de backend/routes/affiliation.py.
 *
 * Trois familles de routes : PUBLIQUE (le lien de tracking), AFFILIÉ (demande, tableau
 * de bord, relevés), ADMIN (validation, commissions, traitement mensuel, IBAN). */
@Controller('affiliation')
export class AffiliationController {
  private readonly logger = new Logger(AffiliationController.name);
  private readonly frontendUrl: string;

  constructor(
    private readonly affiliationService: AffiliationService,
    private readonly mailService: MailService,
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.frontendUrl = config.get<string>('app.frontendUrl') || 'http://localhost:3000';
  }

  // ------------------------------------------------------------------ publique

  /** Lien d'affiliation. Loge le clic puis renvoie sur le site avec ?ref=CODE, que le
   * front stocke pour la durée de la fenêtre d'attribution. */
  @Get('r/:code')
  async rediriger(@Param('code') code: string, @Query('vers') versQ: string | undefined, @Req() req: Request, @Res() res: Response) {
    const a = await this.affiliationService.enregistrerClic(code, clientIp(req), req.headers['user-agent'] as string, req.headers['referer'] as string);
    const cible = versQ && versQ.startsWith('/') ? versQ : '/';
    if (!a) return res.redirect(302, `${this.frontendUrl}${cible}`);
    const sep = cible.includes('?') ? '&' : '?';
    return res.redirect(302, `${this.frontendUrl}${cible}${sep}ref=${a.code}`);
  }

  /** Le front s'en sert pour n'afficher « parrainé par X » que si le code est bon. */
  @Get('verifier/:code')
  async verifier(@Param('code') code: string) {
    const a = await this.affiliationService.parCode(code);
    return { valide: Boolean(a), nom: a?.nom ?? null };
  }

  // ------------------------------------------------------------------- affilié

  /** Un client demande à devenir apporteur d'affaires. Statut « en_attente » jusqu'à
   * validation d'un admin : le lien ne convertit pas avant. */
  @Post('demande')
  @UseGuards(JwtAuthGuard)
  async demande(@Body() body: DemandeDto, @Req() req: AuthedRequest) {
    try {
      const a = await this.affiliationService.demander(body.nom, body.email, body.iban, req.user.telegram_id, body.audience);
      return { code: a.code, statut: a.statut };
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : String(e));
    }
  }

  /** Influenceur ou blogueur sans compte client : même formulaire, sans jeton. */
  @Post('demande-externe')
  async demandeExterne(@Body() body: DemandeDto) {
    try {
      const a = await this.affiliationService.demander(body.nom, body.email, body.iban, undefined, body.audience);
      return { statut: a.statut };
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : String(e));
    }
  }

  @Get('moi')
  @UseGuards(JwtAuthGuard)
  async moi(@Req() req: AuthedRequest) {
    const a = await this.affiliationService.parTelegram(req.user.telegram_id);
    if (!a) return { affilie: null };
    const tb = a.statut === 'actif' ? await this.affiliationService.tableauDeBord(a.id) : {};
    return {
      affilie: {
        code: a.code,
        statut: a.statut,
        nom: a.nom,
        email: a.email,
        taux_setup: a.taux_setup,
        taux_recurrent: a.taux_recurrent,
        iban: this.affiliationService.masquerIban(a.iban_chiffre),
        motif: a.motif,
        lien: `${this.frontendUrl}/?ref=${a.code}`,
      },
      ...tb,
    };
  }

  @Get('mes-releves')
  @UseGuards(JwtAuthGuard)
  async mesReleves(@Req() req: AuthedRequest) {
    const a = await this.affiliationService.parTelegram(req.user.telegram_id);
    return a ? this.affiliationService.releves(a.id) : [];
  }

  @Put('mon-iban')
  @UseGuards(JwtAuthGuard)
  async monIban(@Body() body: MonIbanDto, @Req() req: AuthedRequest) {
    const a = await this.affiliationService.parTelegram(req.user.telegram_id);
    if (!a) throw new NotFoundException('Pas de compte affilié');
    await this.prisma.affiliates.update({ where: { id: a.id }, data: { iban_chiffre: this.affiliationService.chiffrerIban(body.iban) } });
    return { ok: true };
  }

  // --------------------------------------------------------------------- admin

  @Get('admin/affilies')
  @UseGuards(AdminGuard)
  async adminAffilies(@Query('statut') statut: string | undefined) {
    return this.affiliationService.listeAffilies(statut);
  }

  /** Valide, refuse ou suspend une demande ; ajuste aussi les taux négociés. */
  @Put('admin/affilies/:affiliateId')
  @UseGuards(AdminGuard)
  async adminDecider(@Param('affiliateId') affiliateId: string, @Body() body: AdminDeciderDto, @Req() req: AuthedRequest) {
    if (body.statut) await this.affiliationService.decider(affiliateId, body.statut, req.user.telegram_id, body.motif);
    if (body.taux_setup !== undefined || body.taux_recurrent !== undefined) {
      await this.affiliationService.majTaux(affiliateId, body.taux_setup, body.taux_recurrent);
    }
    return { ok: true };
  }

  /** RIB en clair, pour le virement. Chaque lecture est tracée dans les logs. */
  @Get('admin/affilies/:affiliateId/iban')
  @UseGuards(AdminGuard)
  async adminIban(@Param('affiliateId') affiliateId: string, @Req() req: AuthedRequest) {
    this.logger.warn(`AUDIT iban affilié ${affiliateId} lu par admin ${req.user.telegram_id}`);
    return { iban: await this.affiliationService.ibanClair(affiliateId) };
  }

  /** periode au format AAAA-MM : c'est le filtre mois par mois. */
  @Get('admin/commissions')
  @UseGuards(AdminGuard)
  async adminCommissions(@Query('periode') periode: string | undefined, @Query('statut') statut: string | undefined, @Query('affiliate_id') affiliateId: string | undefined) {
    return this.affiliationService.commissions(periode, statut, affiliateId);
  }

  /** Qui a vendu ce mois-là, combien de ventes, quel chiffre, quelle commission. */
  @Get('admin/resume/:periode')
  @UseGuards(AdminGuard)
  async adminResume(@Param('periode') periode: string) {
    return this.affiliationService.resumeMois(periode);
  }

  @Post('admin/commissions/:commissionId/valider')
  @UseGuards(AdminGuard)
  async adminValider(@Param('commissionId') commissionId: string) {
    return this.affiliationService.valider(commissionId);
  }

  @Post('admin/commissions/:commissionId/annuler')
  @UseGuards(AdminGuard)
  async adminAnnuler(@Param('commissionId') commissionId: string) {
    return this.affiliationService.annuler(commissionId);
  }

  /** Clôture le mois : regroupe les commissions validées par affilié et par devise, crée
   * les relevés, et prévient chaque affilié qu'il peut facturer. */
  @Post('admin/traitement-mensuel/:periode')
  @UseGuards(AdminGuard)
  async adminTraitement(@Param('periode') periode: string) {
    const envois = await this.affiliationService.traitementMensuel(periode);
    for (const e of envois) {
      if (!e.email) continue;
      try {
        const { subject, html } = this.mailService.releveAffilieHtml(e.nom, e.periode, e.montant, e.devise, e.nb);
        await this.mailService.sendEmail(e.email, subject, html);
      } catch (ex) {
        this.logger.error(`relevé affilié non envoyé à ${e.email}: ${ex instanceof Error ? ex.message : ex}`);
      }
    }
    return { releves: envois.length, detail: envois };
  }

  @Get('admin/releves')
  @UseGuards(AdminGuard)
  async adminReleves(@Query('periode') periode: string | undefined) {
    return this.affiliationService.tousReleves(periode);
  }

  /** Le virement est parti : le relevé et ses commissions passent à « payée ». */
  @Post('admin/releves/:releveId/payer')
  @UseGuards(AdminGuard)
  async adminPayer(@Param('releveId') releveId: string) {
    return this.affiliationService.marquerPaye(releveId);
  }
}
