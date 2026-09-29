import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../config/prisma.service';

/**
 * Planification automatique — port direct de backend/services/planning_service.py.
 * Pose une date de publication sur un contenu à partir des créneaux préférés de
 * l'utilisateur (table publication_schedules).
 *
 * Convention des jours (identique au front, constants/schedules.js) :
 *   Lun=1, Mar=2, Mer=3, Jeu=4, Ven=5, Sam=6, Dim=0  ==  date.isoweekday() % 7
 * JS Date.getUTCDay() utilise DÉJÀ cette même convention (Dim=0…Sam=6), donc pas
 * de conversion nécessaire — contrairement à Python où c'est `isoweekday() % 7`.
 *
 * L'aléa horaire (jitter) n'a pas besoin d'être bit-à-bit identique à celui du
 * backend Python (chaque backend calcule ses propres créneaux) : seule compte la
 * déterminisme PAR SEED au sein de CE backend (un sweep répété ne doit pas faire
 * dériver un créneau déjà annoncé). Le générateur pseudo-aléatoire ci-dessous est
 * donc un mulberry32 maison, pas le Mersenne Twister de Python.
 */

// contenu.reseau_cible (enum capitalisé) -> publication_schedules.platform (minuscule).
// Exporté : réutilisé (inversé) par PlanService pour le plan éditorial mensuel.
export const RESEAU_TO_PLATFORM: Record<string, string> = {
  LinkedIn: 'linkedin',
  Instagram: 'instagram',
  Facebook: 'facebook',
  TikTok: 'tiktok',
  YouTube: 'youtube',
  GoogleBusiness: 'googlebusiness',
  Twitter: 'twitter',
};

const DEFAULT_TIME = { hour: 9, minute: 0 };
const HORIZON_DAYS = 120; // on cherche un créneau dans les ~4 prochains mois

// Famille d'un contenu selon son type (contenu.type ; null/Post/autre => feed)
const TYPE_TO_FAMILLE: Record<string, string> = {
  Carrousel: 'feed',
  Reel: 'video',
  Short: 'video',
  Video: 'video',
  Story: 'story',
};
// Décalage horaire de chaque famille par rapport à l'heure préférée du réseau
const FAMILLE_OFFSET_H: Record<string, number> = { feed: 0, story: 3, video: 6 };

// Rythme « à la suite » : tout est dans la même file, la notion de famille disparaît.
const FILE_UNIQUE = 'tout';
const MODE_DEFAUT = 'cumule';

const JITTER_MIN_MINUTES = -12;
const JITTER_MAX_MINUTES = 14;

function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let state = h >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randint(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

@Injectable()
export class PlanningService {
  private readonly logger = new Logger(PlanningService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Renvoie (heure, minute, seconde) décalées de quelques minutes autour de l'heure
   * préférée. Jamais l'heure ronde pile. Déterministe pour un seed donné. */
  private heureHumanisee(baseHour: number, baseMinute: number, seed: string[]): [number, number, number] {
    const rng = seededRandom(seed.join('|'));
    const total = mod(baseHour * 60 + baseMinute + randint(rng, JITTER_MIN_MINUTES, JITTER_MAX_MINUTES), 24 * 60);
    let h = Math.floor(total / 60);
    let m = total % 60;
    if (m === 0) m = randint(rng, 3, 9); // évite 12:00:00, 09:00:00… trop « robot »
    return [h, m, randint(rng, 0, 59)];
  }

  /** Famille d'un contenu. En mode « à la suite », tous les formats partagent la même
   * file : un seul contenu par jour et par réseau. */
  familleDe(typeContenu: string | null | undefined, mode: string = MODE_DEFAUT): string {
    if (mode === 'suite') return FILE_UNIQUE;
    return TYPE_TO_FAMILLE[typeContenu || ''] ?? 'feed';
  }

  /** Rythme choisi par le client pour ce réseau (« cumule » par défaut). */
  async modeDuReseau(telegramId: string, platform: string): Promise<string> {
    try {
      const row = await this.prisma.publication_schedules.findFirst({
        where: { telegram_id: telegramId, platform },
        select: { mode_planification: true },
      });
      return row?.mode_planification || MODE_DEFAUT;
    } catch (e) {
      this.logger.warn(`mode planification ${platform}: ${e instanceof Error ? e.message : e}`);
      return MODE_DEFAUT;
    }
  }

  private extractTime(val: Date | null | undefined): { hour: number; minute: number } {
    if (!val) return DEFAULT_TIME;
    return { hour: val.getUTCHours(), minute: val.getUTCMinutes() };
  }

  /** Dates (YYYY-MM-DD) déjà prises sur ce réseau, hors refusés.
   *
   * En « cumulé », seuls les contenus de la MÊME famille bloquent le jour : deux
   * familles différentes peuvent le partager. En « à la suite », n'importe quel
   * contenu bloque le jour. */
  private async joursOccupes(
    telegramId: string,
    reseauCible: string,
    famille: string,
    mode: string = MODE_DEFAUT,
  ): Promise<Set<string>> {
    let rows: Array<{ date_publication: Date | null; type: string | null; statut: string | null }>;
    try {
      rows = await this.prisma.contenu.findMany({
        where: {
          telegram_id: telegramId,
          reseau_cible: reseauCible as never,
          date_publication: { not: null },
        },
        select: { date_publication: true, type: true, statut: true },
      });
    } catch (e) {
      this.logger.error(`planning joursOccupes error: ${e instanceof Error ? e.message : e}`);
      return new Set();
    }
    const out = new Set<string>();
    for (const row of rows) {
      if (!row.date_publication) continue;
      if (row.statut === 'Refuse') continue;
      if (this.familleDe(row.type, mode) !== famille) continue;
      out.add(row.date_publication.toISOString().slice(0, 10));
    }
    return out;
  }

  /** Renvoie une date_publication ISO (UTC) pour le prochain créneau libre de la
   * famille du contenu (feed par défaut), ou null. */
  async prochainCreneau(
    telegramId: string,
    reseauCible: string | null | undefined,
    typeContenu?: string | null,
  ): Promise<string | null> {
    if (!reseauCible) return null;
    const platform = RESEAU_TO_PLATFORM[reseauCible];
    if (!platform) return null;

    let row: {
      days_of_week: number[];
      preferred_time: Date | null;
      is_active: boolean | null;
      mode_planification: string;
    } | null = null;
    try {
      row = await this.prisma.publication_schedules.findFirst({
        where: { telegram_id: telegramId, platform },
        select: { days_of_week: true, preferred_time: true, is_active: true, mode_planification: true },
      });
    } catch (e) {
      this.logger.error(`planning schedule lookup error: ${e instanceof Error ? e.message : e}`);
    }

    const mode = row?.mode_planification || MODE_DEFAUT;
    const famille = this.familleDe(typeContenu, mode);
    const ptime = this.extractTime(row?.preferred_time);
    const days = new Set(row?.days_of_week || []);

    // « cumulé » : heure décalée par famille pour éviter deux publications à la même
    // minute. « à la suite » : un seul contenu par jour, donc l'heure préférée suffit.
    const heure = mod(ptime.hour + (FAMILLE_OFFSET_H[famille] ?? 0), 24);

    const occ = await this.joursOccupes(telegramId, reseauCible, famille, mode);
    const today = new Date();
    const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());

    for (let i = 1; i <= HORIZON_DAYS; i++) {
      const d = new Date(todayUtc + i * 86400000);
      const jourNum = d.getUTCDay(); // Dim=0…Sam=6, même convention que isoweekday()%7 côté Python
      if (days.size) {
        // Jours préférés définis -> on les respecte tels quels (même un week-end choisi exprès)
        if (!days.has(jourNum)) continue;
      } else {
        // Pas de jours définis -> jours ouvrés seulement (on saute samedi & dimanche)
        if (jourNum === 6 || jourNum === 0) continue;
      }
      const dateStr = d.toISOString().slice(0, 10);
      if (occ.has(dateStr)) continue;
      const [h, m, s] = this.heureHumanisee(heure, ptime.minute, [telegramId, platform, famille, dateStr]);
      const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m, s));
      return dt.toISOString();
    }

    this.logger.warn(`planning: aucun créneau libre trouvé pour ${reseauCible}/${famille} (tg ${telegramId})`);
    return null;
  }
}
