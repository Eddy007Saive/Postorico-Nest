import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AdminGuard } from '../auth/guards/admin.guard';
import { AbonnementDto } from './dto/abonner.dto';
import { NewsletterService } from './newsletter.service';

/**
 * Newsletter hebdomadaire « La lettre de Rico » — port direct de backend/routes/newsletter.py.
 *
 * Routes PUBLIQUES (cliquées depuis un email, donc sans jeton d'auth : c'est le
 * token de la ligne en base qui fait foi) : aperçu, valider, refuser, désinscription,
 * inscription. Routes ADMIN : liste des éditions, abonnés, préparation forcée.
 */
@Controller('newsletter')
export class NewsletterController {
  constructor(private readonly newsletterService: NewsletterService) {}

  // ----------------------------------------------------------------- publiques
  /** La lettre telle qu'elle sera reçue (lien « Lire dans le navigateur »). */
  @Get('apercu/:nid')
  async apercu(@Param('nid') nid: string, @Query('token') token: string, @Res() res: Response) {
    const nl = await this.newsletterService.charger(nid, token);
    if (!nl) {
      res.status(404).send(this.newsletterService.page('Lien invalide', "Cette lettre n'existe pas ou le lien a expiré.", false));
      return;
    }
    if (nl.html) {
      res.send(nl.html);
      return;
    }
    res.send(this.newsletterService.renduHtml((nl.data as any) || {}));
  }

  /** Bouton « Envoyer aux abonnés » de l'email de validation. */
  @Get('valider/:nid')
  async valider(@Param('nid') nid: string, @Query('token') token: string, @Res() res: Response) {
    res.send(await this.newsletterService.valider(nid, token));
  }

  @Get('refuser/:nid')
  async refuser(@Param('nid') nid: string, @Query('token') token: string, @Res() res: Response) {
    res.send(await this.newsletterService.refuser(nid, token));
  }

  @Get('desinscription')
  async desinscription(@Query('token') token: string, @Res() res: Response) {
    if (token === 'apercu') {
      // lien neutre des aperçus internes
      res.send(this.newsletterService.page('Aperçu', "Ceci est un aperçu : aucun abonné n'est concerné par ce lien."));
      return;
    }
    const result = await this.newsletterService.desabonner(token);
    if (result.error) {
      res.status(404).send(this.newsletterService.page('Lien inconnu', result.error, false));
      return;
    }
    res.send(this.newsletterService.page("C'est fait", 'Tu ne recevras plus la lettre de Rico. Tu peux te réinscrire quand tu veux.'));
  }

  /** Désinscription One-Click (en-tête List-Unsubscribe-Post) : Gmail/Outlook appellent
   * cette URL en POST sans ouvrir de page. */
  @Post('desinscription')
  @HttpCode(200)
  async desinscriptionOneClick(@Query('token') token: string) {
    await this.newsletterService.desabonner(token);
    return 'OK';
  }

  /** Inscription depuis le site public (formulaire newsletter). */
  @Post('abonner')
  async abonner(@Body() body: AbonnementDto) {
    const res = await this.newsletterService.abonner(body.email, body.nom, 'site');
    if (res.error) throw new BadRequestException(res.error);
    return { ok: true };
  }

  // --------------------------------------------------------------------- admin
  /** Historique des éditions (sans le HTML, trop lourd). */
  @Get('editions')
  @UseGuards(AdminGuard)
  async editions() {
    return { editions: await this.newsletterService.editions() };
  }

  @Get('abonnes')
  @UseGuards(AdminGuard)
  async abonnesAdmin() {
    return this.newsletterService.abonnes();
  }

  /** Force la préparation d'une édition (le cron le fait chaque semaine). */
  @Post('preparer')
  @UseGuards(AdminGuard)
  async preparer() {
    const res = await this.newsletterService.preparer();
    if (res.error) throw new BadRequestException(res.error);
    return res;
  }

  @Post('sync-abonnes')
  @UseGuards(AdminGuard)
  async syncAbonnes() {
    return { ajoutes: await this.newsletterService.syncAbonnes() };
  }
}