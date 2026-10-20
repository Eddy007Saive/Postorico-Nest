import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PreRemplissage } from '../site/site.service';

const CACHE_TTL_MS = 7 * 24 * 3600 * 1000; // 7 jours
const CACHE_MAX = 500;
const IPS_MAX = 20000; // borne mémoire du suivi par IP

/** Hôte normalisé (minuscules, sans « www. ») de l'adresse saisie, sans résolution DNS ;
 * '' si l'adresse n'est pas une URL web. Clé du cache et du suivi par IP. */
export function cleDomaine(urlBrute: string): string {
  let url = (urlBrute || '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol) || !u.hostname.includes('.')) return '';
    return u.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  } catch {
    return '';
  }
}

/** Jour civil à Paris (AAAA-MM-JJ) : le plafond global repart à zéro à minuit, heure française. */
export function jourParis(ms: number): string {
  return new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris' }).format(new Date(ms));
}

/** Garde-fous de coût de POST onboarding/analyser-site (route publique, chaque analyse
 * réelle = lecture du site + un appel Claude payé par nous) :
 *  - cache par domaine, 7 jours, 500 entrées (les plus anciennes évincées) ;
 *  - plafond global d'analyses réelles par jour (Europe/Paris), cache non compté ;
 *  - N analyses par IP sur une fenêtre glissante (défaut 1 / 24 h). Redemander un domaine
 *    déjà analysé par cette IP ne compte pas (rechargement de page).
 * Tout est en mémoire : la prod tourne sur une seule instance (voir MEMORY : Redis
 * seulement avant 2+ réplicas). */
@Injectable()
export class GardeAnalyseSite {
  private readonly cache = new Map<string, { resultat: PreRemplissage; expire: number }>();
  private readonly ips = new Map<string, { debut: number; domaines: string[] }>();
  private jour = '';
  private analysesDuJour = 0;
  /** Horloge, remplaçable en test. */
  maintenant: () => number = () => Date.now();

  constructor(private readonly config: ConfigService) {}

  get maxParJour(): number {
    return this.config.get<number>('app.onboardingAnalysesMaxJour') || 100;
  }

  get maxParIp(): number {
    return this.config.get<number>('app.onboardingAnalysesParIp') || 1;
  }

  get fenetreIpMs(): number {
    return (this.config.get<number>('app.onboardingFenetreIpH') || 24) * 3600 * 1000;
  }

  // ---------------------------------------------------------------- cache

  lireCache(dom: string): PreRemplissage | null {
    const e = this.cache.get(dom);
    if (!e) return null;
    if (e.expire <= this.maintenant()) {
      this.cache.delete(dom);
      return null;
    }
    return e.resultat;
  }

  mettreEnCache(dom: string, resultat: PreRemplissage): void {
    this.cache.delete(dom); // réinsertion = plus récente
    this.cache.set(dom, { resultat, expire: this.maintenant() + CACHE_TTL_MS });
    while (this.cache.size > CACHE_MAX) {
      const plusAncienne = this.cache.keys().next().value as string;
      this.cache.delete(plusAncienne);
    }
  }

  // ---------------------------------------------------------------- par IP

  private suivi(ip: string) {
    const s = this.ips.get(ip);
    if (s && this.maintenant() - s.debut < this.fenetreIpMs) return s;
    if (s) this.ips.delete(ip);
    return null;
  }

  /** Cette IP a déjà analysé ce domaine dans la fenêtre. */
  dejaAnalyse(ip: string, dom: string): boolean {
    return !!this.suivi(ip)?.domaines.includes(dom);
  }

  /** Cette IP a épuisé ses analyses sur la fenêtre. */
  ipEpuisee(ip: string): boolean {
    return (this.suivi(ip)?.domaines.length || 0) >= this.maxParIp;
  }

  compterIp(ip: string, dom: string): void {
    const s = this.suivi(ip) || { debut: this.maintenant(), domaines: [] };
    if (!s.domaines.includes(dom)) s.domaines.push(dom);
    this.ips.set(ip, s);
    if (this.ips.size > IPS_MAX) this.ips.delete(this.ips.keys().next().value as string);
  }

  libererIp(ip: string, dom: string): void {
    const s = this.suivi(ip);
    if (!s) return;
    s.domaines = s.domaines.filter((d) => d !== dom);
    if (!s.domaines.length) this.ips.delete(ip);
  }

  // ---------------------------------------------------------------- plafond global

  private aJour(): void {
    const j = jourParis(this.maintenant());
    if (j !== this.jour) {
      this.jour = j;
      this.analysesDuJour = 0;
    }
  }

  plafondAtteint(): boolean {
    this.aJour();
    return this.analysesDuJour >= this.maxParJour;
  }

  compterJour(): void {
    this.aJour();
    this.analysesDuJour += 1;
  }

  libererJour(): void {
    this.aJour();
    this.analysesDuJour = Math.max(0, this.analysesDuJour - 1);
  }
}
