import { forwardRef, Module } from '@nestjs/common';
import { PrismaModule } from '../../config/prisma.module';
import { AffiliationModule } from '../affiliation/affiliation.module';
import { AuthModule } from '../auth/auth.module';
import { DemarrageModule } from '../demarrage/demarrage.module';
import { ImpayeModule } from '../impaye/impaye.module';
import { MailModule } from '../mail/mail.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SocialModule } from '../social/social.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';

// forwardRef sur Auth/Social : AuthModule -> SocialModule -> QuotaModule -> BillingModule
// fermerait un cycle sinon (QuotaService a besoin de BillingService, cf. QuotaModule).
// forwardRef sur Impaye : ImpayeModule -> DemarrageModule -> BillingModule fermerait un cycle sinon.
// forwardRef sur Demarrage : DemarrageModule importe déjà BillingModule (forwardRef) ; Billing a
// aussi besoin de DemarrageService.oublier() pour invalider le cache d'onboarding après un
// changement d'abonnement (applySubscription), d'où le cycle inverse à fermer ici aussi.
@Module({
  imports: [
    PrismaModule,
    forwardRef(() => AuthModule),
    MailModule,
    forwardRef(() => SocialModule),
    forwardRef(() => ImpayeModule),
    forwardRef(() => DemarrageModule),
    NotificationsModule,
    AffiliationModule,
  ],
  controllers: [BillingController],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
