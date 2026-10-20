import { Module } from '@nestjs/common';
import { PrismaModule } from '../../config/prisma.module';
import { RateLimitModule } from '../../common/utils/rate-limit.module';
import { AuthModule } from '../auth/auth.module';
import { MailModule } from '../mail/mail.module';
import { SiteModule } from '../site/site.module';
import { TurnstileModule } from '../turnstile/turnstile.module';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';
import { GardeAnalyseSite } from './analyse-site.garde';

@Module({
  imports: [PrismaModule, MailModule, TurnstileModule, RateLimitModule, AuthModule, SiteModule],
  controllers: [OnboardingController],
  providers: [OnboardingService, GardeAnalyseSite],
})
export class OnboardingModule {}