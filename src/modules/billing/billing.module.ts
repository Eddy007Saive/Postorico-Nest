import { forwardRef, Module } from '@nestjs/common';
import { PrismaModule } from '../../config/prisma.module';
import { AffiliationModule } from '../affiliation/affiliation.module';
import { AuthModule } from '../auth/auth.module';
import { ImpayeModule } from '../impaye/impaye.module';
import { MailModule } from '../mail/mail.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SocialModule } from '../social/social.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';

// forwardRef sur Auth/Social : AuthModule -> SocialModule -> QuotaModule -> BillingModule
// fermerait un cycle sinon (QuotaService a besoin de BillingService, cf. QuotaModule).
// forwardRef sur Impaye : ImpayeModule -> DemarrageModule -> BillingModule fermerait un cycle sinon.
@Module({
  imports: [
    PrismaModule,
    forwardRef(() => AuthModule),
    MailModule,
    forwardRef(() => SocialModule),
    forwardRef(() => ImpayeModule),
    NotificationsModule,
    AffiliationModule,
  ],
  controllers: [BillingController],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
