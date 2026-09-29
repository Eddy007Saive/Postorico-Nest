import { BadRequestException, Body, Controller, Delete, Get, Logger, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtPayload } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OfferBodyDto } from './dto/offer-body.dto';
import { OffersService } from './offers.service';

type AuthedRequest = Request & { user: JwtPayload };

/** Port direct de backend/routes/offers.py — CRUD des offres/produits du client. */
@Controller('offers')
@UseGuards(JwtAuthGuard)
export class OffersController {
  private readonly logger = new Logger(OffersController.name);

  constructor(private readonly offersService: OffersService) {}

  @Get()
  async list(@Req() req: AuthedRequest) {
    return this.offersService.lister(req.user.telegram_id);
  }

  @Post()
  async create(@Body() body: OfferBodyDto, @Req() req: AuthedRequest) {
    try {
      return await this.offersService.creer(req.user.telegram_id, body as Record<string, unknown>);
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : String(e));
    }
  }

  @Patch(':offerId')
  async update(@Param('offerId') offerId: string, @Body() body: OfferBodyDto, @Req() req: AuthedRequest) {
    return this.offersService.modifier(req.user.telegram_id, offerId, body as Record<string, unknown>);
  }

  @Delete(':offerId')
  async remove(@Param('offerId') offerId: string, @Req() req: AuthedRequest) {
    await this.offersService.supprimer(req.user.telegram_id, offerId);
    return { success: true };
  }
}
