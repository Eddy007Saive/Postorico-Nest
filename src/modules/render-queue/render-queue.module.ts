import { Module } from '@nestjs/common';
import { PrismaModule } from '../../config/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { QuotaModule } from '../quota/quota.module';
import { RemotionModule } from '../remotion/remotion.module';
import { VoixModule } from '../voix/voix.module';
import { RenderQueueService } from './render-queue.service';

@Module({
  imports: [
    PrismaModule,
    RemotionModule,
    VoixModule,
    QuotaModule,
    NotificationsModule,
  ],
  providers: [RenderQueueService],
  exports: [RenderQueueService],
})
export class RenderQueueModule {}
