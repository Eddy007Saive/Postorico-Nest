import { Module } from '@nestjs/common';
import { PlaywrightBrowserService } from './playwright-browser.service';

@Module({
  providers: [PlaywrightBrowserService],
  exports: [PlaywrightBrowserService],
})
export class PlaywrightModule {}
