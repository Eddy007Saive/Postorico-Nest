import { Module } from '@nestjs/common';
import { PrismaModule } from '../../config/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { ContenuEvenementModule } from '../contenus/contenu-evenement.module';
import { MailModule } from '../mail/mail.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PlanningModule } from '../planning/planning.module';
import { QuotaModule } from '../quota/quota.module';
import { SocialModule } from '../social/social.module';
import { ZernioModule } from '../zernio/zernio.module';
import { LateController } from './late.controller';
import { LateService } from './late.service';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    ZernioModule,
    MailModule,
    QuotaModule,
    SocialModule,
    NotificationsModule,
    ContenuEvenementModule,
    PlanningModule,
  ],
  controllers: [LateController],
  providers: [LateService],
  exports: [LateService],
})
export class LateModule {}
