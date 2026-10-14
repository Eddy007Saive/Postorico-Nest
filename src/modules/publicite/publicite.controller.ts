import {
  Body,
  Controller,
  Get,
  HttpException,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtPayload } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { BoostDto, ConseilDto, StatutPubDto } from './publicite.dto';
import { ErreurPublicite, PubliciteService } from './publicite.service';

type AuthedRequest = Request & { user: JwtPayload };

/** Écran « Publicité » : booster un post publié, suivre les pubs Meta, pause et reprise. */
@Controller('publicite')
@UseGuards(JwtAuthGuard)
export class PubliciteController {
  constructor(private readonly service: PubliciteService) {}

  /** Les erreurs métier gardent leur message français et leur statut. */
  private async exec<T>(f: () => Promise<T>): Promise<T> {
    try {
      return await f();
    } catch (e) {
      if (e instanceof ErreurPublicite)
        throw new HttpException({ message: e.message }, e.statut);
      throw e;
    }
  }

  @Get('etat')
  etat(@Req() req: AuthedRequest) {
    return this.exec(() => this.service.etat(req.user.telegram_id));
  }

  @Get('pubs')
  pubs(
    @Req() req: AuthedRequest,
    @Query('compte_pub') comptePub: string,
    @Query('du') du?: string,
    @Query('au') au?: string,
  ) {
    return this.exec(() =>
      this.service.pubs(req.user.telegram_id, comptePub, du, au),
    );
  }

  @Put('pubs/:id/statut')
  statut(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() dto: StatutPubDto,
  ) {
    return this.exec(() =>
      this.service.changerStatut(req.user.telegram_id, id, dto.allumer),
    );
  }

  @Get('lieux')
  lieux(
    @Req() req: AuthedRequest,
    @Query('q') q: string,
    @Query('pays') pays?: string,
  ) {
    return this.exec(() => this.service.lieux(req.user.telegram_id, q, pays));
  }

  @Post('booster')
  booster(@Req() req: AuthedRequest, @Body() dto: BoostDto) {
    return this.exec(() => this.service.booster(req.user.telegram_id, dto));
  }

  @Post('conseil')
  conseil(@Req() req: AuthedRequest, @Body() dto: ConseilDto) {
    return this.exec(() =>
      this.service.conseil(req.user.telegram_id, dto.contenu_id),
    );
  }
}
