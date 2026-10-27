import { Module } from '@nestjs/common';
import { PrismaModule } from '../../config/prisma.module';
import { RateLimitModule } from '../../common/utils/rate-limit.module';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { ClaudeModule } from '../claude/claude.module';
import { MailModule } from '../mail/mail.module';
import { MarqueModule } from '../marque/marque.module';
import { SiteModule } from '../site/site.module';
import { ConfigurationController } from './configuration.controller';
import { ConfigurationService } from './configuration.service';
import { TranscriptionService } from './transcription.service';

@Module({
  imports: [PrismaModule, RateLimitModule, AuthModule, BillingModule, ClaudeModule, MailModule, MarqueModule, SiteModule],
  controllers: [ConfigurationController],
  providers: [ConfigurationService, TranscriptionService],
})
export class ConfigurationModule {}
