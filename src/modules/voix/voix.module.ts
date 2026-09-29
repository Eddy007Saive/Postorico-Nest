import { Module } from '@nestjs/common';
import { PrismaModule } from '../../config/prisma.module';
import { QuotaModule } from '../quota/quota.module';
import { VoixService } from './voix.service';

@Module({
  imports: [PrismaModule, QuotaModule],
  providers: [VoixService],
  exports: [VoixService],
})
export class VoixModule {}
