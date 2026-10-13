import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtPayload } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  EtablissementDto,
  InfosFicheDto,
  LienFicheDto,
  PhotoFicheDto,
  ReponseAvisDto,
  SuggestionAvisDto,
} from './google-business.dto';
import {
  ErreurFicheGoogle,
  GoogleBusinessService,
} from './google-business.service';

type AuthedRequest = Request & { user: JwtPayload };

/** Écran « Fiche Google » : avis, photos, infos et horaires, liens d'action, établissements. */
@Controller('google-business')
@UseGuards(JwtAuthGuard)
export class GoogleBusinessController {
  constructor(private readonly service: GoogleBusinessService) {}

  /** Les erreurs métier gardent leur message français et leur statut. */
  private async exec<T>(f: () => Promise<T>): Promise<T> {
    try {
      return await f();
    } catch (e) {
      if (e instanceof ErreurFicheGoogle)
        throw new HttpException({ message: e.message }, e.statut);
      throw e;
    }
  }

  @Get('avis')
  avis(@Req() req: AuthedRequest, @Query('suite') suite?: string) {
    return this.exec(() => this.service.avis(req.user.telegram_id, suite));
  }

  @Post('avis/suggestion')
  suggestion(@Req() req: AuthedRequest, @Body() dto: SuggestionAvisDto) {
    return this.exec(() =>
      this.service.suggererReponse(req.user.telegram_id, dto),
    );
  }

  @Post('avis/:id/reponse')
  repondre(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() dto: ReponseAvisDto,
  ) {
    return this.exec(() =>
      this.service.repondre(req.user.telegram_id, id, dto.message),
    );
  }

  @Delete('avis/:id/reponse')
  supprimerReponse(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.exec(() =>
      this.service.supprimerReponse(req.user.telegram_id, id),
    );
  }

  @Get('photos')
  photos(@Req() req: AuthedRequest) {
    return this.exec(() => this.service.photos(req.user.telegram_id));
  }

  @Post('photos')
  ajouterPhoto(@Req() req: AuthedRequest, @Body() dto: PhotoFicheDto) {
    return this.exec(() =>
      this.service.ajouterPhoto(req.user.telegram_id, dto),
    );
  }

  @Delete('photos/:id')
  supprimerPhoto(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.exec(() =>
      this.service.supprimerPhoto(req.user.telegram_id, id),
    );
  }

  @Get('infos')
  infos(@Req() req: AuthedRequest) {
    return this.exec(() => this.service.infos(req.user.telegram_id));
  }

  @Patch('infos')
  majInfos(@Req() req: AuthedRequest, @Body() dto: InfosFicheDto) {
    return this.exec(() =>
      this.service.majInfos(req.user.telegram_id, {
        ...dto,
        horaires: dto.horaires,
      }),
    );
  }

  @Post('infos/description')
  description(@Req() req: AuthedRequest) {
    return this.exec(() =>
      this.service.genererDescription(req.user.telegram_id),
    );
  }

  @Get('liens')
  liens(@Req() req: AuthedRequest) {
    return this.exec(() => this.service.liens(req.user.telegram_id));
  }

  @Post('liens')
  ajouterLien(@Req() req: AuthedRequest, @Body() dto: LienFicheDto) {
    return this.exec(() => this.service.ajouterLien(req.user.telegram_id, dto));
  }

  /** id = nom de ressource Google du lien (contient des « / ») : passé en paramètre de requête. */
  @Delete('liens')
  supprimerLien(@Req() req: AuthedRequest, @Query('id') id: string) {
    return this.exec(() =>
      this.service.supprimerLien(req.user.telegram_id, id),
    );
  }

  @Get('etablissements')
  etablissements(@Req() req: AuthedRequest) {
    return this.exec(() => this.service.etablissements(req.user.telegram_id));
  }

  @Put('etablissements')
  choisirEtablissement(
    @Req() req: AuthedRequest,
    @Body() dto: EtablissementDto,
  ) {
    return this.exec(() =>
      this.service.choisirEtablissement(req.user.telegram_id, dto.id),
    );
  }
}
