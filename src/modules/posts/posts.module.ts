import { Module } from '@nestjs/common';
import { PrismaModule } from '../../config/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { CarrouselModule } from '../carrousel/carrousel.module';
import { ClaudeModule } from '../claude/claude.module';
import { DemarrageModule } from '../demarrage/demarrage.module';
import { DimensionsModule } from '../dimensions/dimensions.module';
import { MarqueModule } from '../marque/marque.module';
import { MemoireModule } from '../memoire/memoire.module';
import { OffersModule } from '../offers/offers.module';
import { PlanningModule } from '../planning/planning.module';
import { QuotaModule } from '../quota/quota.module';
import { ScriptModule } from '../script/script.module';
import { UsageModule } from '../usage/usage.module';
import { PostsController } from './posts.controller';
import { PostsService } from './posts.service';

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
    PlanningModule,
    QuotaModule,
    UsageModule,
    CarrouselModule,
    ScriptModule,
  ],
  controllers: [PostsController],
  providers: [PostsService],
})
export class PostsModule {}
