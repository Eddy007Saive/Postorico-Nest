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
import { PlanningModule } from '../planning/planning.module';
import { PlaywrightModule } from '../playwright/playwright.module';
import { QuotaModule } from '../quota/quota.module';
import { UsageModule } from '../usage/usage.module';
import { CarrouselController } from './carrousel.controller';
import { CarrouselCustomService } from './carrousel-custom.service';
import { CarrouselRenduService } from './carrousel-rendu.service';
import { CarrouselTexteService } from './carrousel-texte.service';
import { RicoPosesService } from './rico-poses.service';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    ClaudeModule,
    MarqueModule,
    DimensionsModule,
    OffersModule,
    MemoireModule,
    PlaywrightModule,
    DemarrageModule,
    PlanningModule,
    QuotaModule,
    UsageModule,
    ContenuEvenementModule,
  ],
  controllers: [CarrouselController],
  providers: [
    CarrouselTexteService,
    CarrouselRenduService,
    CarrouselCustomService,
    RicoPosesService,
  ],
  // CarrouselRenduService::templateValide est réutilisé par ScheduleService (validation du
  // template choisi par réseau) — voir modules/users/schedule.service.ts.
  // CarrouselCustomService (CRUD des templates importés + vignette) est réutilisé par
  // AdminModule (écran d'import de templates). CarrouselTexteService est réutilisé par
  // PostsModule (génération en rafale).
  exports: [
    CarrouselRenduService,
    CarrouselCustomService,
    CarrouselTexteService,
    RicoPosesService,
  ],
})
export class CarrouselModule {}
