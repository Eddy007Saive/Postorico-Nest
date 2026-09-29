import { Module } from '@nestjs/common';
import { PrismaModule } from '../../config/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { ClaudeModule } from '../claude/claude.module';
import { DemarrageModule } from '../demarrage/demarrage.module';
import { DimensionsModule } from '../dimensions/dimensions.module';
import { MarqueModule } from '../marque/marque.module';
import { OffersModule } from '../offers/offers.module';
import { QuotaModule } from '../quota/quota.module';
import { UsageModule } from '../usage/usage.module';
import { SujetsController } from './sujets.controller';
import { SujetsService } from './sujets.service';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    ClaudeModule,
    MarqueModule,
    DimensionsModule,
    OffersModule,
    DemarrageModule,
    QuotaModule,
    UsageModule,
  ],
  controllers: [SujetsController],
  providers: [SujetsService],
})
export class SujetsModule {}
