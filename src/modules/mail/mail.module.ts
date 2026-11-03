import { Module } from '@nestjs/common';
import { MailService } from './mail.service';
import { AlerteAdminService } from './alerte-admin.service';

@Module({
  providers: [MailService, AlerteAdminService],
  exports: [MailService, AlerteAdminService],
})
export class MailModule {}
