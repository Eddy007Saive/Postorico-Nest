import { Module } from '@nestjs/common';
import { ClaudeService } from './claude.service';
import { MailModule } from '../mail/mail.module';

@Module({
  imports: [MailModule],
  providers: [ClaudeService],
  exports: [ClaudeService],
})
export class ClaudeModule {}
