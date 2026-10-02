import { Module } from '@nestjs/common';
import { PrismaModule } from '../../config/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { ClaudeModule } from '../claude/claude.module';
import { ContenuEvenementModule } from '../contenus/contenu-evenement.module';
import { DemarrageModule } from '../demarrage/demarrage.module';
import { DimensionsModule } from '../dimensions/dimensions.module';
import { MarqueModule } from '../marque/marque.module';
import { MemoireModule } from '../memoire/memoire.module';
import { OffersModule } from '../offers/offers.module';
import { QuotaModule } from '../quota/quota.module';
import { UsageModule } from '../usage/usage.module';
import { ScriptController } from './script.controller';
import { ScriptService } from './script.service';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    ClaudeModule,
    MarqueModule,
    DimensionsModule,
    OffersModule,
    MemoireModule,
    DemarrageModule,
    QuotaModule,
    UsageModule,
    ContenuEvenementModule,
  ],
  controllers: [ScriptController],
  providers: [ScriptService],
  // ScriptService est réutilisé par PostsModule (génération en rafale).
  exports: [ScriptService],
})
export class ScriptModule {}
