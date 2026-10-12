import { Module } from '@nestjs/common';
import { PrismaModule } from '../../config/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { MarqueModule } from '../marque/marque.module';
import { MusicLibraryModule } from '../music/music-library.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PlanningModule } from '../planning/planning.module';
import { QuotaModule } from '../quota/quota.module';
import { UsageModule } from '../usage/usage.module';
import { AgentVideoController, AgentVideoWorkerController } from './agent-video.controller';
import { AgentVideoService } from './agent-video.service';
import { AgentWorkerGuard } from './agent-worker.guard';

/** Montage par l'agent IA du VPS (Claude Code) : file de travaux + routes client et worker. */
@Module({
  imports: [PrismaModule, AuthModule, QuotaModule, MarqueModule, MusicLibraryModule, PlanningModule, NotificationsModule, UsageModule],
  controllers: [AgentVideoController, AgentVideoWorkerController],
  providers: [AgentVideoService, AgentWorkerGuard],
})
export class AgentVideoModule {}
