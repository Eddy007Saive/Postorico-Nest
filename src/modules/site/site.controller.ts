import { BadRequestException, Controller, Get, Query, UnprocessableEntityException, UseGuards } from '@nestjs/common';
import { AdresseRefusee, SiteIllisible, SiteService } from './site.service';
import { AdminGuard } from '../auth/guards/admin.guard';

@Controller('site')
@UseGuards(AdminGuard)
export class SiteController {
  constructor(private readonly siteService: SiteService) {}

  @Get('analyser')
  async analyser(@Query('url') url: string) {
    try {
      return await this.siteService.analyserSite(url);
    } catch (e) {
      if (e instanceof AdresseRefusee) throw new BadRequestException(e.message);
      if (e instanceof SiteIllisible) throw new UnprocessableEntityException(e.message);
      throw e;
    }
  }
}
