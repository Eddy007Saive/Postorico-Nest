import { Module } from '@nestjs/common';
import { PrismaModule } from '../../config/prisma.module';
import { UsageModule } from '../usage/usage.module';
import { MemoireService } from './memoire.service';

@Module({
  imports: [PrismaModule, UsageModule],
  providers: [MemoireService],
  exports: [MemoireService],
})
export class MemoireModule {}
