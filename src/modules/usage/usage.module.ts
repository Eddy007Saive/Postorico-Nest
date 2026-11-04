import { Module } from '@nestjs/common';
import { PrismaModule } from '../../config/prisma.module';
import { UsageService } from './usage.service';
import { ControleCoutsService } from './controle-couts.service';
import { MailModule } from '../mail/mail.module';

@Module({
  imports: [PrismaModule, MailModule],
  providers: [UsageService, ControleCoutsService],
  exports: [UsageService],
})
export class UsageModule {}
