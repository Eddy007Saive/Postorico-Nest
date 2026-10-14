/**
 * Publicités Meta (Facebook / Instagram) via Zernio : vérification d'une demande de boost,
 * construction de la requête POST /v1/ads/boost, et mise au format écran des pubs.
 * Doc : https://docs.zernio.com/ad-campaigns/boost-post
 */

export const OBJECTIFS = [
  'awareness',
  'engagement',
  'traffic',
  'video_views',
] as const;
export type Objectif = (typeof OBJECTIFS)[number];

export const BOUTONS = [
  'LEARN_MORE',
  'SHOP_NOW',
  'SIGN_UP',
  'CONTACT_US',
] as const;

export const BUDGET_JOUR_MAX = 500;
export const BUDGET_TOTAL_MAX = 5000;
export const DUREE_MAX_JOURS = 90;

export interface Ville {
  id: string;
  nom?: string;
  rayon_km?: number | null;
}

export interface DemandeBoost {
  contenu_id: string;
  compte_pub: string;
  objectif: Objectif;
  budget: number;
  type_budget: 'daily' | 'lifetime';
  /** « AAAA-MM-JJ », dans le fuseau du compte publicitaire. */
  debut?: string | null;
  fin?: string | null;
  villes?: Ville[] | null;
  pays?: string[] | null;
  age_min?: number | null;
  age_max?: number | null;
  lien?: string | null;
  bouton?: string | null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const jour = (d: string) =>
  Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));

/** Message d'erreur lisible si la demande ne peut pas partir, sinon null. `aujourdhui` : AAAA-MM-JJ. */
export function verifierBoost(
  d: DemandeBoost,
  aujourdhui: string,
  minJour = 1,
): string | null {
  if (!OBJECTIFS.includes(d.objectif)) return 'Objectif de publicité inconnu.';
  const b = Number(d.budget);
  if (!Number.isFinite(b) || b <= 0) return 'Indique un budget.';
  if (d.type_budget !== 'daily' && d.type_budget !== 'lifetime')
    return 'Type de budget inconnu.';
  if (d.debut && !DATE.test(d.debut)) return 'Date de début invalide.';
  if (d.fin && !DATE.test(d.fin)) return 'Date de fin invalide.';
  if (d.debut && jour(d.debut) < jour(aujourdhui))
    return 'La date de début est passée.';
  if (d.type_budget === 'lifetime' && !d.fin)
    return 'Un budget total demande une date de fin.';
  const debut = d.debut || aujourdhui;
  if (d.fin) {
    if (jour(d.fin) < jour(debut))
      return 'La date de fin est avant la date de début.';
    const jours = (jour(d.fin) - jour(debut)) / 86400000 + 1;
    if (jours > DUREE_MAX_JOURS)
      return `${DUREE_MAX_JOURS} jours maximum par publicité.`;
    if (d.type_budget === 'lifetime' && b / jours < minJour)
      return `Budget trop faible : au moins ${minJour} € par jour de diffusion.`;
  }
  if (d.type_budget === 'daily') {
    if (b < minJour) return `Budget minimum : ${minJour} € par jour.`;
    if (b > BUDGET_JOUR_MAX)
      return `Budget maximum : ${BUDGET_JOUR_MAX} € par jour.`;
  } else if (b > BUDGET_TOTAL_MAX)
    return `Budget maximum : ${BUDGET_TOTAL_MAX} € au total.`;
  const min = d.age_min ?? 18;
  const max = d.age_max ?? 65;
  if (min < 18 || max > 65 || min > max) return 'Âges entre 18 et 65 ans.';
  if ((d.villes || []).length > 25) return '25 villes au maximum.';
  for (const v of d.villes || []) {
    if (!v?.id || !/^\d+$/.test(String(v.id)))
      return 'Ville invalide : choisis-la dans la liste.';
    if (v.rayon_km != null && (v.rayon_km < 1 || v.rayon_km > 80))
      return 'Rayon autour d’une ville : de 1 à 80 km.';
  }
  for (const p of d.pays || [])
    if (!/^[A-Z]{2}$/.test(p)) return 'Pays invalide.';
  if (d.objectif === 'traffic') {
    if (!d.lien || !/^https:\/\/\S+$/.test(d.lien.trim()))
      return 'Pour des visites, indique le lien du site (https://…).';
    if (d.bouton && !(BOUTONS as readonly string[]).includes(d.bouton))
      return 'Bouton inconnu.';
  }
  return null;
}

/** Corps de POST /v1/ads/boost (demande déjà vérifiée). */
export function corpsBoost(
  d: DemandeBoost,
  o: { accountId: string; postId: string; nom: string; beneficiaire: string },
): Record<string, unknown> {
  const villes = (d.villes || []).map((v) =>
    v.rayon_km
      ? {
          key: String(v.id),
          radius: Math.round(v.rayon_km),
          distance_unit: 'kilometer',
        }
      : { key: String(v.id) },
  );
  const targeting: Record<string, unknown> = {
    ageMin: d.age_min ?? 18,
    ageMax: d.age_max ?? 65,
  };
  if (villes.length) targeting.cities = villes;
  else targeting.countries = d.pays?.length ? d.pays : ['FR'];
  const corps: Record<string, unknown> = {
    accountId: o.accountId,
    adAccountId: d.compte_pub,
    postId: o.postId,
    name: o.nom.slice(0, 100),
    goal: d.objectif,
    budgetAmount: Math.round(Number(d.budget) * 100) / 100,
    budgetType: d.type_budget,
    targeting,
    // Obligatoire pour une pub vue en Europe (DSA) : qui en bénéficie, qui la paie.
    dsaBeneficiary: o.beneficiaire.slice(0, 100),
    dsaPayor: o.beneficiaire.slice(0, 100),
  };
  if (d.debut) corps.startDate = d.debut;
  if (d.fin) corps.endDate = d.fin;
  if (d.objectif === 'traffic') {
    corps.linkUrl = d.lien!.trim();
    corps.callToAction = d.bouton || 'LEARN_MORE';
  }
  return corps;
}

const nombre = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0;

/** Statut lisible : en validation, active, en pause, refusée, terminée. */
export function statutPub(a: Record<string, unknown>): string {
  const brut = String((a.status as string) || '').toLowerCase();
  const revue = String((a.reviewStatus as string) || '').toLowerCase();
  if (
    brut.includes('reject') ||
    revue.includes('reject') ||
    revue.includes('disapprov')
  )
    return 'refusee';
  if (
    brut.includes('review') ||
    brut.includes('pending') ||
    revue.includes('pending') ||
    revue.includes('review')
  )
    return 'validation';
  if (brut.includes('pause')) return 'pause';
  if (
    brut.includes('complet') ||
    brut.includes('cancel') ||
    brut.includes('archiv') ||
    brut.includes('delet')
  )
    return 'terminee';
  if (brut.includes('error')) return 'erreur';
  return brut === 'active' ? 'active' : brut || 'inconnu';
}

/** Pub Zernio -> format écran. */
export function pubDepuisZernio(a: Record<string, unknown>) {
  const m = (a.metrics as Record<string, unknown>) || {};
  const budget = (a.budget as Record<string, unknown>) || null;
  const sched = (a.schedule as Record<string, unknown>) || {};
  const creatif = (a.creative as Record<string, unknown>) || {};
  return {
    id: (a._id as string) || '',
    nom: (a.name as string) || '',
    statut: statutPub(a),
    allumee:
      String((a.configuredStatus as string) || '').toUpperCase() === 'ACTIVE',
    motif_refus: (a.rejectionReason as string) || null,
    objectif: (a.goal as string) || null,
    externe: Boolean(a.isExternal),
    // Zernio relit le budget en budget.daily / budget.lifetime (unités entières de la devise)
    budget: budget
      ? nombre(budget.lifetime) && !nombre(budget.daily)
        ? { montant: nombre(budget.lifetime), type: 'lifetime' }
        : {
            montant: nombre(budget.daily) || nombre(budget.amount),
            type: 'daily',
          }
      : null,
    debut: (sched.startDate as string) || null,
    fin: (sched.endDate as string) || null,
    visuel:
      (creatif.imageUrl as string) || (creatif.thumbnailUrl as string) || null,
    compte_pub: (a.platformAdAccountId as string) || null,
    stats: {
      depense: nombre(m.spend),
      impressions: nombre(m.impressions),
      portee: nombre(m.reach),
      clics: nombre(m.clicks),
      ctr: nombre(m.ctr),
      cpc: nombre(m.cpc),
      resultats: nombre(m.conversions),
      interactions: nombre(m.engagement),
    },
    cree_le: (a.createdAt as string) || (a.platformCreatedAt as string) || null,
  };
}

/** Compte publicitaire Meta -> format écran, avec ce qui bloque la diffusion. */
export function comptePubDepuisZernio(c: Record<string, unknown>) {
  const tz = (c.timezoneName as string) || '';
  const sansCarte =
    String((c.billingStatus as string) || '').toLowerCase() === 'missing';
  const statut = Number(c.accountStatus);
  const alertes: string[] = [];
  if (statut && statut !== 1) alertes.push('compte_bloque');
  if (c.unusableReason) alertes.push('compte_inutilisable');
  if (sansCarte) alertes.push('sans_carte');
  if (tz && !tz.startsWith('Europe/')) alertes.push('fuseau');
  return {
    id: (c.id as string) || '',
    nom: (c.name as string) || '',
    devise: (c.currency as string) || 'EUR',
    fuseau: tz || null,
    budget_min_jour: Math.max(1, Math.ceil(nombre(c.minimumDailyBudget))),
    utilisable:
      c.selectable !== false && !c.unusableReason && (!statut || statut === 1),
    alertes,
  };
}

/** Les identifiants de compte pub arrivent avec ou sans le préfixe « act_ ». */
export const memeComptePub = (a?: string | null, b?: string | null) =>
  Boolean(a && b) && a!.replace(/^act_/, '') === b!.replace(/^act_/, '');
