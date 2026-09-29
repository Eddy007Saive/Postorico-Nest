import { forwardRef, Module } from '@nestjs/common';
import { PrismaModule } from '../../config/prisma.module';
import { BillingModule } from '../billing/billing.module';
import { QuotaService } from './quota.service';

// forwardRef : BillingModule -> ImpayeModule -> QuotaModule fermerait un cycle sinon
// (QuotaService a besoin de BillingService pour distinguer jamais-abonné / ex-abonné).
@Module({
  imports: [PrismaModule, forwardRef(() => BillingModule)],
  providers: [QuotaService],
  exports: [QuotaService],
})
export class QuotaModule {}
