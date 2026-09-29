import { Controller, Get, InternalServerErrorException, Logger, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtPayload } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AnalyticsService } from './analytics.service';

type AuthedRequest = Request & { user: JwtPayload };

/** Port direct de backend/routes/analytics.py. */
@Controller('analytics')
@UseGuards(JwtAuthGuard)
export class AnalyticsController {
  private readonly logger = new Logger(AnalyticsController.name);

  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('stats')
  async getStats(@Req() req: AuthedRequest) {
    try {
      return await this.analyticsService.getStats(req.user.telegram_id);
    } catch (e) {
      this.logger.error(`Get stats error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
  }

  @Get('performance')
  async getPerformance(@Req() req: AuthedRequest) {
    try {
      return await this.analyticsService.getPerformance(req.user.telegram_id);
    } catch (e) {
      this.logger.error(`Get performance error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
  }

  /** Performances réelles depuis l'API Late (analytics add-on requis). Vue par défaut
   * (30 j, tous réseaux) servie depuis le cache alimenté par le cron horaire. `refresh=true`
   * ou une vue filtrée force un appel live. */
  @Get('insights')
  async getInsights(@Query('days') daysQ: string | undefined, @Query('platform') platform: string | undefined, @Query('refresh') refreshQ: string | undefined, @Req() req: AuthedRequest) {
    const telegramId = req.user.telegram_id;
    const days = daysQ ? parseInt(daysQ, 10) : 30;
    const refresh = refreshQ === 'true' || refreshQ === '1';
    const isDefault = days === 30 && !platform;
    if (isDefault && !refresh) {
      const cached = await this.analyticsService.getCached(telegramId);
      if (cached?.data) return { ...(cached.data as Record<string, unknown>), cached_at: cached.updated_at };
    }
    const data = await this.analyticsService.performance(telegramId, days, platform);
    if (isDefault && data.ok && data.connected) await this.analyticsService.storeCache(telegramId, data);
    return data;
  }
}
