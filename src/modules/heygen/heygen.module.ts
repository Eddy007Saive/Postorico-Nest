import { Module } from '@nestjs/common';
import { PrismaModule } from '../../config/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { QuotaModule } from '../quota/quota.module';
import { HeygenController } from './heygen.controller';
import { HeygenService } from './heygen.service';

@Module({
  imports: [PrismaModule, AuthModule, QuotaModule],
  controllers: [HeygenController],
  providers: [HeygenService],
  exports: [HeygenService],
})
export class HeygenModule {}
