import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { SiteService } from './site.service';
import { AdminGuard } from '../auth/guards/admin.guard';

@Controller('site')
@UseGuards(AdminGuard)
export class SiteController {
  constructor(private readonly siteService: SiteService) {}

  @Get('analyser')
  async analyser(@Query('url') url: string) {
    return this.siteService.analyserSite(url);
  }
}