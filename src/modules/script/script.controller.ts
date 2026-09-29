import { BadRequestException, Body, Controller, InternalServerErrorException, Logger, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { mapAgentError, refusQuota } from '../../common/utils/agent-http-errors';
import { PrismaService } from '../../config/prisma.service';
import { JwtPayload } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { QUALITE_MODELS } from '../claude/claude.service';
import { DemarrageService } from '../demarrage/demarrage.service';
import { QuotaService } from '../quota/quota.service';
import { UsageService } from '../usage/usage.service';
import { EnregistrerScriptDto } from './dto/enregistrer-script.dto';
import { ScriptDto } from './dto/script.dto';
import { ScriptService } from './script.service';

type AuthedRequest = Request & { user: JwtPayload };

@Controller('agent')
@UseGuards(JwtAuthGuard)
export class ScriptController {
  private readonly logger = new Logger(ScriptController.name);

  constructor(
    private readonly scriptService: ScriptService,
    private readonly demarrageService: DemarrageService,
    private readonly quotaService: QuotaService,
    private readonly usageService: UsageService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('script')
  async script(@Body() dto: ScriptDto, @Req() req: AuthedRequest) {
    const telegramId = req.user.telegram_id;
    const sujet = dto.sujet.trim();
    if (!sujet) throw new BadRequestException('sujet requis');
    const qualite = dto.qualite ?? 'equilibre';
    await this.demarrageService.exigerProfil(telegramId); // profil de marque minimum, avant de consommer
    const q = await this.quotaService.consume(telegramId, 'post'); // script vidéo compte comme un post
    if (!q.ok) throw refusQuota(q);

    let result: Awaited<ReturnType<ScriptService['redigerScript']>>;
    try {
      result = await this.scriptService.redigerScript(
        telegramId,
        sujet,
        dto.type_video || 'Reel',
        QUALITE_MODELS[qualite],
        false,
        dto.dimensions,
      );
    } catch (e: unknown) {
      await this.quotaService.refund(q);
      this.logger.error(`Agent script error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
    if ('error' in result) {
      await this.quotaService.refund(q);
      mapAgentError(result.error);
    }
    await this.quotaService.confirm(q);
    await this.usageService.log(telegramId, 'script', QUALITE_MODELS[qualite], result.usage, q.unit_cost ?? 0, qualite);
    return { ...result, quota: { action: 'post', used: q.used, limit: q.limit } };
  }

  /** Enregistre le script (éventuellement édité) dans la table studio. Gratuit. */
  @Post('enregistrer-script')
  async enregistrerScript(@Body() dto: EnregistrerScriptDto, @Req() req: AuthedRequest) {
    const scriptTxt = dto.script.trim();
    if (!scriptTxt) throw new BadRequestException('script requis');
    const titre = (dto.titre || scriptTxt.slice(0, 80)).trim();
    try {
      const row = await this.prisma.studio.create({
        data: {
          telegram_id: req.user.telegram_id,
          titre: titre.slice(0, 120),
          script: scriptTxt,
          type_video: dto.type_video || 'Reel',
        },
      });
      return { success: true, studio_id: row.id };
    } catch (e) {
      this.logger.error(`Agent enregistrer-script error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
  }
}
