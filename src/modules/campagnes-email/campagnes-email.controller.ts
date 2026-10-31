import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  Logger,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { JwtPayload } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  ConnecterBoiteDto,
  ContactsDto,
  CreerCampagneDto,
  EcrireDto,
  MailDestinataireDto,
  ModifierCampagneDto,
  RedigerDto,
  RepondreDto,
} from './campagnes-email.dto';
import {
  CampagnesEmailService,
  ErreurCampagne,
} from './campagnes-email.service';

type AuthedRequest = Request & { user: JwtPayload };

/** Écran « Emails » : boîte mail connectée, boîte de réception, petites campagnes. */
@Controller('emails')
export class CampagnesEmailController {
  private readonly logger = new Logger(CampagnesEmailController.name);
  private readonly frontendUrl: string;

  constructor(
    private readonly service: CampagnesEmailService,
    config: ConfigService,
  ) {
    this.frontendUrl =
      config.get<string>('app.frontendUrl') || 'http://localhost:3000';
  }

  /** Les erreurs métier gardent leur message français et leur statut. */
  private async exec<T>(f: () => Promise<T>): Promise<T> {
    try {
      return await f();
    } catch (e) {
      if (e instanceof ErreurCampagne)
        throw new HttpException({ message: e.message }, e.statut);
      throw e;
    }
  }

  /** Retour de l'OAuth Zernio (public, comme /late/oauth-callback). */
  @Get('oauth-callback')
  async oauthCallback(
    @Query('telegram_id') telegramId: string,
    @Query('fournisseur') fournisseur: string,
    @Query('accountId') accountId: string | undefined,
    @Res() res: Response,
  ) {
    let ok = false;
    try {
      ok = await this.service.finaliser(telegramId, fournisseur, accountId);
    } catch (e) {
      this.logger.error(
        `oauth-callback boîte ${telegramId}: ${e instanceof Error ? e.message : e}`,
      );
    }
    const titre = ok ? 'Boîte mail connectée ✅' : 'Connexion échouée';
    const detail = ok
      ? 'Tu peux fermer cette fenêtre.'
      : "Réessaie depuis l'application.";
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>${titre}</title><style>
body{font-family:-apple-system,Segoe UI,sans-serif;background:#020617;color:#e8edf6;display:grid;place-items:center;height:100vh;margin:0;text-align:center}
.c{max-width:360px;padding:24px}h1{font-size:20px;margin:0 0 8px}p{color:#93a1b8;font-size:14px}
</style></head><body><div class="c"><h1>${titre}</h1><p>${detail}</p></div>
<script>try{window.close();}catch(e){} setTimeout(function(){try{window.close();}catch(e){} location.replace('${this.frontendUrl}/dashboard/emails');}, 1200);</script>
</body></html>`);
  }

  // ------------------------------------------------------------ boîte

  @Get('boite')
  @UseGuards(JwtAuthGuard)
  boite(@Req() req: AuthedRequest) {
    return this.exec(() => this.service.boite(req.user.telegram_id));
  }

  @Post('boite/connecter')
  @UseGuards(JwtAuthGuard)
  connecter(@Req() req: AuthedRequest, @Body() dto: ConnecterBoiteDto) {
    return this.exec(() =>
      this.service.connecter(
        req.user.telegram_id,
        dto.fournisseur,
        dto.adresse,
      ),
    );
  }

  @Delete('boite')
  @UseGuards(JwtAuthGuard)
  deconnecter(@Req() req: AuthedRequest) {
    return this.exec(() => this.service.deconnecter(req.user.telegram_id));
  }

  // ------------------------------------------------------------ réception

  @Get('fils')
  @UseGuards(JwtAuthGuard)
  fils(
    @Req() req: AuthedRequest,
    @Query('dossier') dossier?: string,
    @Query('suite') suite?: string,
    @Query('q') q?: string,
  ) {
    return this.exec(() =>
      this.service.fils(req.user.telegram_id, dossier, suite, q),
    );
  }

  @Get('fils/:id')
  @UseGuards(JwtAuthGuard)
  fil(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.exec(() => this.service.fil(req.user.telegram_id, id));
  }

  @Post('fils/:id/repondre')
  @UseGuards(JwtAuthGuard)
  repondre(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() dto: RepondreDto,
  ) {
    return this.exec(() =>
      this.service.repondre(req.user.telegram_id, id, dto.texte),
    );
  }

  @Post('fils/:id/suggestion')
  @UseGuards(JwtAuthGuard)
  suggestion(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.exec(() =>
      this.service.suggererReponse(req.user.telegram_id, id),
    );
  }

  @Post('ecrire')
  @UseGuards(JwtAuthGuard)
  ecrire(@Req() req: AuthedRequest, @Body() dto: EcrireDto) {
    return this.exec(() => this.service.ecrire(req.user.telegram_id, dto));
  }

  // ------------------------------------------------------------ campagnes

  @Get('campagnes')
  @UseGuards(JwtAuthGuard)
  liste(@Req() req: AuthedRequest) {
    return this.exec(() => this.service.liste(req.user.telegram_id));
  }

  @Post('campagnes')
  @UseGuards(JwtAuthGuard)
  creer(@Req() req: AuthedRequest, @Body() dto: CreerCampagneDto) {
    return this.exec(() => this.service.creer(req.user.telegram_id, dto));
  }

  @Get('campagnes/:id')
  @UseGuards(JwtAuthGuard)
  detail(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.exec(() => this.service.detail(req.user.telegram_id, id));
  }

  @Patch('campagnes/:id')
  @UseGuards(JwtAuthGuard)
  modifier(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() dto: ModifierCampagneDto,
  ) {
    return this.exec(() =>
      this.service.modifier(req.user.telegram_id, id, dto),
    );
  }

  @Delete('campagnes/:id')
  @UseGuards(JwtAuthGuard)
  supprimer(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.exec(() => this.service.supprimer(req.user.telegram_id, id));
  }

  @Post('campagnes/:id/contacts')
  @UseGuards(JwtAuthGuard)
  ajouter(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() dto: ContactsDto,
  ) {
    return this.exec(() =>
      this.service.ajouterContacts(req.user.telegram_id, id, dto.contacts),
    );
  }

  @Delete('campagnes/:id/destinataires/:destId')
  @UseGuards(JwtAuthGuard)
  retirer(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Param('destId') destId: string,
  ) {
    return this.exec(() =>
      this.service.retirerDestinataire(req.user.telegram_id, id, destId),
    );
  }

  @Patch('campagnes/:id/destinataires/:destId')
  @UseGuards(JwtAuthGuard)
  modifierMail(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Param('destId') destId: string,
    @Body() dto: MailDestinataireDto,
  ) {
    return this.exec(() =>
      this.service.modifierDestinataire(req.user.telegram_id, id, destId, dto),
    );
  }

  @Post('campagnes/:id/rediger')
  @UseGuards(JwtAuthGuard)
  rediger(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() dto: RedigerDto,
  ) {
    return this.exec(() =>
      this.service.rediger(req.user.telegram_id, id, Boolean(dto?.tout)),
    );
  }

  @Post('campagnes/:id/lancer')
  @UseGuards(JwtAuthGuard)
  lancer(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.exec(() => this.service.lancer(req.user.telegram_id, id));
  }

  @Post('campagnes/:id/pause')
  @UseGuards(JwtAuthGuard)
  pause(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.exec(() => this.service.pause(req.user.telegram_id, id));
  }
}
