import { Module } from '@nestjs/common';
import { PrismaModule } from '../../config/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { ClaudeModule } from '../claude/claude.module';
import { DemarrageModule } from '../demarrage/demarrage.module';
import { MarqueModule } from '../marque/marque.module';
import { PlaywrightModule } from '../playwright/playwright.module';
import { QuotaModule } from '../quota/quota.module';
import { GabaritComposeService } from './gabarit-compose.service';
import { GabaritController } from './gabarit.controller';
import { GabaritService } from './gabarit.service';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    ClaudeModule,
    MarqueModule,
    PlaywrightModule,
    DemarrageModule,
    QuotaModule,
  ],
  controllers: [GabaritController],
  providers: [GabaritService, GabaritComposeService],
  exports: [GabaritService, GabaritComposeService],
})
export class GabaritModule {}
