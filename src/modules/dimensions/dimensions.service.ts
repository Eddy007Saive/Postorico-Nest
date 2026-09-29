import { Injectable } from '@nestjs/common';
import { OffersService } from '../offers/offers.service';
import { SocialService } from '../social/social.service';

/**
 * Dimensions d'un sujet (objectif/angle/cible/format/offre) — infrastructure partagée
 * entre l'agent SUJETS (qui les propose) et l'agent RÉDACTION (qui les respecte comme
 * brief). Port direct de la partie DIMENSIONS de backend/services/agent_service.py.
 *
 * Valeurs FIGÉES : l'IA choisit dedans, jamais en dehors (sinon l'UI ne sait pas afficher).
 */
export const DIMENSIONS: Record<string, string[]> = {
  objectif: [
    'Engagement', 'Notoriété', 'Éducation', 'Conversion',
    'Génération de prospects', 'Fidélisation', 'Preuve sociale',
  ],
  angle: [
    'Problème → solution', 'Astuce', 'Comparaison', 'Controverse',
    'Storytelling', 'Témoignage', 'Démonstration', 'Inspiration',
    'Humour', 'Curiosité',
  ],
  cible: ['Nouvelle audience', 'Prospect', 'Client', 'Client fidèle', 'Segment spécifique'],
  format: ['Reel', 'Post', 'Carrousel', 'Story', 'Article', 'Vidéo longue'],
};

export const DIM_LABELS: Record<string, string> = {
  objectif: 'Objective',
  angle: 'Angle',
  cible: 'Target',
  format: 'Format',
};

// Un format n'a de sens que si un réseau capable de le publier est connecté (un seul suffit).
const FORMAT_PLATEFORMES: Record<string, Set<string>> = {
  Post: new Set(['linkedin', 'facebook', 'instagram', 'googlebusiness', 'twitter']),
  Carrousel: new Set(['linkedin', 'instagram', 'facebook']),
  Story: new Set(['instagram', 'facebook']),
  Reel: new Set(['tiktok', 'instagram', 'youtube']),
  Article: new Set(['linkedin']),
  'Vidéo longue': new Set(['youtube']),
};

@Injectable()
export class DimensionsService {
  constructor(
    private readonly offersService: OffersService,
    private readonly socialService: SocialService,
  ) {}

  /** Garde une valeur de dimension seulement si elle appartient à la liste figée. */
  validerDimension(cle: string, valeur: unknown): string | undefined {
    const v = typeof valeur === 'string' ? valeur.trim() : '';
    const liste = DIMENSIONS[cle] ?? [];
    return v && liste.includes(v) ? v : undefined;
  }

  /** Valide un format ET le contraint aux formats publiables ; repli sur Post. */
  validerFormat(valeur: unknown, autorises: string[]): string {
    const v = this.validerDimension('format', valeur);
    if (v && autorises.includes(v)) return v;
    return autorises.includes('Post') ? 'Post' : autorises[0] || 'Post';
  }

  /** Sous-ensemble de DIMENSIONS['format'] réellement publiable vu les réseaux connectés
   * de ce compte. Repli sur ['Post','Carrousel'] si rien de connecté. */
  async formatsDisponibles(telegramId: string): Promise<string[]> {
    let connectes = new Set<string>();
    try {
      connectes = new Set(Object.keys(await this.socialService.comptes(telegramId)));
    } catch {
      connectes = new Set();
    }
    const dispo = DIMENSIONS.format.filter((f) => {
      const plateformes = FORMAT_PLATEFORMES[f] ?? new Set<string>();
      return [...plateformes].some((p) => connectes.has(p));
    });
    return dispo.length ? dispo : ['Post', 'Carrousel'];
  }

  /** Les listes de dimensions pour ce compte : 'format' filtré sur ses réseaux,
   * 'offre' = ses offres actives (liste dynamique, vide si aucune). */
  async dimensionsPour(telegramId: string): Promise<Record<string, string[]>> {
    const formats = await this.formatsDisponibles(telegramId);
    let offre: string[] = [];
    try {
      offre = await this.offersService.noms(telegramId);
    } catch {
      offre = [];
    }
    return { ...DIMENSIONS, format: formats, offre };
  }

  /** Garde une valeur « offre » seulement si elle correspond à une offre réelle du compte. */
  async validerOffre(telegramId: string, valeur: unknown): Promise<string | undefined> {
    const v = typeof valeur === 'string' ? valeur.trim() : '';
    if (!v) return undefined;
    try {
      const noms = await this.offersService.noms(telegramId);
      return noms.includes(v) ? v : undefined;
    } catch {
      return undefined;
    }
  }
}
