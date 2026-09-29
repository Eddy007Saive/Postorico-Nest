import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { refusQuota } from '../../common/utils/agent-http-errors';
import { PrismaService } from '../../config/prisma.service';
import { JwtPayload } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { DemarrageService } from '../demarrage/demarrage.service';
import { QuotaService } from '../quota/quota.service';
import { GabaritAutoDto } from './dto/gabarit-auto.dto';
import { GabaritRenderDto } from './dto/gabarit-render.dto';
import { GabaritComposeService } from './gabarit-compose.service';
import { GabaritService } from './gabarit.service';
import { GAB_LABELS, GABARITS } from './templates/gabarit-builders';

type AuthedRequest = Request & { user: JwtPayload };

@Controller('agent')
@UseGuards(JwtAuthGuard)
export class GabaritController {
  private readonly logger = new Logger(GabaritController.name);

  constructor(
    private readonly gabaritService: GabaritService,
    private readonly gabaritComposeService: GabaritComposeService,
    private readonly demarrageService: DemarrageService,
    private readonly quotaService: QuotaService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('gabarits')
  listGabarits() {
    return { gabarits: GABARITS, labels: GAB_LABELS };
  }

  @Get('gabarit/previews')
  gabaritPreviews() {
    return this.gabaritService.previews();
  }

  /** Rend un gabarit à partir de slots déjà remplis (édition manuelle ou après `/gabarit/auto`).
   * Gratuit : le coût IA a déjà été payé à la composition des slots, ou il n'y en a pas eu. */
  @Post('gabarit/render')
  async renderGabarit(@Body() dto: GabaritRenderDto, @Req() req: AuthedRequest) {
    const telegramId = req.user.telegram_id;
    const res = await this.gabaritService.renderGabarit(telegramId, dto.gabarit, dto.slots || {});
    if (!res.ok) {
      throw new HttpException(res.error || 'Échec du rendu', HttpStatus.BAD_GATEWAY);
    }
    if (dto.contenu_id) {
      try {
        await this.prisma.contenu.updateMany({
          where: { id: dto.contenu_id, telegram_id: telegramId },
          data: { lien_visuel: res.url },
        });
      } catch (e) {
        this.logger.warn(`gabarit attach contenu ${dto.contenu_id}: ${e instanceof Error ? e.message : e}`);
      }
    }
    return res;
  }

  /** Compose les slots depuis le texte du post (IA) puis rend le visuel et le rattache. */
  @Post('gabarit/auto')
  async gabaritAuto(@Body() dto: GabaritAutoDto, @Req() req: AuthedRequest) {
    const telegramId = req.user.telegram_id;
    const texte = dto.texte || '';

    await this.demarrageService.exigerProfil(telegramId);
    // Le gabarit produit un visuel via l'IA (composition du texte) -> décompté comme 1 image standard.
    const q = await this.quotaService.consume(telegramId, 'image_standard');
    if (!q.ok) throw refusQuota(q);

    let slots: Record<string, unknown>;
    let res: Awaited<ReturnType<GabaritService['renderGabarit']>>;
    try {
      const comp = await this.gabaritComposeService.composerGabarit(telegramId, dto.gabarit, texte);
      if ('error' in comp) {
        await this.quotaService.refund(q);
        if (comp.error === 'no_api_key') {
          throw new InternalServerErrorException('Clé API IA non configurée');
        }
        throw new HttpException('Impossible de composer le visuel.', HttpStatus.BAD_GATEWAY);
      }
      slots = comp.slots;
      if (dto.bg_image) slots.bg_image = dto.bg_image;
      res = await this.gabaritService.renderGabarit(telegramId, dto.gabarit, slots);
      if (!res.ok) {
        await this.quotaService.refund(q);
        throw new HttpException(res.error || 'Échec du rendu', HttpStatus.BAD_GATEWAY);
      }
    } catch (e: unknown) {
      if (e instanceof HttpException) throw e;
      await this.quotaService.refund(q);
      this.logger.error(`gabarit auto error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
    await this.quotaService.confirm(q);

    if (dto.contenu_id) {
      try {
        await this.prisma.contenu.updateMany({
          where: { id: dto.contenu_id, telegram_id: telegramId },
          data: { lien_visuel: res.url },
        });
      } catch (e) {
        this.logger.warn(`gabarit auto attach ${dto.contenu_id}: ${e instanceof Error ? e.message : e}`);
      }
    }
    return { url: res.url, slots, gabarit: dto.gabarit, quota: { action: 'image_standard', used: q.used, limit: q.limit } };
  }
}
