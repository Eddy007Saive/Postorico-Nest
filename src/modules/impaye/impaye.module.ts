import { forwardRef, Module } from '@nestjs/common';
import { PrismaModule } from '../../config/prisma.module';
import { DemarrageModule } from '../demarrage/demarrage.module';
import { MailModule } from '../mail/mail.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { QuotaModule } from '../quota/quota.module';
import { SocialModule } from '../social/social.module';
import { ZernioModule } from '../zernio/zernio.module';
import { ImpayeService } from './impaye.service';

// forwardRef sur Demarrage : DemarrageService.exigerProfil appelle ImpayeService.exigerReconnexion
// (même cycle que côté Python, résolu là-bas par un import tardif local à la fonction).
// forwardRef sur Social/Quota : AuthModule -> SocialModule -> QuotaModule -> BillingModule ->
// ImpayeModule fermerait un cycle sinon (QuotaService a besoin de BillingService).
@Module({
  imports: [
    PrismaModule,
    forwardRef(() => SocialModule),
    MailModule,
    forwardRef(() => QuotaModule),
    forwardRef(() => DemarrageModule),
    NotificationsModule,
    ZernioModule,
  ],
  providers: [ImpayeService],
  exports: [ImpayeService],
})
export class ImpayeModule {}
