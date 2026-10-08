import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../config/prisma.service';
import { ZernioClientService } from '../zernio/zernio-client.service';
import { Creneau, creneauxLocaux, Frequence, frequences } from './analytics.service';
import { decalerMois, moisParis } from './mois.util';

/**
 * Rico Coach, brique 2 : le diagnostic mensuel d'un client.
 *
 * Lit stats_mensuelles et analytics_performance (remplies par StatsCollecteService) et en tire
 * des constats chiffrés : évolution vs mois précédent, format qui marche le mieux, volume et
 * régularité, meilleurs créneaux, meilleurs posts, fiche Google. Aucune IA.
 *
 * Règle : un constat sans assez de données est ABSENT plutôt qu'approximatif (seuils ci-dessous).
 * N'écrit que dans diagnostics_mensuels (upsert) ; `ecrire: false` calcule sans écrire.
 */

export const VERSION_DIAGNOSTIC = 1;
export const SEUILS = {
  /** Posts minimum par format (sur 3 mois) pour le comparer aux autres. */
  postsParFormat: 3,
  /** Écart minimum (×) entre le meilleur format et le suivant pour en tirer un constat. */
  ecartFormat: 1.2,
  /** Publications minimum derrière un créneau Zernio pour le retenir. */
  postsParCreneau: 3,
  /** Semaines minimum observées pour une cadence Zernio. */
  semainesParCadence: 2,
  /** Impressions (ou vues) minimum pour qu'un post entre au classement. */
  vuesTopPost: 20,
  /** Part des semaines du mois avec au moins un post pour parler de régularité. */
  partSemainesRegulier: 0.75,
};

const TOUS = 'tous';
const GBP = 'googlebusiness';

export interface LigneStats {
  mois: string; // AAAA-MM-01
  reseau: string;
  format: string;
  posts: number;
  impressions: number;
  vues: number;
  likes: number;
  commentaires: number;
  partages: number;
  enregistrements: number;
  abonnes: number | null;
  abonnes_gagnes: number | null;
  details: Record<string, unknown>;
}

export interface PostAnalyse {
  zernio_id: string | null;
  contenu_id: string | null;
  titre: string | null;
  reseau: string;
  format: string;
  publie_le: Date;
  impressions: number;
  vues: number;
  interactions: number;
  taux_engagement: number | null;
  url: string | null;
}

const interactions = (l: { likes: number; commentaires: number; partages: number; enregistrements: number }) => l.likes + l.commentaires + l.partages + l.enregistrements;
const taux = (inter: number, base: number): number | null => (base > 0 ? Math.round((inter / base) * 10000) / 100 : null);
const variation = (actuel: number, precedent: number | null | undefined): number | null =>
  precedent === null || precedent === undefined || precedent === 0 ? null : Math.round(((actuel - precedent) / precedent) * 1000) / 10;

/** Date (AAAA-MM-JJ) dans un fuseau. */
function jourLocal(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('fr-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function joursDuMois(mois: string): number {
  const [y, m] = mois.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// ---------------------------------------------------------------------------
// Constats (fonctions pures, testées dans diagnostic.service.spec.ts)
// ---------------------------------------------------------------------------

function resume(l: LigneStats | undefined) {
  if (!l) return null;
  const inter = interactions(l);
  return {
    posts: l.posts,
    impressions: l.impressions,
    vues: l.vues,
    interactions: inter,
    taux_engagement: taux(inter, l.impressions || l.vues),
    abonnes: l.abonnes,
    abonnes_gagnes: l.abonnes_gagnes,
  };
}

/** Évolution vs mois précédent, par réseau social et tous réseaux (la fiche Google à part). */
export function constatEvolution(stats: LigneStats[], mois: string) {
  const precedent = decalerMois(mois, -1);
  const de = (m: string, r: string) => stats.find((s) => s.mois === m && s.reseau === r && s.format === TOUS);
  const reseaux = [...new Set(stats.filter((s) => s.mois === mois && s.format === TOUS && s.reseau !== GBP).map((s) => s.reseau))].sort((a, b) =>
    a === TOUS ? -1 : b === TOUS ? 1 : a.localeCompare(b),
  );
  return reseaux.map((reseau) => {
    const a = resume(de(mois, reseau))!;
    const p = resume(de(precedent, reseau));
    return {
      reseau,
      actuel: a,
      precedent: p,
      variations: {
        posts: variation(a.posts, p?.posts),
        impressions: variation(a.impressions, p?.impressions),
        interactions: variation(a.interactions, p?.interactions),
        // Points de taux d'engagement gagnés ou perdus (pas un pourcentage de pourcentage).
        taux_engagement_points: a.taux_engagement !== null && p?.taux_engagement != null ? Math.round((a.taux_engagement - p.taux_engagement) * 100) / 100 : null,
        abonnes_gagnes: a.abonnes_gagnes !== null && p?.abonnes_gagnes != null ? a.abonnes_gagnes - p.abonnes_gagnes : null,
      },
    };
  });
}

/** Format qui marche le mieux, par réseau, sur les 3 derniers mois (mois analysé compris). */
export function constatFormats(stats: LigneStats[], mois: string) {
  const debut = decalerMois(mois, -2);
  const fenetre = stats.filter((s) => s.mois >= debut && s.mois <= mois && s.format !== TOUS && s.reseau !== TOUS && s.reseau !== GBP);
  const parReseau = new Map<string, Map<string, { posts: number; impressions: number; vues: number; interactions: number }>>();
  for (const s of fenetre) {
    const formats = parReseau.get(s.reseau) || new Map();
    const f = formats.get(s.format) || { posts: 0, impressions: 0, vues: 0, interactions: 0 };
    f.posts += s.posts;
    f.impressions += s.impressions;
    f.vues += s.vues;
    f.interactions += interactions(s);
    formats.set(s.format, f);
    parReseau.set(s.reseau, formats);
  }
  return [...parReseau].sort(([a], [b]) => a.localeCompare(b)).flatMap(([reseau, formats]) => {
    const retenus = [...formats]
      .map(([format, f]) => ({ format, posts: f.posts, impressions: f.impressions, vues: f.vues, taux_engagement: taux(f.interactions, f.impressions || f.vues) }))
      .filter((f) => f.posts >= SEUILS.postsParFormat && f.taux_engagement !== null)
      .sort((a, b) => b.taux_engagement! - a.taux_engagement!);
    if (retenus.length < 2) return [];
    const [premier, second] = retenus;
    const dernier = retenus[retenus.length - 1];
    const ratio = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 10) / 10 : null);
    const ecart = ratio(premier.taux_engagement!, second.taux_engagement!);
    return [{
      reseau,
      periode: { debut, fin: mois },
      formats: retenus,
      meilleur: ecart === null || ecart >= SEUILS.ecartFormat
        ? { format: premier.format, fois_plus_que_suivant: ecart, fois_plus_que_dernier: ratio(premier.taux_engagement!, dernier.taux_engagement!), dernier: dernier.format }
        : null,
    }];
  });
}

/** Volume publié, régularité dans le mois, cadence qui a le mieux marché (Zernio). */
export function constatVolume(stats: LigneStats[], posts: PostAnalyse[], mois: string, tz: string, frequence: Frequence[]) {
  const social = posts.filter((p) => p.reseau !== GBP);
  const nbJours = joursDuMois(mois);
  const jours = [...new Set(social.map((p) => Number(jourLocal(p.publie_le, tz).slice(8, 10))))].sort((a, b) => a - b);
  // Semaines du mois = tranches de 7 jours depuis le 1er (la dernière est partielle).
  const nbSemaines = Math.ceil(nbJours / 7);
  const semainesActives = new Set(jours.map((j) => Math.floor((j - 1) / 7))).size;
  // Plus long silence : du 1er au premier post, entre deux posts, du dernier post à la fin du mois.
  const bornes = [0, ...jours, nbJours + 1];
  let plusLongSilence = 0;
  for (let i = 1; i < bornes.length; i++) plusLongSilence = Math.max(plusLongSilence, bornes[i] - bornes[i - 1] - 1);
  const precedent = stats.find((s) => s.mois === decalerMois(mois, -1) && s.reseau === TOUS && s.format === TOUS);

  const parReseau = new Map<string, number>();
  for (const p of social) parReseau.set(p.reseau, (parReseau.get(p.reseau) || 0) + 1);
  const cadences = [...new Set(frequence.map((f) => f.platform.toLowerCase()))].map((reseau) => {
    const paliers = frequence.filter((f) => f.platform.toLowerCase() === reseau && f.semaines >= SEUILS.semainesParCadence).sort((a, b) => b.tauxEngagement - a.tauxEngagement);
    const actuel = Math.round(((parReseau.get(reseau) || 0) / (nbJours / 7)) * 10) / 10;
    return paliers.length >= 2
      ? { reseau, posts_par_semaine_actuel: actuel, meilleure_cadence: { posts_par_semaine: paliers[0].postsParSemaine, taux_engagement: paliers[0].tauxEngagement, semaines: paliers[0].semaines } }
      : null;
  }).filter((c) => c !== null);

  return {
    posts: social.length,
    posts_mois_precedent: precedent ? precedent.posts : null,
    par_reseau: Object.fromEntries([...parReseau].sort()),
    posts_par_semaine: Math.round((social.length / (nbJours / 7)) * 10) / 10,
    semaines_actives: semainesActives,
    semaines_du_mois: nbSemaines,
    plus_long_silence_jours: plusLongSilence,
    regulier: social.length > 0 && semainesActives / nbSemaines >= SEUILS.partSemainesRegulier,
    cadences,
  };
}

/** Meilleurs créneaux Zernio (déjà dans le fuseau du client), assez nourris pour être crus. */
export function constatCreneaux(creneaux: Creneau[]) {
  const retenus = creneaux.filter((c) => c.posts >= SEUILS.postsParCreneau).slice(0, 3);
  return retenus.length ? retenus : null;
}

/** Meilleurs posts du mois (taux d'engagement) et le plus vu. */
export function constatTopPosts(posts: PostAnalyse[]) {
  const visibles = posts.filter((p) => p.reseau !== GBP && (p.impressions || p.vues) >= SEUILS.vuesTopPost && p.taux_engagement !== null);
  const meilleurs = [...visibles].sort((a, b) => b.taux_engagement! - a.taux_engagement!).slice(0, 3);
  const plusVu = [...posts.filter((p) => p.reseau !== GBP)].sort((a, b) => (b.impressions || b.vues) - (a.impressions || a.vues))[0];
  const forme = (p: PostAnalyse) => ({ ...p, publie_le: p.publie_le.toISOString() });
  return { meilleurs: meilleurs.map(forme), plus_vu: plusVu && (plusVu.impressions || plusVu.vues) > 0 ? forme(plusVu) : null };
}

/** Fiche Google : mois analysé vs précédent. */
export function constatFicheGoogle(stats: LigneStats[], mois: string) {
  const fiche = (m: string) => {
    const l = stats.find((s) => s.mois === m && s.reseau === GBP && s.format === TOUS);
    return l ? { fiche: (l.details.fiche as Record<string, number>) || null, mots_cles: (l.details.mots_cles as unknown[]) || null } : null;
  };
  const a = fiche(mois);
  if (!a?.fiche) return null;
  const p = fiche(decalerMois(mois, -1))?.fiche || null;
  return {
    actuel: a.fiche,
    precedent: p,
    variations: Object.fromEntries(Object.entries(a.fiche).map(([k, v]) => [k, variation(v, p?.[k])])),
    mots_cles: a.mots_cles,
  };
}

export function diagnostiquer(entree: { mois: string; tz: string; stats: LigneStats[]; posts: PostAnalyse[]; creneaux: Creneau[]; frequence: Frequence[] }) {
  return {
    version: VERSION_DIAGNOSTIC,
    mois: entree.mois,
    fuseau: entree.tz,
    seuils: SEUILS,
    evolution: constatEvolution(entree.stats, entree.mois),
    formats: constatFormats(entree.stats, entree.mois),
    volume: constatVolume(entree.stats, entree.posts, entree.mois, entree.tz, entree.frequence),
    creneaux: constatCreneaux(entree.creneaux),
    top_posts: constatTopPosts(entree.posts),
    fiche_google: constatFicheGoogle(entree.stats, entree.mois),
  };
}

export type Diagnostic = ReturnType<typeof diagnostiquer>;

// ---------------------------------------------------------------------------

@Injectable()
export class DiagnosticService {
  private readonly logger = new Logger(DiagnosticService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly zernio: ZernioClientService,
  ) {}

  /**
   * @param mois AAAA-MM (défaut : le mois précédent, le dernier complet).
   * @param ecrire false = test à blanc, rien n'est écrit.
   */
  async diagnostiquerClient(telegramId: string, opts: { mois?: string; ecrire?: boolean; maintenant?: Date } = {}): Promise<{ ok: boolean; ecrit?: boolean; ignore?: string; diagnostic?: Diagnostic }> {
    const ecrire = opts.ecrire !== false;
    const mois = opts.mois && /^\d{4}-\d{2}$/.test(opts.mois) ? `${opts.mois}-01` : decalerMois(moisParis(opts.maintenant ?? new Date()), -1);
    const u = await this.prisma.users.findUnique({ where: { telegram_id: telegramId }, select: { late_profile_id: true, timezone: true } });
    if (!u) return { ok: false, ignore: 'client_inconnu' };
    const tz = u.timezone || 'Europe/Paris';

    const debut = decalerMois(mois, -2);
    const lignes = await this.prisma.stats_mensuelles.findMany({
      where: { telegram_id: telegramId, mois: { gte: new Date(`${debut}T00:00:00Z`), lte: new Date(`${mois}T00:00:00Z`) } },
    });
    if (!lignes.length) return { ok: true, ignore: 'aucune_stat_collectee' };
    const stats: LigneStats[] = lignes.map((l) => ({
      mois: l.mois.toISOString().slice(0, 10),
      reseau: l.reseau,
      format: l.format,
      posts: l.posts,
      impressions: l.impressions,
      vues: l.vues,
      likes: l.likes,
      commentaires: l.commentaires,
      partages: l.partages,
      enregistrements: l.enregistrements,
      abonnes: l.abonnes,
      abonnes_gagnes: l.abonnes_gagnes,
      details: (l.details as Record<string, unknown>) || {},
    }));

    // Posts du mois : marge d'un jour de chaque côté, puis filtre au mois local du client.
    const de = new Date(`${mois}T00:00:00Z`);
    de.setUTCDate(de.getUTCDate() - 1);
    const a = new Date(`${decalerMois(mois, 1)}T00:00:00Z`);
    a.setUTCDate(a.getUTCDate() + 1);
    const bruts = await this.prisma.analytics_performance.findMany({
      where: { telegram_id: telegramId, publie_le: { gte: de, lt: a }, zernio_id: { not: null } },
      select: { zernio_id: true, contenu_id: true, reseau: true, format: true, publie_le: true, impressions: true, vues: true, likes: true, commentaires: true, partages: true, enregistrements: true, url: true },
    });
    const dansLeMois = bruts.filter((p) => p.publie_le && `${jourLocal(p.publie_le, tz).slice(0, 7)}-01` === mois);
    const ids = [...new Set(dansLeMois.map((p) => p.contenu_id).filter((x): x is string => !!x))];
    const titres = new Map(
      (ids.length ? await this.prisma.contenu.findMany({ where: { id: { in: ids } }, select: { id: true, titre: true } }) : []).map((c) => [c.id, c.titre]),
    );
    const posts: PostAnalyse[] = dansLeMois.map((p) => {
      const inter = Number(p.likes || 0) + Number(p.commentaires || 0) + Number(p.partages || 0) + p.enregistrements;
      const vues = Number(p.vues || 0);
      return {
        zernio_id: p.zernio_id,
        contenu_id: p.contenu_id,
        titre: (p.contenu_id && titres.get(p.contenu_id)) || null,
        reseau: p.reseau || 'inconnu',
        format: p.format || 'texte',
        publie_le: p.publie_le!,
        impressions: p.impressions,
        vues,
        interactions: inter,
        taux_engagement: taux(inter, p.impressions || vues),
        url: p.url,
      };
    });

    // Créneaux et cadence : facultatifs (un échec Zernio retire le constat, pas le diagnostic).
    let creneaux: Creneau[] = [];
    let frequence: Frequence[] = [];
    if (u.late_profile_id && this.zernio.isConfigured) {
      const [best, freq] = await Promise.allSettled([this.zernio.getBestTimeToPost(u.late_profile_id), this.zernio.getPostingFrequency(u.late_profile_id)]);
      if (best.status === 'fulfilled') creneaux = creneauxLocaux(best.value.slots || [], tz);
      if (freq.status === 'fulfilled') frequence = frequences(freq.value);
    }

    const diagnostic = diagnostiquer({ mois, tz, stats, posts, creneaux, frequence });
    if (ecrire) {
      const moisDate = new Date(`${mois}T00:00:00Z`);
      const data = { telegram_id: telegramId, mois: moisDate, constats: diagnostic as never, version: VERSION_DIAGNOSTIC, calcule_le: new Date() };
      await this.prisma.diagnostics_mensuels.upsert({ where: { telegram_id_mois: { telegram_id: telegramId, mois: moisDate } }, create: data, update: data });
      this.logger.log(`diagnostic ${telegramId} ${mois} enregistré`);
    }
    return { ok: true, ecrit: ecrire, diagnostic };
  }
}
