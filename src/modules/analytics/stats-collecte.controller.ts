import { Controller, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/guards/admin.guard';
import { StatsCollecteService } from './stats-collecte.service';

/** Rico Coach : déclenchement manuel de la collecte des stats (admin uniquement). */
@Controller('admin/stats')
@UseGuards(AdminGuard)
export class StatsCollecteController {
  constructor(private readonly collecte: StatsCollecteService) {}

  /** `nbMois` : mois complets à recalculer (1-12, défaut 12 = rattrapage d'un an).
   * `ecrire=0` : test à blanc, renvoie ce qui serait écrit. */
  @Post('collecte/:telegramId')
  collecter(@Param('telegramId', ParseUUIDPipe) telegramId: string, @Query('nbMois') nbMois?: string, @Query('ecrire') ecrire?: string) {
    return this.collecte.collecterClient(telegramId, {
      nbMois: nbMois ? parseInt(nbMois, 10) || 12 : 12,
      ecrire: !(ecrire === '0' || ecrire === 'false'),
    });
  }
}
