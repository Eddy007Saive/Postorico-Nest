import { Module } from '@nestjs/common';
import { UsageModule } from '../usage/usage.module';
import { RemotionService } from './remotion.service';

@Module({
  imports: [UsageModule],
  providers: [RemotionService],
  exports: [RemotionService],
})
export class RemotionModule {}
