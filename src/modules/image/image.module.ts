import { Module } from '@nestjs/common';
import { PrismaModule } from '../../config/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { ClaudeModule } from '../claude/claude.module';
import { DemarrageModule } from '../demarrage/demarrage.module';
import { GabaritModule } from '../gabarit/gabarit.module';
import { LateModule } from '../late/late.module';
import { MarqueModule } from '../marque/marque.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PlanningModule } from '../planning/planning.module';
import { QuotaModule } from '../quota/quota.module';
import { UsageModule } from '../usage/usage.module';
import { ImageController } from './image.controller';
import { ImageService } from './image.service';
import { VisuelAutoService } from './visuel-auto.service';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    ClaudeModule,
    MarqueModule,
    DemarrageModule,
    PlanningModule,
    QuotaModule,
    UsageModule,
    LateModule,
    GabaritModule,
    NotificationsModule,
  ],
  controllers: [ImageController],
  providers: [ImageService, VisuelAutoService],
  exports: [ImageService],
})
export class ImageModule {}
