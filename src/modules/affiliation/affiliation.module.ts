import { forwardRef, Module } from '@nestjs/common';
import { PrismaModule } from '../../config/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { MailModule } from '../mail/mail.module';
import { AffiliationController } from './affiliation.controller';
import { AffiliationService } from './affiliation.service';

@Module({
  imports: [PrismaModule, forwardRef(() => AuthModule), MailModule],
  controllers: [AffiliationController],
  providers: [AffiliationService],
  exports: [AffiliationService],
})
export class AffiliationModule {}
