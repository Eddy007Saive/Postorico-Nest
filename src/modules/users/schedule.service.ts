import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../config/prisma.service';
import { CarrouselRenduService } from '../carrousel/carrousel-rendu.service';

/** Cadences de publication (`publication_schedules`) — port direct de
 * backend/services/schedule_service.py. */

export const VALID_FREQUENCIES = ['daily', '3_per_week', 'weekly', 'biweekly', 'custom'];
export const VALID_SCHEDULE_PLATFORMS = ['linkedin', 'instagram', 'facebook', 'tiktok', 'youtube', 'googlebusiness', 'twitter'];

export interface ScheduleItem {
  platform: string;
  frequency?: string;
  days_of_week?: number[];
  preferred_time?: string;
  // Override de preferred_time par jour : {"1":"09:00","3":"14:30"} (clé = days_of_week, 0=Dim..6=Sam).
  preferred_times?: Record<string, string>;
  is_active?: boolean;
  format?: string;
  carrousel_template?: string;
  mode_planification?: string;
}

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

@Injectable()
export class ScheduleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly carrouselRendu: CarrouselRenduService,
  ) {}

  async getSchedules(telegramId: string) {
    return this.prisma.publication_schedules.findMany({ where: { telegram_id: telegramId } });
  }

  /** "09:00" -> Date UTC portant l'heure — la colonne Postgres est un TIME (sans fuseau ni
   * date), et Prisma lit/écrit ce type via un objet Date dont seuls les champs UTC comptent
   * (même convention que planning.service.ts::extractTime, en sens inverse). */
  private toTimeDate(hhmm: string): Date {
    const [h, m] = (hhmm || '09:00').split(':').map((x) => parseInt(x, 10) || 0);
    return new Date(Date.UTC(1970, 0, 1, h, m, 0));
  }

  /** Ne garde que les overrides valides : jour 0-6 présent dans days_of_week, heure HH:MM.
   * Un override sur un jour non coché n'aurait aucun effet dans prochainCreneau -> autant le
   * refuser maintenant plutôt que de laisser une config fantôme s'accumuler en base. */
  private validerPreferredTimes(
    preferredTimes: Record<string, string> | undefined,
    daysOfWeek: number[],
  ): { ok: true; value: Record<string, string> } | { ok: false; error: string } {
    if (!preferredTimes) return { ok: true, value: {} };
    const jours = new Set(daysOfWeek);
    const value: Record<string, string> = {};
    for (const [cle, heure] of Object.entries(preferredTimes)) {
      const jour = parseInt(cle, 10);
      if (!Number.isInteger(jour) || jour < 0 || jour > 6) return { ok: false, error: `Invalid day in preferred_times: ${cle}` };
      if (!jours.has(jour)) return { ok: false, error: `preferred_times day ${jour} is not in days_of_week` };
      if (!HHMM_RE.test(heure)) return { ok: false, error: `Invalid time in preferred_times: ${heure}` };
      value[String(jour)] = heure;
    }
    return { ok: true, value };
  }

  async updateSchedules(telegramId: string, schedules: ScheduleItem[]): Promise<{ error: string } | { data: unknown }> {
    // Mêmes défauts que le modèle Pydantic ScheduleItem côté Python.
    for (const item of schedules) {
      const frequency = item.frequency ?? 'weekly';
      if (!VALID_SCHEDULE_PLATFORMS.includes(item.platform)) return { error: `Invalid platform: ${item.platform}` };
      if (!VALID_FREQUENCIES.includes(frequency)) return { error: `Invalid frequency: ${frequency}` };
      const verif = this.validerPreferredTimes(item.preferred_times, item.days_of_week ?? []);
      if (!verif.ok) return { error: verif.error };
    }

    for (const item of schedules) {
      const preferredTimes = this.validerPreferredTimes(item.preferred_times, item.days_of_week ?? []);
      const row = {
        telegram_id: telegramId,
        platform: item.platform,
        frequency: item.frequency ?? 'weekly',
        days_of_week: item.days_of_week ?? [],
        preferred_time: this.toTimeDate(item.preferred_time ?? '09:00'),
        preferred_times: preferredTimes.ok && Object.keys(preferredTimes.value).length ? preferredTimes.value : Prisma.JsonNull,
        is_active: item.is_active ?? true,
        format: item.format || 'post',
        // Verrou : un template sur mesure non attribué à ce compte retombe sur « creme ».
        carrousel_template: await this.carrouselRendu.templateValide(item.carrousel_template || 'bold', telegramId),
        mode_planification: item.mode_planification === 'suite' ? 'suite' : 'cumule',
        updated_at: new Date(),
      };
      await this.prisma.publication_schedules.upsert({
        where: { telegram_id_platform: { telegram_id: telegramId, platform: item.platform } },
        update: row,
        create: row,
      });
    }

    const data = await this.prisma.publication_schedules.findMany({ where: { telegram_id: telegramId } });
    return { data };
  }
}
