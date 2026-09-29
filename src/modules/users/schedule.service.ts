import { Injectable } from '@nestjs/common';
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
  is_active?: boolean;
  format?: string;
  carrousel_template?: string;
  mode_planification?: string;
}

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

  async updateSchedules(telegramId: string, schedules: ScheduleItem[]): Promise<{ error: string } | { data: unknown }> {
    // Mêmes défauts que le modèle Pydantic ScheduleItem côté Python.
    for (const item of schedules) {
      const frequency = item.frequency ?? 'weekly';
      if (!VALID_SCHEDULE_PLATFORMS.includes(item.platform)) return { error: `Invalid platform: ${item.platform}` };
      if (!VALID_FREQUENCIES.includes(frequency)) return { error: `Invalid frequency: ${frequency}` };
    }

    for (const item of schedules) {
      const row = {
        telegram_id: telegramId,
        platform: item.platform,
        frequency: item.frequency ?? 'weekly',
        days_of_week: item.days_of_week ?? [],
        preferred_time: this.toTimeDate(item.preferred_time ?? '09:00'),
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
