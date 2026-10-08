import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtPayload } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PlanService } from './plan.service';

type AuthedRequest = Request & { user: JwtPayload };

/** Rico Coach côté client : le plan d'action du mois. */
@Controller('coach')
@UseGuards(JwtAuthGuard)
export class CoachController {
  constructor(private readonly plan: PlanService) {}

  /** Le plan le plus récent ({ plan: null } tant qu'aucun n'a été calculé). */
  @Get('plan')
  async dernierPlan(@Req() req: AuthedRequest) {
    return { plan: await this.plan.dernier(req.user.telegram_id) };
  }
}
