import { Module } from '@nestjs/common';
import { ClaudeService } from './claude.service';
import { MailModule } from '../mail/mail.module';
import { UsageModule } from '../usage/usage.module';

@Module({
  imports: [MailModule, UsageModule],
  providers: [ClaudeService],
  exports: [ClaudeService],
})
export class ClaudeModule {}
