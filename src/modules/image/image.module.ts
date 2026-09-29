import { Module } from '@nestjs/common';
import { PrismaModule } from '../../config/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { ClaudeModule } from '../claude/claude.module';
import { DemarrageModule } from '../demarrage/demarrage.module';
import { GabaritModule } from '../gabarit/gabarit.module';
import { LateModule } from '../late/late.module';
import { MarqueModule } from '../marque/marque.module';
import { PlanningModule } from '../planning/planning.module';
import { QuotaModule } from '../quota/quota.module';
import { UsageModule } from '../usage/usage.module';
import { ImageController } from './image.controller';
import { ImageService } from './image.service';

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
  ],
  controllers: [ImageController],
  providers: [ImageService],
  exports: [ImageService],
})
export class ImageModule {}
