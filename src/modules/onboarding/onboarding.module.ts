import { Module } from '@nestjs/common';
import { PrismaModule } from '../../config/prisma.module';
import { RateLimitModule } from '../../common/utils/rate-limit.module';
import { AuthModule } from '../auth/auth.module';
import { MailModule } from '../mail/mail.module';
import { TurnstileModule } from '../turnstile/turnstile.module';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';

@Module({
  imports: [PrismaModule, MailModule, TurnstileModule, RateLimitModule, AuthModule],
  controllers: [OnboardingController],
  providers: [OnboardingService],
})
export class OnboardingModule {}