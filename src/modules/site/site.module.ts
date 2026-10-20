import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ClaudeModule } from '../claude/claude.module';
import { UsageModule } from '../usage/usage.module';
import { SiteController } from './site.controller';
import { SiteService } from './site.service';

@Module({
  imports: [AuthModule, ClaudeModule, UsageModule],
  controllers: [SiteController],
  providers: [SiteService],
  exports: [SiteService],
})
export class SiteModule {}
