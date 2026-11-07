import { Controller, Get, Logger, Param, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { PrismaService } from '../../config/prisma.service';
import { cibleValide, GIF_TRANSPARENT, signatureValide } from './suivi-email.util';

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Adresses publiques (sans connexion) appelées par la messagerie du destinataire :
 *  - GET /api/s/o/<destinataire>.<signature>.gif : image invisible -> ouverture ;
 *  - GET /api/s/c/<destinataire>?u=<lien>&s=<signature> : relais d'un lien -> clic, puis redirection.
 * Une signature fausse ne note rien ; le relais ne redirige que vers le lien signé (jamais un
 * autre site). Le pixel répond toujours une image, même en cas d'erreur.
 */
@Controller('s')
export class SuiviEmailController {
  private readonly logger = new Logger(SuiviEmailController.name);
  private readonly secret: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.secret = config.get<string>('app.jwtSecret') || '';
  }

  @Get('o/:jeton')
  async ouverture(@Param('jeton') jeton: string, @Res() res: Response) {
    const [id, sig] = String(jeton || '').replace(/\.gif$/i, '').split('.');
    if (id && RE_UUID.test(id) && signatureValide(this.secret, id, sig)) {
      await this.prisma.$executeRaw`update campagnes_email_destinataires
        set nb_ouvertures = nb_ouvertures + 1, ouvert_le = coalesce(ouvert_le, now())
        where id = ${id}::uuid`.catch((e) => this.logger.warn(`ouverture ${id}: ${e instanceof Error ? e.message : e}`));
    }
    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Content-Length', String(GIF_TRANSPARENT.length));
    res.end(GIF_TRANSPARENT);
  }

  @Get('c/:id')
  async clic(@Param('id') id: string, @Query('u') u: string, @Query('s') s: string, @Res() res: Response) {
    const url = String(u || '');
    if (!RE_UUID.test(id) || !cibleValide(url) || !signatureValide(this.secret, `${id}|${url}`, s)) {
      res.status(404).send('Lien introuvable.');
      return;
    }
    await this.prisma.$executeRaw`update campagnes_email_destinataires
      set nb_clics = nb_clics + 1, clique_le = coalesce(clique_le, now())
      where id = ${id}::uuid`.catch((e) => this.logger.warn(`clic ${id}: ${e instanceof Error ? e.message : e}`));
    res.redirect(302, url);
  }
}
