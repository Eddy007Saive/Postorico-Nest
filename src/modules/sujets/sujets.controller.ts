import {
  Body,
  Controller,
  Delete,
  Get,
  InternalServerErrorException,
  Logger,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { mapAgentError, refusQuota } from '../../common/utils/agent-http-errors';
import { PrismaService } from '../../config/prisma.service';
import { JwtPayload } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { DemarrageService } from '../demarrage/demarrage.service';
import { DimensionsService } from '../dimensions/dimensions.service';
import { QuotaService } from '../quota/quota.service';
import { UsageService } from '../usage/usage.service';
import { GenererSujetsDto } from './dto/generer-sujets.dto';
import { MajSujetDto } from './dto/maj-sujet.dto';
import { SujetGenere } from './interfaces/sujet-genere.interface';
import { SUJETS_MODEL, SujetsService } from './sujets.service';

type AuthedRequest = Request & { user: JwtPayload };

@Controller('agent')
@UseGuards(JwtAuthGuard)
export class SujetsController {
  private readonly logger = new Logger(SujetsController.name);

  constructor(
    private readonly sujetsService: SujetsService,
    private readonly dimensionsService: DimensionsService,
    private readonly demarrageService: DemarrageService,
    private readonly quotaService: QuotaService,
    private readonly usageService: UsageService,
    private readonly prisma: PrismaService,
  ) {}

  private dims(s: SujetGenere): Record<string, string> | undefined {
    const out: Record<string, string> = {};
    for (const k of ['objectif', 'angle', 'cible', 'format', 'offre'] as const) {
      if (s[k]) out[k] = s[k] as string;
    }
    return Object.keys(out).length ? out : undefined;
  }

  @Post('sujets')
  async sujets(@Body() dto: GenererSujetsDto, @Req() req: AuthedRequest) {
    const telegramId = req.user.telegram_id;
    await this.demarrageService.exigerProfil(telegramId); // profil de marque minimum, avant de consommer
    const q = await this.quotaService.consume(telegramId, 'subject');
    if (!q.ok) throw refusQuota(q);

    let result: Awaited<ReturnType<SujetsService['genererSujets']>>;
    try {
      result = await this.sujetsService.genererSujets(telegramId, dto.nombre ?? 6, dto.filtres);
    } catch (e: unknown) {
      await this.quotaService.refund(q);
      this.logger.error(`Agent sujets error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
    if ('error' in result) {
      await this.quotaService.refund(q);
      mapAgentError(result.error);
    }
    await this.quotaService.confirm(q);
    await this.usageService.log(telegramId, 'sujets', SUJETS_MODEL, result.usage, q.unit_cost ?? 0);

    // Sauvegarde des sujets comme brouillons (sans réseau — choisi à la transformation).
    // dimensions = valeur EFFECTIVE (modifiable) ; dimensions_reco = reco d'origine de l'IA (fige l'⭐).
    const sujets = result.sujets.filter((s) => s.sujet);
    let saved: Array<{ id: string | null; titre: string; dimensions: unknown; dimensions_reco: unknown }> = [];
    if (sujets.length) {
      try {
        const rows = await this.prisma.brouillons.createManyAndReturn({
          data: sujets.map((s) => ({
            telegram_id: telegramId,
            titre: s.sujet.slice(0, 200),
            statut: 'Brouillon' as const,
            dimensions: this.dims(s) ?? undefined,
            dimensions_reco: this.dims(s) ?? undefined,
          })),
        });
        saved = rows.map((r) => ({
          id: r.id,
          titre: r.titre ?? '',
          dimensions: r.dimensions,
          dimensions_reco: r.dimensions_reco,
        }));
      } catch (e) {
        this.logger.error(`Save sujets error: ${e instanceof Error ? e.message : e}`);
        saved = sujets.map((s) => ({ id: null, titre: s.sujet, dimensions: this.dims(s), dimensions_reco: this.dims(s) }));
      }
    }
    return { sujets: saved, quota: { action: 'subject', used: q.used, limit: q.limit } };
  }

  /** Les listes de valeurs des 4 dimensions d'un sujet (objectif/angle/cible/format).
   * Le 'format' est filtré sur les réseaux connectés (pas de Reel sans compte adapté). */
  @Get('dimensions')
  async dimensions(@Req() req: AuthedRequest) {
    return this.dimensionsService.dimensionsPour(req.user.telegram_id);
  }

  @Get('sujets')
  async listSujets(@Req() req: AuthedRequest) {
    try {
      return await this.prisma.brouillons.findMany({
        where: { telegram_id: req.user.telegram_id, statut: 'Brouillon' },
        select: { id: true, titre: true, reseau_cible: true, dimensions: true, dimensions_reco: true, created_at: true },
        orderBy: { created_at: 'desc' },
      });
    } catch (e) {
      this.logger.error(`List sujets error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
  }

  /** Enregistre les dimensions EFFECTIVES d'un sujet (override utilisateur).
   * dimensions_reco (l'⭐) n'est jamais touché : on garde la reco d'origine de l'IA. */
  @Patch('sujets/:id')
  async majSujet(@Param('id') id: string, @Body() dto: MajSujetDto, @Req() req: AuthedRequest) {
    const dimsIn = dto.dimensions ?? {};
    const dims: Record<string, string> = {};
    for (const cle of ['objectif', 'angle', 'cible', 'format']) {
      const v = this.dimensionsService.validerDimension(cle, dimsIn[cle]);
      if (v) dims[cle] = v;
    }
    const offre = await this.dimensionsService.validerOffre(req.user.telegram_id, dimsIn.offre);
    if (offre) dims.offre = offre;
    try {
      await this.prisma.brouillons.updateMany({
        where: { id, telegram_id: req.user.telegram_id },
        data: { dimensions: Object.keys(dims).length ? dims : undefined },
      });
      return { success: true, dimensions: dims };
    } catch (e) {
      this.logger.error(`Maj sujet dimensions error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
  }

  @Delete('sujets/:id')
  async deleteSujet(@Param('id') id: string, @Req() req: AuthedRequest) {
    try {
      await this.prisma.brouillons.deleteMany({ where: { id, telegram_id: req.user.telegram_id } });
      return { success: true };
    } catch (e) {
      this.logger.error(`Delete sujet error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
  }
}
