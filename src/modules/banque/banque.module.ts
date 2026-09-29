import { Module } from '@nestjs/common';
import { PrismaModule } from '../../config/prisma.module';
import { ClaudeModule } from '../claude/claude.module';
import { UsageModule } from '../usage/usage.module';
import { BanqueService } from './banque.service';

@Module({
  imports: [PrismaModule, ClaudeModule, UsageModule],
  providers: [BanqueService],
  exports: [BanqueService],
})
export class BanqueModule {}
