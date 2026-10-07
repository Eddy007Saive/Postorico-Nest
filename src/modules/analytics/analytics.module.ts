import { Module } from '@nestjs/common';
import { PrismaModule } from '../../config/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { ZernioModule } from '../zernio/zernio.module';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { StatsCollecteController } from './stats-collecte.controller';
import { StatsCollecteService } from './stats-collecte.service';

@Module({
  imports: [PrismaModule, AuthModule, ZernioModule],
  controllers: [AnalyticsController, StatsCollecteController],
  providers: [AnalyticsService, StatsCollecteService],
  exports: [AnalyticsService, StatsCollecteService],
})
export class AnalyticsModule {}
