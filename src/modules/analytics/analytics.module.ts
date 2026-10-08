import { Module } from '@nestjs/common';
import { PrismaModule } from '../../config/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { ClaudeModule } from '../claude/claude.module';
import { MarqueModule } from '../marque/marque.module';
import { OffersModule } from '../offers/offers.module';
import { UsageModule } from '../usage/usage.module';
import { ZernioModule } from '../zernio/zernio.module';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { CoachController } from './coach.controller';
import { DiagnosticService } from './diagnostic.service';
import { PlanService } from './plan.service';
import { StatsCollecteController } from './stats-collecte.controller';
import { StatsCollecteService } from './stats-collecte.service';

@Module({
  imports: [PrismaModule, AuthModule, ZernioModule, ClaudeModule, MarqueModule, OffersModule, UsageModule],
  controllers: [AnalyticsController, StatsCollecteController, CoachController],
  providers: [AnalyticsService, StatsCollecteService, DiagnosticService, PlanService],
  exports: [AnalyticsService, StatsCollecteService, DiagnosticService, PlanService],
})
export class AnalyticsModule {}
