import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ClaudeModule } from '../claude/claude.module';
import { PlaywrightModule } from '../playwright/playwright.module';
import { SiteController } from './site.controller';
import { SiteService } from './site.service';

@Module({
  imports: [AuthModule, ClaudeModule, PlaywrightModule],
  controllers: [SiteController],
  providers: [SiteService],
  exports: [SiteService],
})
export class SiteModule {}