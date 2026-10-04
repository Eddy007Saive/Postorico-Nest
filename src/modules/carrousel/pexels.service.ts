import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';

/**
 * Photos libres de droits (Pexels) des styles de carrousel avec photos — port de
 * backend/services/pexels_service.py. Recherche d'après le secteur de la marque, photos portrait ;
 * le choix dépend d'une graine (le contenu) : un même carrousel retrouve les mêmes photos au rendu
 * et dans l'aperçu. Jamais bloquant : sans clé ou en erreur, liste vide (le style dessine des aplats).
 */
const API = 'https://api.pexels.com/v1/search';
const REPLI = 'bureau travail';
const DUREE_CACHE_MS = 6 * 3600 * 1000;
// Mots vides retirés de la requête (le secteur est parfois saisi comme une phrase)
const VIDES = new Set(['est', 'un', 'une', 'de', 'des', 'du', 'le', 'la', 'les', 'et', 'pour', 'en', 'à', 'au', 'aux', 'il', 'elle', 'qui', 'que', 'sur', 'avec', 'son', 'sa', 'ses', 'nous', 'vous', 'dans', 'par', 'ou', 'l', 'd']);

@Injectable()
export class PexelsService {
  private readonly logger = new Logger(PexelsService.name);
  private readonly cache = new Map<string, { quand: number; urls: string[] }>();
  private readonly cle: string;

  constructor(config: ConfigService) {
    this.cle = config.get<string>('app.pexelsApiKey') || '';
  }

  private async rechercher(requete: string): Promise<string[]> {
    const vu = this.cache.get(requete);
    if (vu && Date.now() - vu.quand < DUREE_CACHE_MS) return vu.urls;
    if (!this.cle) return [];
    try {
      const url = `${API}?${new URLSearchParams({ query: requete, orientation: 'portrait', per_page: '30', locale: 'fr-FR' })}`;
      const r = await fetch(url, { headers: { Authorization: this.cle }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const corps = (await r.json()) as { photos?: Array<{ src?: { portrait?: string } }> };
      const urls = (corps.photos || []).map((p) => p.src?.portrait).filter((u): u is string => !!u);
      this.cache.set(requete, { quand: Date.now(), urls });
      return urls;
    } catch (e) {
      this.logger.warn(`Pexels « ${requete} » : ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }

  /** Requête : 3 mots utiles du secteur de la marque (même règle que le Python), sinon la requête générique. */
  static requete(secteur?: string | null): string {
    return (secteur || '').toLowerCase().replace(/[,':]/g, ' ').split(/\s+/)
      .filter((m) => m.length > 2 && !VIDES.has(m)).slice(0, 3).join(' ') || REPLI;
  }

  /** `nombre` photos distinctes pour ce carrousel (même graine = mêmes photos). */
  async photos(secteur: string | null | undefined, graine: string, nombre = 5): Promise<string[]> {
    let urls = await this.rechercher(PexelsService.requete(secteur));
    if (!urls.length) urls = await this.rechercher(REPLI);
    if (!urls.length) return [];
    const debut = Number(BigInt('0x' + createHash('sha1').update(graine || 'x').digest('hex')) % BigInt(urls.length));
    return Array.from({ length: Math.min(nombre, urls.length) }, (_, i) => urls[(debut + i) % urls.length]);
  }
}
