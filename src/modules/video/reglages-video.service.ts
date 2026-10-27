import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../config/prisma.service';

/** Réglages du Montage IA qu'on peut garder par défaut, avec leur type attendu. */
const REGLAGES_MONTAGE: Record<string, 'texte' | 'bool' | 'nombre'> = {
  template: 'texte',
  langue: 'texte',
  zooms: 'bool',
  music: 'texte',
  volume: 'nombre',
  brolls: 'bool',
  brollPct: 'nombre',
  silencePace: 'texte',
  cleanAudio: 'bool',
  customId: 'texte',
  hookAuto: 'bool',
  hookPosition: 'texte',
  hookSize: 'nombre',
  emojis: 'bool',
  subFont: 'texte',
  subColor: 'texte',
  subSize: 'nombre',
  subPosition: 'nombre',
  subUppercase: 'bool',
};
export const CLES_REGLAGES = ['montage', 'consigne_video', 'consigne_motion'] as const;
export type CleReglage = (typeof CLES_REGLAGES)[number];
export const CONSIGNE_MAX = 1500;

export interface ReglagesVideo {
  montage?: Record<string, string | number | boolean | null> | null;
  consigne_video?: string | null;
  consigne_motion?: string | null;
}

/** Ne garde que les réglages connus, au bon type (texte court, nombre fini, booléen). */
export function nettoyerMontage(brut: unknown): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (!brut || typeof brut !== 'object' || Array.isArray(brut)) return out;
  for (const [cle, type] of Object.entries(REGLAGES_MONTAGE)) {
    const v = (brut as Record<string, unknown>)[cle];
    if (v === null && cle === 'customId') out[cle] = null;
    else if (type === 'texte' && typeof v === 'string') out[cle] = v.slice(0, 80);
    else if (type === 'bool' && typeof v === 'boolean') out[cle] = v;
    else if (type === 'nombre' && typeof v === 'number' && Number.isFinite(v)) out[cle] = Math.max(-1000, Math.min(1000, v));
  }
  return out;
}

/**
 * Réglages par défaut du Studio Vidéo, propres à chaque compte (users.reglages_video) :
 * les réglages du Montage IA, et une consigne par onglet de l'agent IA (« J'ai une vidéo »,
 * « Sans vidéo · motion design »), remis d'office à chaque ouverture.
 */
@Injectable()
export class ReglagesVideoService {
  constructor(private readonly prisma: PrismaService) {}

  async lire(telegramId: string): Promise<ReglagesVideo> {
    const u = await this.prisma.users.findUnique({ where: { telegram_id: telegramId }, select: { reglages_video: true } });
    const r = u?.reglages_video;
    return r && typeof r === 'object' && !Array.isArray(r) ? (r as ReglagesVideo) : {};
  }

  /** Remplace un seul réglage ; `null` ou une consigne vide l'efface. */
  async ecrire(telegramId: string, cle: CleReglage, valeur: unknown): Promise<ReglagesVideo> {
    const actuels = await this.lire(telegramId);
    const suivants: ReglagesVideo = { ...actuels };
    if (cle === 'montage') {
      const m = valeur === null ? {} : nettoyerMontage(valeur);
      if (Object.keys(m).length) suivants.montage = m;
      else delete suivants.montage;
    } else {
      const texte = typeof valeur === 'string' ? valeur.trim().slice(0, CONSIGNE_MAX) : '';
      if (texte) suivants[cle] = texte;
      else delete suivants[cle];
    }
    await this.prisma.users.update({
      where: { telegram_id: telegramId },
      data: { reglages_video: suivants as Prisma.InputJsonValue },
    });
    return suivants;
  }
}
