import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../config/prisma.service';
import { PlanningService, RESEAU_TO_PLATFORM } from './planning.service';

/**
 * Plan éditorial par MOIS (calendrier) — port direct de backend/services/plan_service.py.
 * Pour un mois donné et chaque réseau actif : besoin/rempli/reste/format. Fournit aussi
 * `creneauxLibres()` : les dates libres du mois pour un réseau (génération en rafale).
 */

const PLATFORM_TO_RESEAU: Record<string, string> = Object.fromEntries(Object.entries(RESEAU_TO_PLATFORM).map(([r, p]) => [p, r]));

// Repli si la cadence n'a pas de jours précis.
const FREQ_PER_MONTH: Record<string, number> = { daily: 30, '3_per_week': 13, weekly: 4, biweekly: 2, custom: 4 };
const DEFAULT_TIME = { hour: 9, minute: 0 };

export interface ScheduleRow {
  platform: string;
  days_of_week: number[];
  frequency: string;
  is_active: boolean | null;
  format: string | null;
  preferred_time: Date | null;
  carrousel_template: string | null;
}

export interface PlanEntry {
  platform: string;
  reseau: string;
  label: string;
  format: string;
  needed: number;
  filled: number;
  stories: number;
  remaining: number;
}

@Injectable()
export class PlanService {
  private readonly logger = new Logger(PlanService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly planningService: PlanningService,
  ) {}

  monthBounds(year: number, month: number): [Date, Date] {
    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 0)); // dernier jour du mois
    return [start, end];
  }

  private parseTime(val: Date | null | undefined): { hour: number; minute: number } {
    if (!val) return DEFAULT_TIME;
    return { hour: val.getUTCHours(), minute: val.getUTCMinutes() };
  }

  async schedules(telegramId: string): Promise<ScheduleRow[]> {
    try {
      return await this.prisma.publication_schedules.findMany({
        where: { telegram_id: telegramId },
        select: { platform: true, days_of_week: true, frequency: true, is_active: true, format: true, preferred_time: true, carrousel_template: true },
      });
    } catch (e) {
      this.logger.error(`plan schedules error: ${e instanceof Error ? e.message : e}`);
      return [];
    }
  }

  /** Jours du mois correspondant à la cadence (jours préférés, sinon jours ouvrés). */
  private candidateDays(start: Date, end: Date, days: Set<number>): Date[] {
    const out: Date[] = [];
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const jn = d.getUTCDay(); // Dim=0..Sam=6, déjà la convention Lun=1..Dim=0 attendue (voir planning.service.ts)
      if (days.size) {
        if (days.has(jn)) out.push(new Date(d));
      } else if (jn !== 0 && jn !== 6) {
        out.push(new Date(d));
      }
    }
    return out;
  }

  /** Dates (YYYY-MM-DD) déjà prises par un contenu daté du réseau dans le mois (non
   * refusé). Si `famille` est fournie, ne compte que les contenus de cette famille. */
  async datesOccupees(telegramId: string, reseau: string, start: Date, end: Date, famille?: string, mode?: string): Promise<string[]> {
    const m = mode || 'cumule';
    const endExclusive = new Date(end);
    endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
    let rows: Array<{ date_publication: Date | null; statut: string | null; type: string | null }>;
    try {
      rows = await this.prisma.contenu.findMany({
        where: { telegram_id: telegramId, reseau_cible: reseau as never, date_publication: { gte: start, lt: endExclusive, not: null } },
        select: { date_publication: true, statut: true, type: true },
      });
    } catch (e) {
      this.logger.warn(`plan datesOccupees error: ${e instanceof Error ? e.message : e}`);
      return [];
    }
    return rows
      .filter((r) => r.date_publication && r.statut !== 'Refuse' && (famille === undefined || this.planningService.familleDe(r.type, m) === famille))
      .map((r) => r.date_publication!.toISOString());
  }

  /** Contenus datés du réseau dans le mois, non refusés (type inclus, pour distinguer les
   * stories). */
  private async contenusDuMois(telegramId: string, reseau: string, start: Date, end: Date): Promise<Array<{ date_publication: Date | null; statut: string | null; type: string | null }>> {
    const endExclusive = new Date(end);
    endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
    try {
      const rows = await this.prisma.contenu.findMany({
        where: { telegram_id: telegramId, reseau_cible: reseau as never, date_publication: { gte: start, lt: endExclusive, not: null } },
        select: { date_publication: true, statut: true, type: true },
      });
      return rows.filter((r) => r.date_publication && r.statut !== 'Refuse');
    } catch (e) {
      this.logger.warn(`plan contenusDuMois error: ${e instanceof Error ? e.message : e}`);
      return [];
    }
  }

  async computePlan(telegramId: string, year: number, month: number): Promise<PlanEntry[]> {
    const [start, end] = this.monthBounds(year, month);
    const out: PlanEntry[] = [];
    for (const s of await this.schedules(telegramId)) {
      if (!s.is_active) continue;
      const reseau = PLATFORM_TO_RESEAU[s.platform];
      if (!reseau) continue;
      const days = new Set(s.days_of_week || []);
      const cand = this.candidateDays(start, end, days);
      const needed = days.size ? cand.length : FREQ_PER_MONTH[s.frequency] ?? 4;
      // Décision PO du 2026-09-17 : une story (24h) ne compte pas dans l'objectif du mois.
      const rows = await this.contenusDuMois(telegramId, reseau, start, end);
      const stories = rows.filter((r) => (r.type || '') === 'Story').length;
      const filled = rows.length - stories;
      out.push({
        platform: s.platform,
        reseau,
        label: reseau,
        format: s.format || 'post',
        needed,
        filled,
        stories,
        remaining: Math.max(0, needed - filled),
      });
    }
    return out;
  }

  /** Dates libres (ISO datetime UTC) du mois pour ce réseau, hors `occupied` (set de
   * 'YYYY-MM-DD'). */
  async creneauxLibres(telegramId: string, reseau: string, year: number, month: number, occupied: Set<string>): Promise<string[]> {
    const [start, end] = this.monthBounds(year, month);
    const scheds = await this.schedules(telegramId);
    const sched = scheds.find((s) => PLATFORM_TO_RESEAU[s.platform] === reseau);
    const days = new Set(sched?.days_of_week || []);
    const ptime = this.parseTime(sched?.preferred_time);
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const res: string[] = [];
    for (const d of this.candidateDays(start, end, days)) {
      if (d < today) continue;
      const iso = d.toISOString().slice(0, 10);
      if (occupied.has(iso)) continue;
      res.push(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), ptime.hour, ptime.minute)).toISOString());
    }
    return res;
  }
}
