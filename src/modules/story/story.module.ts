import { Module } from '@nestjs/common';
import { PrismaModule } from '../../config/prisma.module';
import { CarrouselModule } from '../carrousel/carrousel.module';
import { ClaudeModule } from '../claude/claude.module';
import { MarqueModule } from '../marque/marque.module';
import { PlanningModule } from '../planning/planning.module';
import { PlaywrightModule } from '../playwright/playwright.module';
import { QuotaModule } from '../quota/quota.module';
import { RenderQueueModule } from '../render-queue/render-queue.module';
import { StoryService } from './story.service';

@Module({
  imports: [
    PrismaModule,
    CarrouselModule,
    ClaudeModule,
    MarqueModule,
    PlanningModule,
    PlaywrightModule,
    QuotaModule,
    RenderQueueModule,
  ],
  providers: [StoryService],
  exports: [StoryService],
})
export class StoryModule {}
