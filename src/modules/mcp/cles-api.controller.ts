import { Body, Controller, Delete, Get, NotFoundException, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { JwtPayload } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ClesApiService } from './cles-api.service';
import { documentationMcp } from './documentation';

type AuthedRequest = Request & { user: JwtPayload };

class CreerCleDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  nom?: string;
}

/** Paramètres › Connecteur IA : clés du serveur MCP (réservé au propriétaire du compte,
 * voir acces-equipe.util). */
@Controller('cles-api')
@UseGuards(JwtAuthGuard)
export class ClesApiController {
  constructor(private readonly cles: ClesApiService) {}

  @Get()
  lister(@Req() req: AuthedRequest) {
    return this.cles.lister(req.user.telegram_id);
  }

  /** Référence du connecteur (outils, ressources, missions), pour la page Documentation. */
  @Get('documentation')
  documentation() {
    return documentationMcp();
  }

  /** Ce que les assistants ont fait via le connecteur : ?page=&par_page=&du=&au=&echecs=1 */
  @Get('activite')
  activite(
    @Req() req: AuthedRequest,
    @Query('page') page?: string,
    @Query('par_page') parPage?: string,
    @Query('du') du?: string,
    @Query('au') au?: string,
    @Query('echecs') echecs?: string,
  ) {
    return this.cles.activite(req.user.telegram_id, {
      page: Number(page) || 1,
      parPage: Number(parPage) || 20,
      du,
      au,
      echecs: echecs === '1' || echecs === 'true',
    });
  }

  @Post()
  creer(@Body() dto: CreerCleDto, @Req() req: AuthedRequest) {
    return this.cles.creer(req.user.telegram_id, dto.nom || '');
  }

  @Delete(':id')
  async revoquer(@Param('id') id: string, @Req() req: AuthedRequest) {
    if (!(await this.cles.revoquer(req.user.telegram_id, id))) throw new NotFoundException('Clé introuvable');
    return { success: true };
  }
}
