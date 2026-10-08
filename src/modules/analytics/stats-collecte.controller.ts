import { Controller, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/guards/admin.guard';
import { DiagnosticService } from './diagnostic.service';
import { PlanService } from './plan.service';
import { StatsCollecteService } from './stats-collecte.service';

/** Rico Coach : déclenchement manuel de la collecte et du diagnostic (admin uniquement). */
@Controller('admin/stats')
@UseGuards(AdminGuard)
export class StatsCollecteController {
  constructor(
    private readonly collecte: StatsCollecteService,
    private readonly diagnostic: DiagnosticService,
    private readonly plan: PlanService,
  ) {}

  /** `nbMois` : mois complets à recalculer (1-12, défaut 12 = rattrapage d'un an).
   * `ecrire=0` : test à blanc, renvoie ce qui serait écrit. */
  @Post('collecte/:telegramId')
  collecter(@Param('telegramId', ParseUUIDPipe) telegramId: string, @Query('nbMois') nbMois?: string, @Query('ecrire') ecrire?: string) {
    return this.collecte.collecterClient(telegramId, {
      nbMois: nbMois ? parseInt(nbMois, 10) || 12 : 12,
      ecrire: !(ecrire === '0' || ecrire === 'false'),
    });
  }

  /** Diagnostic d'un mois (`mois=AAAA-MM`, défaut : le mois précédent). `ecrire=0` : test à blanc. */
  @Post('diagnostic/:telegramId')
  diagnostiquer(@Param('telegramId', ParseUUIDPipe) telegramId: string, @Query('mois') mois?: string, @Query('ecrire') ecrire?: string) {
    return this.diagnostic.diagnostiquerClient(telegramId, { mois, ecrire: !(ecrire === '0' || ecrire === 'false') });
  }

  /** Plan d'action d'un mois (`mois=AAAA-MM`, défaut : le mois en cours), tiré du diagnostic du
   * mois précédent. `ecrire=0` : test à blanc ; `formuler=0` : phrases standard, sans IA. */
  @Post('plan/:telegramId')
  planifier(@Param('telegramId', ParseUUIDPipe) telegramId: string, @Query('mois') mois?: string, @Query('ecrire') ecrire?: string, @Query('formuler') formuler?: string) {
    return this.plan.planifier(telegramId, { mois, ecrire: !(ecrire === '0' || ecrire === 'false'), formuler: !(formuler === '0' || formuler === 'false') });
  }
}
