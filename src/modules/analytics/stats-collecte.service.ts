import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../config/prisma.service';
import { ZernioClientService, ZernioError } from '../zernio/zernio-client.service';
import { DiagnosticService } from './diagnostic.service';
import { decalerMois, moisParis } from './mois.util';

export { decalerMois, moisParis } from './mois.util';

/**
 * Rico Coach, brique 1 : collecte de l'historique des statistiques.
 *
 * Pour un client : récupère ses posts et leurs stats chez Zernio, les enregistre un par un
 * dans `analytics_performance` (une ligne par post et par réseau), puis calcule les totaux
 * par mois, réseau et format dans `stats_mensuelles`, avec les abonnés et la fiche Google.
 *
 * Aucune IA ici : tout est calculé. N'écrit QUE dans ces deux tables, par upsert (jamais de
 * suppression). `ecrire: false` calcule tout sans rien écrire (test à blanc).
 *
 * Seuls les mois ENTIÈREMENT couverts par la fenêtre sont écrits : un mois tronqué
 * écraserait ses vrais totaux par des totaux partiels.
 */

const TOUS = 'tous';
const GBP = 'googlebusiness';

/** Champs Zernio rangés dans des colonnes ; les autres (scalaires) vont dans `details`. */
const CHAMPS_COLONNES = new Set(['impressions', 'reach', 'likes', 'comments', 'shares', 'saves', 'clicks', 'views', 'lastUpdated']);

export interface PostCollecte {
  zernio_id: string;
  late_post_id: string | null;
  plateforme_post_id: string | null;
  compte_id: string | null;
  reseau: string;
  format: string;
  publie_le: Date | null;
  impressions: number;
  portee: number;
  vues: number;
  likes: number;
  commentaires: number;
  partages: number;
  enregistrements: number;
  clics: number;
  taux_engagement: number | null;
  url: string | null;
  externe: boolean;
  details: Record<string, unknown>;
  maj_zernio: Date | null;
}

export interface MoisCollecte {
  mois: string; // AAAA-MM-01
  reseau: string;
  format: string;
  posts: number;
  impressions: number;
  portee: number;
  vues: number;
  likes: number;
  commentaires: number;
  partages: number;
  enregistrements: number;
  clics: number;
  taux_engagement: number | null;
  abonnes: number | null;
  abonnes_gagnes: number | null;
  details: Record<string, unknown>;
}

export interface ResultatCollecte {
  ok: boolean;
  telegram_id: string;
  ignore?: string;
  addon_required?: boolean;
  error?: string;
  ecrit?: boolean;
  fenetre?: { debut: string; fin: string };
  posts?: number;
  posts_relies?: number;
  lignes_mois?: number;
  apercu?: { posts: PostCollecte[]; mois: MoisCollecte[] };
}

// ---------------------------------------------------------------------------
// Fonctions pures (testées dans stats-collecte.service.spec.ts)
// ---------------------------------------------------------------------------

/** Format Postorico d'une entrée Zernio. Sur Instagram, toute vidéo est un reel. */
export function formatDe(reseau: string, mediaType: unknown, mediaProductType: unknown): string {
  const mt = String(mediaType || '').toLowerCase();
  const mpt = String(mediaProductType || '').toUpperCase();
  if (mpt === 'STORY' || mt === 'story') return 'story';
  if (mpt === 'REELS' || mt === 'reel' || mt === 'reels') return 'reel';
  if (mt === 'carousel' || mt === 'carrousel') return 'carrousel';
  if (mt === 'video') return reseau === 'instagram' ? 'reel' : 'video';
  if (mt === 'image' || mt === 'photo' || mt === 'gif') return 'image';
  if (mt === 'document' || mt === 'pdf') return 'document';
  return 'texte';
}

/** Interactions / impressions (ou vues si le réseau ne donne pas d'impressions), en %. */
export function tauxEngagement(c: { impressions: number; vues: number; likes: number; commentaires: number; partages: number; enregistrements: number }): number | null {
  const base = c.impressions || c.vues;
  if (!base) return null;
  const taux = ((c.likes + c.commentaires + c.partages + c.enregistrements) / base) * 100;
  return Math.min(9999.99, Math.round(taux * 100) / 100);
}

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Convertit une entrée de /v1/analytics en ligne d'analytics_performance. */
export function postDepuisZernio(p: Record<string, unknown>): PostCollecte | null {
  const zernioId = p._id as string | undefined;
  if (!zernioId) return null;
  const plat0 = ((p.platforms as Array<Record<string, unknown>>) || [])[0] || {};
  const reseau = String(p.platform || plat0.platform || '').toLowerCase() || 'inconnu';
  const a = (p.analytics as Record<string, unknown>) || {};
  const details: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a)) {
    if (CHAMPS_COLONNES.has(k) || v === null || v === undefined || typeof v === 'object') continue;
    details[k] = v;
  }
  if (p.mediaType) details.mediaType = p.mediaType;
  if (p.mediaProductType) details.mediaProductType = p.mediaProductType;
  const compteurs = {
    impressions: n(a.impressions),
    portee: n(a.reach),
    vues: n(a.views),
    likes: n(a.likes),
    commentaires: n(a.comments),
    partages: n(a.shares),
    enregistrements: n(a.saves),
    clics: n(a.clicks),
  };
  const publie = p.publishedAt ? new Date(p.publishedAt as string) : null;
  const maj = a.lastUpdated ? new Date(`${String(a.lastUpdated).replace(' ', 'T')}Z`) : null;
  const latePostId = (p.latePostId as string) || null;
  return {
    zernio_id: zernioId,
    late_post_id: latePostId,
    plateforme_post_id: (plat0.platformPostId as string) || null,
    compte_id: (plat0.accountId as string) || null,
    reseau,
    format: formatDe(reseau, p.mediaType, p.mediaProductType),
    publie_le: publie && !Number.isNaN(publie.getTime()) ? publie : null,
    ...compteurs,
    taux_engagement: tauxEngagement(compteurs),
    url: (p.platformPostUrl as string) || (plat0.platformPostUrl as string) || null,
    // Publié hors Postorico = aucun post Zernio créé par nous (latePostId vide).
    externe: !latePostId,
    details,
    maj_zernio: maj && !Number.isNaN(maj.getTime()) ? maj : null,
  };
}

function ligneVide(mois: string, reseau: string, format: string): MoisCollecte {
  return {
    mois, reseau, format, posts: 0, impressions: 0, portee: 0, vues: 0, likes: 0, commentaires: 0,
    partages: 0, enregistrements: 0, clics: 0, taux_engagement: null, abonnes: null, abonnes_gagnes: null, details: {},
  };
}

/**
 * Totaux par (mois, réseau, format), plus (mois, réseau, 'tous') et (mois, 'tous', 'tous').
 * Seuls les mois de `moisRetenus` sont produits ; un mois sans post y figure quand même
 * (0 post, c'est une information) pour chaque réseau connecté.
 */
export function agregerMois(posts: PostCollecte[], moisRetenus: string[], reseauxConnectes: string[]): Map<string, MoisCollecte> {
  const lignes = new Map<string, MoisCollecte>();
  const cle = (m: string, r: string, f: string) => `${m}|${r}|${f}`;
  const ligne = (m: string, r: string, f: string) => {
    const k = cle(m, r, f);
    if (!lignes.has(k)) lignes.set(k, ligneVide(m, r, f));
    return lignes.get(k)!;
  };
  const retenus = new Set(moisRetenus);
  for (const m of moisRetenus) {
    ligne(m, TOUS, TOUS);
    for (const r of reseauxConnectes) ligne(m, r, TOUS);
  }
  for (const p of posts) {
    if (!p.publie_le) continue;
    const m = moisParis(p.publie_le);
    if (!retenus.has(m)) continue;
    const cibles = [ligne(m, p.reseau, p.format), ligne(m, p.reseau, TOUS)];
    // La fiche Google n'entre pas dans le total « tous réseaux » : ses posts n'ont pas de stats.
    if (p.reseau !== GBP) cibles.push(ligne(m, TOUS, TOUS));
    for (const l of cibles) {
      l.posts += 1;
      l.impressions += p.impressions;
      l.portee += p.portee;
      l.vues += p.vues;
      l.likes += p.likes;
      l.commentaires += p.commentaires;
      l.partages += p.partages;
      l.enregistrements += p.enregistrements;
      l.clics += p.clics;
    }
  }
  for (const l of lignes.values()) l.taux_engagement = tauxEngagement(l);
  return lignes;
}

/**
 * Abonnés en fin de mois et abonnés gagnés, par réseau. Zernio donne la valeur au 1er de
 * chaque mois : fin du mois M = point du 1er de M+1, ou la valeur actuelle pour le mois en cours.
 */
export function abonnesParMois(
  series: Record<string, Array<{ date: string; followers: number }>>,
  comptes: Array<{ _id: string; platform?: string; currentFollowers?: number | null }>,
  moisRetenus: string[],
  moisCourant: string,
): Map<string, { abonnes: number | null; gagnes: number | null }> {
  const res = new Map<string, { abonnes: number | null; gagnes: number | null }>();
  for (const c of comptes) {
    const reseau = String(c.platform || '').toLowerCase();
    // Une fiche Google n'a pas d'abonnés (Zernio renvoie 0) : on ne l'affiche pas comme tel.
    if (!reseau || reseau === GBP) continue;
    const points = new Map((series[c._id] || []).map((p) => [p.date.slice(0, 10), p.followers]));
    for (const m of moisRetenus) {
      const debut = points.get(m);
      const fin = m === moisCourant ? (c.currentFollowers ?? points.get(decalerMois(m, 1))) : points.get(decalerMois(m, 1));
      if (fin === undefined || fin === null) continue;
      for (const r of [reseau, TOUS]) {
        const k = `${m}|${r}`;
        const cur = res.get(k) || { abonnes: null, gagnes: null };
        cur.abonnes = (cur.abonnes ?? 0) + fin;
        if (debut !== undefined && debut !== null) cur.gagnes = (cur.gagnes ?? 0) + (fin - debut);
        res.set(k, cur);
      }
    }
  }
  return res;
}

/** Métriques quotidiennes de la fiche Google regroupées par mois (heure de Paris = date du jour). */
export function ficheGoogleParMois(metrics: Record<string, { values?: Array<{ date: string; value: number }> }>): Map<string, Record<string, number>> {
  const groupes: Record<string, string[]> = {
    vues_recherche: ['BUSINESS_IMPRESSIONS_DESKTOP_SEARCH', 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH'],
    vues_maps: ['BUSINESS_IMPRESSIONS_DESKTOP_MAPS', 'BUSINESS_IMPRESSIONS_MOBILE_MAPS'],
    appels: ['CALL_CLICKS'],
    itineraires: ['BUSINESS_DIRECTION_REQUESTS'],
    clics_site: ['WEBSITE_CLICKS'],
    reservations: ['BUSINESS_BOOKINGS'],
    conversations: ['BUSINESS_CONVERSATIONS'],
  };
  const res = new Map<string, Record<string, number>>();
  for (const [nom, cles] of Object.entries(groupes)) {
    for (const cleMetrique of cles) {
      for (const v of metrics[cleMetrique]?.values || []) {
        const m = `${v.date.slice(0, 7)}-01`;
        const cur = res.get(m) || Object.fromEntries(Object.keys(groupes).map((k) => [k, 0]));
        cur[nom] += n(v.value);
        res.set(m, cur);
      }
    }
  }
  return res;
}

// ---------------------------------------------------------------------------

@Injectable()
export class StatsCollecteService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StatsCollecteService.name);
  private readonly cronHeures: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly zernio: ZernioClientService,
    config: ConfigService,
    private readonly diagnostic: DiagnosticService,
  ) {
    this.cronHeures = config.get<number>('app.statsCollecteHeures') || 0;
  }

  /** Cron désactivé par défaut (STATS_COLLECTE_HOURS=0) : recalcule le mois en cours et le
   * précédent pour tous les clients. Le mois précédent se fige ainsi au fil des jours. */
  onApplicationBootstrap(): void {
    if (!(this.cronHeures > 0)) return;
    this.logger.log(`Collecte des stats mensuelles activée (toutes les ${this.cronHeures} h)`);
    setTimeout(() => {
      void this.collecterTous(2);
      setInterval(() => void this.collecterTous(2), this.cronHeures * 3600 * 1000);
    }, 5 * 60_000);
  }

  async collecterTous(nbMois = 2): Promise<{ ok: boolean; clients: number; erreurs: number }> {
    if (!this.zernio.isConfigured) return { ok: false, clients: 0, erreurs: 0 };
    const users = await this.prisma.users.findMany({ where: { actif: true, late_profile_id: { not: null } }, select: { telegram_id: true } });
    let erreurs = 0;
    for (const u of users) {
      const r = await this.collecterClient(u.telegram_id, { nbMois }).catch((e) => ({ ok: false, error: String(e) }) as ResultatCollecte);
      if (!r.ok) erreurs += 1;
      // Diagnostic du mois précédent, recalculé tant que ses stats bougent encore (brique 2).
      else if (r.ecrit) {
        await this.diagnostic.diagnostiquerClient(u.telegram_id).catch((e) => this.logger.warn(`diagnostic ${u.telegram_id}: ${e instanceof Error ? e.message : e}`));
      }
    }
    this.logger.log(`stats mensuelles : ${users.length} clients, ${erreurs} erreurs`);
    return { ok: true, clients: users.length, erreurs };
  }

  /**
   * @param nbMois mois complets à (re)calculer, mois en cours compris (1 à 12 : Zernio
   *               refuse plus d'un an par appel).
   * @param ecrire false = test à blanc : tout est calculé et renvoyé, rien n'est écrit.
   */
  async collecterClient(telegramId: string, opts: { nbMois?: number; ecrire?: boolean; maintenant?: Date } = {}): Promise<ResultatCollecte> {
    const nbMois = Math.min(12, Math.max(1, Math.trunc(opts.nbMois ?? 2)));
    const ecrire = opts.ecrire !== false;
    const maintenant = opts.maintenant ?? new Date();
    const u = await this.prisma.users.findUnique({ where: { telegram_id: telegramId }, select: { late_profile_id: true } });
    const profileId = u?.late_profile_id;
    if (!profileId) return { ok: true, telegram_id: telegramId, ignore: 'aucun_profil_zernio' };
    // Profil Zernio partagé par plusieurs comptes : les posts passeraient d'un compte à
    // l'autre à chaque collecte (zernio_id est unique). On ne collecte pas, on le signale.
    const partage = await this.prisma.users.count({ where: { late_profile_id: profileId, telegram_id: { not: telegramId } } });
    if (partage > 0) {
      this.logger.warn(`collecte ${telegramId} : profil Zernio ${profileId} partagé avec ${partage} autre(s) compte(s), ignoré`);
      return { ok: true, telegram_id: telegramId, ignore: 'profil_zernio_partage' };
    }

    const moisCourant = moisParis(maintenant);
    const premierMois = decalerMois(moisCourant, -(nbMois - 1));
    const moisRetenus = Array.from({ length: nbMois }, (_, i) => decalerMois(premierMois, i));
    // Un jour de marge avant le 1er : un post du 1er à 00h30 (Paris) est la veille en UTC.
    const veille = new Date(`${premierMois}T00:00:00Z`);
    veille.setUTCDate(veille.getUTCDate() - 1);
    const fromDate = veille.toISOString().slice(0, 10);
    const toDate = maintenant.toISOString().slice(0, 10);

    // 1. Posts
    const bruts: Record<string, unknown>[] = [];
    try {
      for (let page = 1; page <= 50; page++) {
        const d = await this.zernio.getAnalyticsPage({ profileId, fromDate, toDate, page });
        bruts.push(...(d.posts || []));
        if (page >= (d.pagination?.pages || 1)) break;
      }
    } catch (e) {
      if (e instanceof ZernioError && e.statusCode && [402, 403].includes(e.statusCode)) return { ok: true, telegram_id: telegramId, addon_required: true };
      this.logger.warn(`collecte ${telegramId} posts: ${e instanceof Error ? e.message : e}`);
      return { ok: false, telegram_id: telegramId, error: e instanceof Error ? e.message : String(e) };
    }
    const posts = bruts.map(postDepuisZernio).filter((p): p is PostCollecte => p !== null);

    // Rattachement aux contenus Postorico (contenu.late_post_id = latePostId Zernio)
    const latePostIds = [...new Set(posts.map((p) => p.late_post_id).filter((x): x is string => !!x))];
    const contenus = latePostIds.length
      ? await this.prisma.contenu.findMany({ where: { telegram_id: telegramId, late_post_id: { in: latePostIds } }, select: { id: true, late_post_id: true, reseau_cible: true } })
      : [];
    const contenuDe = (p: PostCollecte): string | null => {
      const candidats = contenus.filter((c) => c.late_post_id === p.late_post_id);
      return (candidats.find((c) => String(c.reseau_cible || '').toLowerCase() === p.reseau) || candidats[0])?.id ?? null;
    };

    // 2. Comptes, abonnés, fiche Google
    let comptes: Array<{ _id: string; platform?: string; currentFollowers?: number | null }> = [];
    let series: Record<string, Array<{ date: string; followers: number }>> = {};
    try {
      const fs = await this.zernio.getFollowerStatsMensuel({ profileId, fromDate, toDate });
      comptes = fs.accounts || [];
      series = fs.stats || {};
    } catch (e) {
      this.logger.warn(`collecte ${telegramId} abonnés: ${e instanceof Error ? e.message : e}`);
    }
    let comptesGbp: string[] = [];
    let reseauxConnectes = comptes.map((c) => String(c.platform || '').toLowerCase()).filter(Boolean);
    try {
      const acc = await this.zernio.listAccounts(profileId);
      const liste = acc.accounts || acc.data || [];
      reseauxConnectes = [...new Set([...reseauxConnectes, ...liste.filter((a) => a.isActive !== false).map((a) => String(a.platform || '').toLowerCase()).filter(Boolean)])];
      comptesGbp = liste.filter((a) => String(a.platform).toLowerCase() === GBP && a.isActive !== false).map((a) => (a._id || a.id) as string).filter(Boolean);
    } catch (e) {
      this.logger.warn(`collecte ${telegramId} comptes: ${e instanceof Error ? e.message : e}`);
    }

    const lignes = agregerMois(posts, moisRetenus, reseauxConnectes);
    for (const [k, v] of abonnesParMois(series, comptes, moisRetenus, moisCourant)) {
      const [m, r] = k.split('|');
      const l = lignes.get(`${m}|${r}|${TOUS}`);
      if (l) {
        l.abonnes = v.abonnes;
        l.abonnes_gagnes = v.gagnes;
      }
    }
    for (const accountId of comptesGbp) {
      try {
        const perf = await this.zernio.getGoogleBusinessPerformance({ accountId, startDate: premierMois, endDate: toDate });
        for (const [m, valeurs] of ficheGoogleParMois(perf.metrics || {})) {
          const l = lignes.get(`${m}|${GBP}|${TOUS}`);
          if (!l) continue;
          const fiche = (l.details.fiche as Record<string, number>) || {};
          for (const [cleV, v] of Object.entries(valeurs)) fiche[cleV] = (fiche[cleV] || 0) + v;
          l.details.fiche = fiche;
        }
        // Mots-clés : un appel par mois, limité aux 3 derniers mois retenus.
        for (const m of moisRetenus.slice(-3)) {
          const l = lignes.get(`${m}|${GBP}|${TOUS}`);
          if (!l) continue;
          const kw = await this.zernio.getGoogleBusinessKeywords({ accountId, startMonth: m.slice(0, 7), endMonth: m.slice(0, 7) }).catch(() => ({ keywords: [] }));
          const utiles = (kw.keywords || []).filter((k) => k.impressions > 0).sort((a, b) => b.impressions - a.impressions).slice(0, 15);
          if (utiles.length) l.details.mots_cles = utiles;
        }
      } catch (e) {
        this.logger.warn(`collecte ${telegramId} fiche Google ${accountId}: ${e instanceof Error ? e.message : e}`);
      }
    }

    const mois = [...lignes.values()].sort((a, b) => a.mois.localeCompare(b.mois) || a.reseau.localeCompare(b.reseau) || a.format.localeCompare(b.format));
    const base: ResultatCollecte = {
      ok: true,
      telegram_id: telegramId,
      ecrit: ecrire,
      fenetre: { debut: premierMois, fin: toDate },
      posts: posts.length,
      posts_relies: posts.filter((p) => contenuDe(p)).length,
      lignes_mois: mois.length,
    };
    if (!ecrire) return { ...base, apercu: { posts, mois } };

    // 3. Écriture (upserts uniquement), par paquets de 5 en parallèle (au-delà, le pool de connexions sature)
    const ecritures: Array<() => Promise<unknown>> = [
      ...posts.map((p) => () => {
        const data = { ...p, contenu_id: contenuDe(p), telegram_id: telegramId, details: p.details as never, updated_at: new Date() };
        return this.prisma.analytics_performance.upsert({ where: { zernio_id: p.zernio_id }, create: data, update: data });
      }),
      ...mois.map((l) => () => {
        const moisDate = new Date(`${l.mois}T00:00:00Z`);
        const data = { ...l, mois: moisDate, telegram_id: telegramId, details: l.details as never, source: 'zernio', calcule_le: new Date() };
        return this.prisma.stats_mensuelles.upsert({
          where: { telegram_id_mois_reseau_format: { telegram_id: telegramId, mois: moisDate, reseau: l.reseau, format: l.format } },
          create: data,
          update: data,
        });
      }),
    ];
    for (let i = 0; i < ecritures.length; i += 5) await Promise.all(ecritures.slice(i, i + 5).map((f) => f()));
    this.logger.log(`stats mensuelles ${telegramId} : ${posts.length} posts, ${mois.length} lignes (${premierMois} → ${toDate})`);
    return base;
  }
}
