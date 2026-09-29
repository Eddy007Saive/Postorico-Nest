import { forwardRef, Module } from '@nestjs/common';
import { PrismaModule } from '../../config/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { QuotaModule } from '../quota/quota.module';
import { ZernioModule } from '../zernio/zernio.module';
import { SocialService } from './social.service';

// forwardRef : NotificationsModule -> AuthModule -> SocialModule fermerait un cycle sinon
// (AuthModule importe SocialModule pour la création de profil Late à l'inscription).
@Module({
  imports: [
    PrismaModule,
    ZernioModule,
    QuotaModule,
    forwardRef(() => NotificationsModule),
  ],
  providers: [SocialService],
  exports: [SocialService],
})
export class SocialModule {}
