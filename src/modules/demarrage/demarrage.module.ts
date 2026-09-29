import { forwardRef, Module } from '@nestjs/common';
import { PrismaModule } from '../../config/prisma.module';
import { BillingModule } from '../billing/billing.module';
import { ImpayeModule } from '../impaye/impaye.module';
import { MarqueModule } from '../marque/marque.module';
import { QuotaModule } from '../quota/quota.module';
import { SocialModule } from '../social/social.module';
import { DemarrageService } from './demarrage.service';

// forwardRef sur Social/Quota/Billing : AuthModule -> SocialModule -> QuotaModule -> BillingModule
// -> ImpayeModule -> DemarrageModule fermerait un cycle sinon.
@Module({
  imports: [
    PrismaModule,
    MarqueModule,
    forwardRef(() => SocialModule),
    forwardRef(() => QuotaModule),
    forwardRef(() => BillingModule),
    forwardRef(() => ImpayeModule),
  ],
  providers: [DemarrageService],
  exports: [DemarrageService],
})
export class DemarrageModule {}
