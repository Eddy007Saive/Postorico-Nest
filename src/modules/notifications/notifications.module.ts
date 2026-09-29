import { forwardRef, Module } from '@nestjs/common';
import { PrismaModule } from '../../config/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { NotificationsController } from './notifications.controller';
import { NotificationService } from './notification.service';
import { PushService } from './push.service';

// forwardRef : AuthModule -> SocialModule -> NotificationsModule fermerait un cycle sinon.
@Module({
  imports: [PrismaModule, forwardRef(() => AuthModule)],
  controllers: [NotificationsController],
  providers: [NotificationService, PushService],
  exports: [NotificationService, PushService],
})
export class NotificationsModule {}
