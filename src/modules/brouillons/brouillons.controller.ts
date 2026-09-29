import { Controller, Get, InternalServerErrorException, Logger, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../../config/prisma.service';
import { JwtPayload } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

type AuthedRequest = Request & { user: JwtPayload };

/** Port direct de backend/routes/brouillons.py — tous les brouillons du compte, quel que
 * soit leur statut (à ne pas confondre avec `/agent/sujets`, qui ne liste que ceux encore
 * au statut « Brouillon » avec un sous-ensemble de champs). */
@Controller('brouillons')
@UseGuards(JwtAuthGuard)
export class BrouillonsController {
  private readonly logger = new Logger(BrouillonsController.name);

  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async getBrouillons(@Req() req: AuthedRequest) {
    try {
      return await this.prisma.brouillons.findMany({
        where: { telegram_id: req.user.telegram_id },
        orderBy: { created_at: 'desc' },
      });
    } catch (e) {
      this.logger.error(`Get brouillons error: ${e instanceof Error ? e.message : e}`);
      throw new InternalServerErrorException(e instanceof Error ? e.message : String(e));
    }
  }
}
