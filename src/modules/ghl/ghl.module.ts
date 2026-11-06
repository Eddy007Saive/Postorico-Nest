import { Module } from '@nestjs/common';
import { GhlService } from './ghl.service';

/** GoHighLevel : tags sur les contacts à partir des événements de paiement. */
@Module({
  providers: [GhlService],
  exports: [GhlService],
})
export class GhlModule {}
