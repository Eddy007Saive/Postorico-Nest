import { Module } from '@nestjs/common';
import { PrismaModule } from '../../config/prisma.module';
import { RateLimitModule } from '../../common/utils/rate-limit.module';
import { AuthModule } from '../auth/auth.module';
import { BanqueModule } from '../banque/banque.module';
import { ClaudeModule } from '../claude/claude.module';
import { DemarrageModule } from '../demarrage/demarrage.module';
import { ImageModule } from '../image/image.module';
import { MarqueModule } from '../marque/marque.module';
import { MusicLibraryModule } from '../music/music-library.module';
import { PlanningModule } from '../planning/planning.module';
import { PlaywrightModule } from '../playwright/playwright.module';
import { QuotaModule } from '../quota/quota.module';
import { RenderQueueModule } from '../render-queue/render-queue.module';
import { UsageModule } from '../usage/usage.module';
import { VoixModule } from '../voix/voix.module';
import { MiniatureService } from './miniature.service';
import { MontageService } from './montage.service';
import { ReelController } from './reel.controller';
import { ReelService } from './reel.service';

@Module({
  imports: [
    RateLimitModule,
    PrismaModule,
    AuthModule,
    MarqueModule,
    UsageModule,
    ClaudeModule,
    BanqueModule,
    ImageModule,
    MusicLibraryModule,
    PlanningModule,
    RenderQueueModule,
    PlaywrightModule,
    VoixModule,
    QuotaModule,
    DemarrageModule,
  ],
  controllers: [ReelController],
  providers: [MontageService, ReelService, MiniatureService],
  exports: [MontageService, ReelService, MiniatureService],
})
export class ReelModule {}
