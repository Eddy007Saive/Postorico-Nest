import { Module } from '@nestjs/common';
import { OffersModule } from '../offers/offers.module';
import { SocialModule } from '../social/social.module';
import { DimensionsService } from './dimensions.service';

@Module({
  imports: [OffersModule, SocialModule],
  providers: [DimensionsService],
  exports: [DimensionsService],
})
export class DimensionsModule {}
