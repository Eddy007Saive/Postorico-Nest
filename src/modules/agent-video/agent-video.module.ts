import { Module } from '@nestjs/common';
import { PrismaModule } from '../../config/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { MarqueModule } from '../marque/marque.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PlanningModule } from '../planning/planning.module';
import { QuotaModule } from '../quota/quota.module';
import { UsageModule } from '../usage/usage.module';
import { VideoModule } from '../video/video.module';
import { ClaudeModule } from '../claude/claude.module';
import { MusicLibraryModule } from '../music/music-library.module';
import { VoixModule } from '../voix/voix.module';
import { AgentVideoController } from './agent-video.controller';
import { AgentVideoService } from './agent-video.service';

/** Montage par l'agent IA du VPS (Claude Code) : préparation (POC + coupe), envoi au VPS, suivi, récupération. */
@Module({
  imports: [
    PrismaModule,
    AuthModule,
    QuotaModule,
    MarqueModule,
    PlanningModule,
    NotificationsModule,
    UsageModule,
    VideoModule,
    ClaudeModule,
    MusicLibraryModule,
    VoixModule,
  ],
  controllers: [AgentVideoController],
  providers: [AgentVideoService],
})
export class AgentVideoModule {}
