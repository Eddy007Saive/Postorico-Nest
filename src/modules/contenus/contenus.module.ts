import { Module } from '@nestjs/common';
import { PrismaModule } from '../../config/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { CarrouselModule } from '../carrousel/carrousel.module';
import { LateModule } from '../late/late.module';
import { MarqueModule } from '../marque/marque.module';
import { MemoireModule } from '../memoire/memoire.module';
import { PlanningModule } from '../planning/planning.module';
import { QuotaModule } from '../quota/quota.module';
import { StoryModule } from '../story/story.module';
import { ContenuEvenementModule } from './contenu-evenement.module';
import { ContenuController } from './contenu.controller';
import { ContenuService } from './contenu.service';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    PlanningModule,
    LateModule,
    CarrouselModule,
    StoryModule,
    MarqueModule,
    MemoireModule,
    QuotaModule,
    ContenuEvenementModule,
  ],
  controllers: [ContenuController],
  providers: [ContenuService],
  exports: [ContenuService],
})
export class ContenusModule {}
